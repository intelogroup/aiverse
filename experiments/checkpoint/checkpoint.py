#!/usr/bin/env python3
"""CHECKPOINT / RESUME — shared supervisor infrastructure for the verse
experiment runner lineage (gauntlet supervisor + drive supervisor).

Built 2026-11-09 at Jim's go, after the host ate gauntlet run-2
attempt-2 (~9 min in, VM reboot) and REPORT-v2's Run B before it: a
run whose state lives only in a supervisor's memory is a run the host
can delete. This module is the ONE implementation both supervisors
wire in — snapshot envelope, atomic writes, integrity, restore, and
the interruption record. Supervisors only describe their state
(STAGE, backpack) and call the seams here.

Design rules (the honesty discipline of this rig family):

- ATOMIC + VERIFIED. A snapshot is written to a tmp file and renamed
  over `checkpoint.json`; the previous newest rotates to
  `checkpoint.prev.json`. Every envelope carries a sha256 over its
  canonical content. Load verifies: a torn or corrupt newest falls
  back to the previous good one; garbage is NEVER loaded (load
  returns None / raises only when resume was explicitly requested
  and nothing valid exists — the supervisor fails loud there).
- DISCLOSED, NEVER SILENT. A snapshot records sim time, wall time,
  and byte offsets of the append-only artifacts (trace / truth / llm
  / drives). A resume APPENDS an interruption record to
  `interruptions.json` in the run dir *before* the run restarts, so
  the disclosure survives even a second kill, and the record is
  carried inside every later snapshot and into the run receipt.
  Resumed runs are labeled resumed everywhere.
- SIM TIME IS CONTINUOUS, WALL TIME IS NOT. The page restarts its
  sim clock on reload; the snapshot's t_sim is the run's truth.
  `install_time_offset` wraps Agent.snapshot/act so every sim
  timestamp the runner sees is (page t + offset), with the offset
  fixed at the first snapshot of the resumed process:
  offset = snapshot_t_sim - page_t_then. Wall gaps are recorded in
  the interruption record, never hidden.
- STATE REWINDS TO THE SNAPSHOT — AND SAYS SO. Activity between the
  last snapshot and the kill (bounded by the snapshot interval) is
  rolled back: the agent is restored at the saved pose (a
  supervisor-driven walk on raw acts, drive metering suspended so
  the body never pays twice for the same ground), with budgets,
  stage state, blackboard and drive levels exactly as snapshotted.
  The append-only logs keep the dead leg's rows; the seam is marked
  in trace (`g-checkpoint-resume`) and in drives.jsonl
  (`checkpoint-restore` rows), and scorers are told to resolve the
  rewound interval by file order (see score_drive.py).
- NON-INTERFERENCE. With no snapshot present and RESUME unset, the
  supervisors behave exactly as before this module existed; saving
  is additive (one file in the run dir + one trace row per save).

Payload (schema 1), built by build_payload():
  stage          — the supervisor's STAGE dict (verbatim)
  agent_a        — agent A's restorable fields (see AGENT_FIELDS)
  blackboard     — BB.sightings / BB.intentions / BB.claims
  call_stats     — the v2 CALL_STATS counters
  pos            — {"A": [x,y,z], "B": [x,y,z]} truth poses
  sim_t          — V2.SIM["t"] at save time
  drive          — DriveState fields, or None when drives are off
  artifacts      — byte sizes of the append-only logs + backpack
                   reference (path, item count, sha256)
  interruptions  — the run's interruption records so far
"""
import hashlib
import json
import math
import time
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = 1
CKPT_NAME = "checkpoint.json"
PREV_NAME = "checkpoint.prev.json"
INTERRUPTIONS_NAME = "interruptions.json"

# Agent fields that fully determine the entrant's in-run mind. NOT
# included (and why): page/api (live handles), move_task (transient),
# capture_inflight + last_capture_start (wall-clock transients; a
# resumed process starts with no capture in flight and the capture
# gap measured from 0), done (a snapshotted run was, by construction,
# not done).
AGENT_FIELDS = (
    "plan", "intention", "steps", "deliberations",
    "delib_prompt_tokens", "delib_completion_tokens",
    "looks_fired", "looks_completed", "look_seq",
    "capture_ms_list", "api_ms_list",
    "collected", "visited", "sectors", "sightings_history",
    "no_progress", "blocked_count", "trigger",
    "last_sector", "re_search_m", "_last_sample_pos",
)


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                      default=str)


def _frozen(obj):
    """Deep-copy through JSON: tuples become lists, and anything not
    JSON-safe raises HERE, at save time — never silently later."""
    return json.loads(json.dumps(obj, default=str))


def _sha256_file(path):
    try:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()
    except OSError:
        return None


# ---------------------------------------------------------------------------
# The manager: envelope, atomic save, verified load, interruption record

class CheckpointManager:
    def __init__(self, run_dir, run_id):
        self.run_dir = Path(run_dir)
        self.run_id = run_id
        self.seq = 0
        self.saves = 0

    # -- save ---------------------------------------------------------

    def save(self, payload, t_sim):
        self.seq += 1
        body = {"schema": SCHEMA, "run_id": self.run_id,
                "seq": self.seq, "t_sim": t_sim,
                "written_wall_epoch": time.time(),
                "written_wall_iso": _now_iso(),
                "payload": payload}
        envelope = dict(body)
        envelope["sha256"] = hashlib.sha256(
            _canonical(body).encode()).hexdigest()
        text = json.dumps(envelope, indent=1, default=str)
        tmp = self.run_dir / f".checkpoint.json.tmp"
        tmp.write_text(text)
        with open(tmp, "r+b") as f:  # flush to disk before the rename
            f.flush()
            import os
            os.fsync(f.fileno())
        newest = self.run_dir / CKPT_NAME
        prev = self.run_dir / PREV_NAME
        if newest.exists():
            import os
            os.replace(newest, prev)
        import os
        os.replace(tmp, newest)
        self.saves += 1
        return self.seq

    # -- load -----------------------------------------------------------

    @staticmethod
    def _verify(path):
        """(envelope, None) if valid, else (None, reason)."""
        try:
            env = json.loads(Path(path).read_text())
        except Exception as e:  # noqa: BLE001 — any garbage is a reason
            return None, f"unreadable: {type(e).__name__}: {e}"[:120]
        if env.get("schema") != SCHEMA:
            return None, f"schema {env.get('schema')!r} != {SCHEMA}"
        body = {k: env.get(k) for k in
                ("schema", "run_id", "seq", "t_sim",
                 "written_wall_epoch", "written_wall_iso", "payload")}
        want = hashlib.sha256(_canonical(body).encode()).hexdigest()
        if env.get("sha256") != want:
            return None, "sha256 mismatch (torn or tampered)"
        return env, None

    def load_latest(self):
        """Newest VALID snapshot: (envelope, source_name, problems).
        Falls back from checkpoint.json to checkpoint.prev.json.
        (None, None, problems) when nothing valid exists."""
        problems = []
        for name in (CKPT_NAME, PREV_NAME):
            p = self.run_dir / name
            if not p.exists():
                problems.append(f"{name}: absent")
                continue
            env, why = self._verify(p)
            if env is not None:
                if env["run_id"] != self.run_id:
                    problems.append(
                        f"{name}: run_id {env['run_id']!r} != "
                        f"{self.run_id!r}")
                    continue
                self.seq = env["seq"]
                return env, name, problems
            problems.append(f"{name}: {why}")
        return None, None, problems

    # -- the interruption record ----------------------------------------

    def interruptions(self):
        p = self.run_dir / INTERRUPTIONS_NAME
        if p.exists():
            try:
                return json.loads(p.read_text())
            except Exception:  # noqa: BLE001
                return []
        return []

    def note_resume(self, envelope, killed_leg_last_t_sim=None):
        """Append + persist the disclosure for THIS resume. Written
        before the run restarts, so a second kill cannot erase it."""
        records = self.interruptions()
        rec = {
            "resumed_from_seq": envelope["seq"],
            "snapshot_t_sim": envelope["t_sim"],
            "snapshot_written_wall_iso": envelope["written_wall_iso"],
            "resumed_wall_iso": _now_iso(),
            "gap_wall_s": round(
                time.time() - envelope["written_wall_epoch"], 1),
            "killed_leg_last_t_sim": killed_leg_last_t_sim,
            "rewound_sim_s": (None if killed_leg_last_t_sim is None
                              else round(killed_leg_last_t_sim
                                         - envelope["t_sim"], 2)),
        }
        records.append(rec)
        tmp = self.run_dir / ".interruptions.json.tmp"
        tmp.write_text(json.dumps(records, indent=1))
        import os
        os.replace(tmp, self.run_dir / INTERRUPTIONS_NAME)
        return records


def last_trace_t_sim(run_dir):
    """The dead leg's last sim timestamp: max t_sim in trace.jsonl
    (rows carry it only sometimes) — falls back to truth.jsonl's last
    row, the sampler's own clock. None when neither exists."""
    tf = Path(run_dir) / "truth.jsonl"
    if tf.exists():
        try:
            lines = tf.read_text().splitlines()
            for line in reversed(lines):
                if line.strip():
                    return float(json.loads(line)["t_sim"])
        except Exception:  # noqa: BLE001
            pass
    xf = Path(run_dir) / "trace.jsonl"
    if xf.exists():
        best = None
        try:
            for line in xf.read_text().splitlines():
                r = json.loads(line)
                t = r.get("t_sim")
                if isinstance(t, (int, float)):
                    best = t if best is None else max(best, t)
        except Exception:  # noqa: BLE001
            pass
        return best
    return None


# ---------------------------------------------------------------------------
# Payload build / restore — the v2 module is passed in (never imported
# here: import order and env belong to the supervisor).

def build_payload(V2, agent_a, stage, drive, backpack, run_dir,
                  interruptions):
    run_dir = Path(run_dir)
    agent = {}
    for f in AGENT_FIELDS:
        agent[f] = _frozen(getattr(agent_a, f))
    artifacts = {}
    for name in ("trace.jsonl", "truth.jsonl", "llm.jsonl",
                 "drives.jsonl"):
        p = run_dir / name
        artifacts[name] = (p.stat().st_size if p.exists() else None)
    artifacts["backpack"] = {
        "path": str(backpack.path),
        "items": len(backpack.data["items"]),
        "sha256": _sha256_file(backpack.path),
    }
    sp = V2.SEMANTIC_PATH
    artifacts["semantic_store"] = {
        "path": str(sp), "exists": Path(sp).exists(),
        "sha256": _sha256_file(sp) if Path(sp).exists() else None}
    payload = {
        "stage": _frozen(stage),
        "agent_a": agent,
        "blackboard": _frozen({
            "sightings": V2.BB.sightings,
            "intentions": V2.BB.intentions,
            "claims": V2.BB.claims}),
        "call_stats": _frozen({
            "count": V2.CALL_STATS["count"],
            "by_kind": V2.CALL_STATS["by_kind"],
            "failures": V2.CALL_STATS["failures"],
            "latencies_s": V2.CALL_STATS["latencies_s"],
            "by_kind_latency": V2.CALL_STATS["by_kind_latency"]}),
        "pos": {"A": list(V2.POS["A"]) if V2.POS["A"] else None,
                "B": list(V2.POS["B"]) if V2.POS["B"] else None},
        "sim_t": V2.SIM["t"],
        "drive": drive_state_dict(drive) if drive is not None else None,
        "artifacts": artifacts,
        "interruptions": interruptions,
    }
    return payload


def apply_shared_state(V2, payload):
    """Restore the module-level state that exists before any agent
    does: blackboard + call stats. (SIM/POS repopulate from the live
    page within one sampler tick, under the time offset.)"""
    bb = payload["blackboard"]
    V2.BB.sightings = [dict(s) for s in bb["sightings"]]
    V2.BB.intentions = dict(bb["intentions"])
    V2.BB.claims = {k: dict(v) for k, v in bb["claims"].items()}
    cs = payload["call_stats"]
    V2.CALL_STATS["count"] = cs["count"]
    V2.CALL_STATS["by_kind"] = dict(cs["by_kind"])
    V2.CALL_STATS["failures"] = cs["failures"]
    V2.CALL_STATS["latencies_s"] = list(cs["latencies_s"])
    V2.CALL_STATS["by_kind_latency"] = {
        k: list(v) for k, v in cs["by_kind_latency"].items()}


def apply_agent_state(agent, agent_payload):
    for f in AGENT_FIELDS:
        if f in agent_payload:
            setattr(agent, f, agent_payload[f])
    agent.capture_inflight = False
    agent.last_capture_start = 0.0
    agent.done = False


# ---------------------------------------------------------------------------
# Drive state snapshot / restore (duck-typed over drive_layer.DriveState)

def drive_state_dict(drive):
    return {
        "condition": drive.condition,
        "temperament": drive.temperament,
        "energy": drive.energy,
        "perception": drive.perception,
        "total_distance_m": drive.total_distance_m,
        "last_pos": (list(drive._last_pos)
                     if drive._last_pos is not None else None),
        "t_anchor": drive._t_anchor,
        "next_regen_t": drive._next_regen_t,
        "limp": drive._limp,
        "looks_fired": drive.looks_fired,
        "looks_refused": drive.looks_refused,
        "rest_steps": drive.rest_steps,
        "rest_refusals": drive.rest_refusals,
        "limp_refusals": drive.limp_refusals,
        "events_len": len(drive.events),
    }


def apply_drive_state(drive, d, t_sim, log_path=None):
    """Rewind a freshly constructed DriveState to the snapshot. The
    event list is re-read from drives.jsonl (the file is the record);
    two `checkpoint-restore` seam rows are then appended through the
    state's own log so any later reader of the log can see exactly
    where the rewind happened and what levels it restored to."""
    drive.energy = float(d["energy"])
    drive.perception = int(d["perception"])
    drive.total_distance_m = float(d["total_distance_m"])
    drive._last_pos = (list(d["last_pos"])
                       if d["last_pos"] is not None else None)
    drive._t_anchor = d["t_anchor"]
    drive._next_regen_t = d["next_regen_t"]
    drive._limp = bool(d["limp"])
    drive.looks_fired = int(d["looks_fired"])
    drive.looks_refused = int(d["looks_refused"])
    drive.rest_steps = int(d["rest_steps"])
    drive.rest_refusals = int(d["rest_refusals"])
    drive.limp_refusals = int(d["limp_refusals"])
    if log_path is not None and Path(log_path).exists():
        rows = []
        for line in Path(log_path).read_text().splitlines():
            if line.strip():
                try:
                    rows.append(json.loads(line))
                except Exception:  # noqa: BLE001 — a torn tail row
                    pass                # is the kill's signature; skip
        drive.events = rows
    drive._log(t_sim, "energy", 0, "checkpoint-restore", drive.energy)
    drive._log(t_sim, "perception", 0, "checkpoint-restore",
               drive.perception)


# ---------------------------------------------------------------------------
# Sim-time continuity: page t + offset == the run's continuous t_sim

def install_time_offset(V2, target_t_sim):
    """Wrap Agent.snapshot / Agent.act so every sim timestamp the
    runner sees is offset into the snapshotted run's clock. The
    offset is fixed lazily at the first snapshot that carries a `t`:
    offset = target_t_sim - page_t. Returns the shared ctx dict
    ({"offset": float|None}) so the supervisor can trace it once
    known. Idempotent per process by construction (installed once,
    only in a resume invocation)."""
    ctx = {"offset": None}
    orig_snapshot = V2.Agent.snapshot
    orig_act = V2.Agent.act

    def _shift(snap):
        if isinstance(snap, dict) and isinstance(snap.get("t"),
                                                 (int, float)):
            if ctx["offset"] is None:
                ctx["offset"] = float(target_t_sim) - float(snap["t"])
            snap = dict(snap)
            snap["t"] = snap["t"] + ctx["offset"]
        return snap

    async def snapshot_patched(self):
        return _shift(await orig_snapshot(self))

    async def act_patched(self, action, timeout_s=100):
        result = await orig_act(self, action, timeout_s=timeout_s)
        if isinstance(result, dict) and result.get("snapshot"):
            result = dict(result)
            result["snapshot"] = _shift(result["snapshot"])
        return result

    V2.Agent.snapshot = snapshot_patched
    V2.Agent.act = act_patched
    return ctx


# ---------------------------------------------------------------------------
# The restore walk: supervisor-driven, raw acts (the drive_b pattern)

async def restore_walk(agent, target_pos, trace, budget_s=600,
                       arrive_m=1.2):
    """Walk `agent` from wherever the fresh page spawned it to the
    snapshotted pose, in <=12 m raw-act segments. This is NOT agent
    behavior: no plan steps are consumed, no perception fires, and
    (drive runs) the caller suspends drive metering around the call
    so the body never pays for the same ground twice. Returns the
    final distance to the target, or None if no snapshot was ever
    readable."""
    import asyncio
    import time as _time
    deadline = _time.monotonic() + budget_s
    d = None
    while _time.monotonic() < deadline:
        snap = await agent.snapshot()
        if not snap:
            await asyncio.sleep(2.0)
            continue
        p = snap["pos"]
        d = math.hypot(target_pos[0] - p[0], target_pos[1] - p[2])
        if d <= arrive_m:
            break
        seg = (p[0] + (target_pos[0] - p[0]) / d * min(12.0, d),
               p[2] + (target_pos[1] - p[2]) / d * min(12.0, d))
        await agent.act({"type": "run_to", "point": [seg[0], seg[1]]},
                        timeout_s=100)
    trace("g-restore-walk", agent=agent.key,
          to=[round(target_pos[0], 1), round(target_pos[1], 1)],
          final_dist_m=(None if d is None else round(d, 2)))
    return d
