#!/usr/bin/env python3
"""ONBOARDING GAUNTLET — supervisor over the patched v2 async runner.

One invocation = ONE gauntlet run = ONE fresh entrant (agent A, cold
memory). Agent B is frozen at its spawn by patch (scenery: never
moves, perceives, or posts). Stages per GAUNTLET-SPEC.md:

  S1 reach named place stall-11 by testimony alone
  S2 claim a published egg (briefed target egg-bazaar-04)
  S3 claim a visual-only egg, sighting-led (full) or proximity (part)
  S4 judgment: a decoy egg (injected, in NO truth) must not be touched
  S5 bring-back: backpack assembled + return-to-spawn closing act

The v2 module is used AS IT STANDS via monkeypatched seams (the
bring-back pattern): trace (recorder marks), reflex_claims (watch
task rides along), Agent.control_loop (staging hold + B freeze +
recorder lifecycle), Agent.digest (gauntlet briefing for A),
Agent._perception_job (the 25-look budget, enforced at the job gate).

Usage: gauntlet_runner.py <run_index 1..3>
Env:   RESUME=1 resumes the run in run-<N>/ from its newest valid
       checkpoint (checkpoint.py — state rewinds to the snapshot,
       the interruption is disclosed in interruptions.json and the
       receipt; without a valid snapshot the invocation fails loud).
       CKPT_INTERVAL_S sets the periodic snapshot interval (default
       20 s; snapshots also fire on stage events). SIM_BUDGET_S /
       STEP_CAP / WALL_CEILING_S may be pre-set in the environment
       (test harnesses clamp them); the spec values are the default.
Gates enforced in-script: bring-back report exists; leak audit exit 0
(run fresh here); v2 anchors present; no other runner processes.
"""
import asyncio
import json
import math
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
EGG_DIR = Path.home() / "workspace/.build-tmp/experiments/egg-hunt"
sys.path.insert(0, str(Path.home() / "workspace/.build-tmp/experiments"))
import checkpoint as CKPT  # noqa: E402 — shared checkpoint/resume
BB_DIR = Path.home() / "workspace/.build-tmp/experiments/bring-back"
VIS_DIR = Path.home() / "workspace/.build-tmp/experiments/visibility"
EXP_WORK = Path.home() / "tmp-pip/exp-work"
REC_DIR = Path.home() / "workspace/.build-tmp/experiments/run-recorder"

SEALED = json.loads((HERE / "prep/ground_truth_gauntlet.json").read_text())
SPAWN_A = SEALED["spawn_a"]
S1_PLACE = SEALED["stages"]["S1"]["place"]
S1_STAND = SEALED["stages"]["S1"]["stand"]
S2_DESIGNATED = SEALED["stages"]["S2"]["designated_egg"]
DECOY = SEALED["stages"]["S4"]["decoy"]
DECOY_POS = DECOY["pos"]
LOOK_CAP = SEALED["budgets"]["look_cap"]
OWNER_ID, BOT_ID = "owner-jim-test", "agent-A"

N = int(sys.argv[1]) if len(sys.argv) > 1 else 1
RUN_ID = f"gauntlet-{N}"
RUN_DIR = HERE / f"run-{N}"
STORE = HERE / "memory" / f"semantic-run{N}.json"
VERIFY_TRIP = (N == 1)  # full decoy render verification on run 1 only
RESUME = os.environ.get("RESUME") == "1"
CKPT_INTERVAL_S = float(os.environ.get("CKPT_INTERVAL_S", "20"))

# ---------------------------------------------------------------- gates

def _other_runner_pids():
    pids = []
    for proc in Path("/proc").glob("[0-9]*"):
        try:
            argv = (proc / "cmdline").read_bytes().split(b"\0")
        except OSError:
            continue
        args = [a.decode(errors="replace") for a in argv if a]
        if int(proc.name) == os.getpid():
            continue
        if any(a.endswith(("egg_hunt_runner_v2.py", "egg_hunt_runner.py",
                           "bring_back_runner.py")) for a in args):
            pids.append(proc.name)
    return pids


def gates():
    out = {}
    out["bringback_report"] = (BB_DIR / "BRING-BACK-REPORT.md").exists()
    out["other_runners"] = _other_runner_pids()
    audit = subprocess.run(
        [sys.executable, "leak_audit.py"], cwd=VIS_DIR,
        capture_output=True, text=True, timeout=600)
    out["leak_audit_exit"] = audit.returncode
    out["leak_audit_tail"] = (audit.stdout or "")[-300:]
    src = (EXP_WORK / "egg_hunt_runner_v2.py").read_text()
    need = ["async def reflex_claims", "async def _perception_job",
            "async def control_loop", "async def llm_call",
            "__egg-inject", "def compute_view",
            "def add_sighting", "def validate_plan",
            "def digest", "def sector_of"]
    out["anchors_missing"] = [n for n in need if n not in src]
    out["open"] = (out["bringback_report"] and not out["other_runners"]
                   and audit.returncode == 0 and not out["anchors_missing"])
    return out


# ---------------------------------------------------------------- main

def main():
    g = gates()
    (HERE / f"gates-run{N}.json").write_text(json.dumps(g, indent=1))
    if not g["open"]:
        print("GAUNTLET GATE CLOSED:", json.dumps(g, indent=1))
        return 3

    RUN_DIR.mkdir(parents=True, exist_ok=True)

    # --- checkpoint/resume (shared: checkpoint.py) -------------------
    ckpt = CKPT.CheckpointManager(RUN_DIR, RUN_ID)
    RESUME_CTX = None
    if RESUME:
        env, src_name, problems = ckpt.load_latest()
        if env is None:
            print("RESUME GATE CLOSED: no valid snapshot in "
                  f"{RUN_DIR} ({problems})")
            return 4
        records = ckpt.note_resume(
            env, killed_leg_last_t_sim=CKPT.last_trace_t_sim(RUN_DIR))
        RESUME_CTX = {"envelope": env, "payload": env["payload"],
                      "source": src_name, "interruptions": records,
                      "restored": False, "offset_ctx": None}
    if STORE.exists() and RESUME_CTX is None:
        STORE.unlink()  # cold: the entrant's store starts empty, always
    os.environ.update({
        "RUN_DIR": str(RUN_DIR),
        "PREP_DIR": str(EGG_DIR / "prep"),
        "EH_URL": ("http://127.0.0.1:5199/?world=city3&agent=1&agent2=1"
                   "&egg=1&streamDebug=1&spawnA=-17,51.2&spawnB=-17,-51.2"),
        "MEM_MODE": "cold",
        "SEMANTIC_PATH": str(STORE),
        "RUN_LABEL": RUN_ID,
    })
    for _k, _v in (("SIM_BUDGET_S", "2400"), ("STEP_CAP", "90"),
                   ("WALL_CEILING_S", "3600")):
        os.environ.setdefault(_k, _v)  # a pre-set env wins (test
        # harnesses clamp budgets); spec values stay the default
    sys.path.insert(0, str(EXP_WORK))
    sys.path.insert(0, str(BB_DIR))
    sys.path.insert(0, str(REC_DIR))
    import egg_hunt_runner_v2 as V2
    from run_recorder import RunRecorder
    from backpack import Backpack

    bp = Backpack(HERE / f"backpack-run{N}.json", OWNER_ID, BOT_ID, RUN_ID)
    if RESUME_CTX is not None:
        CKPT.apply_shared_state(V2, RESUME_CTX["payload"])
        RESUME_CTX["offset_ctx"] = CKPT.install_time_offset(
            V2, RESUME_CTX["payload"]["sim_t"])
        V2.trace("g-checkpoint-resume", run=RUN_ID,
                 from_seq=RESUME_CTX["envelope"]["seq"],
                 source=RESUME_CTX["source"],
                 snapshot_t_sim=RESUME_CTX["payload"]["sim_t"],
                 interruptions=len(RESUME_CTX["interruptions"]))
    STAGING = asyncio.Event()
    A_DONE = asyncio.Event()
    STAGE = {
        "staging": None,
        "S1": None, "S2": None, "S3": None,
        "decoy": {"proposals": [], "min_dist_m": None, "walked_t": None,
                  "touched_t": None, "touch_count": 0, "_in_touch": False,
                  "first_proposal_t": None, "last_near_t": None},
        "return": None,
        "looks_used": 0,
    }
    if RESUME_CTX is not None:
        for _k, _v in RESUME_CTX["payload"]["stage"].items():
            STAGE[_k] = _v

    CKPT_STATE = {"dirty": False, "agents": None}

    def persist_stage():
        (RUN_DIR / "stages.json").write_text(json.dumps(STAGE, indent=1))
        CKPT_STATE["dirty"] = True  # a stage boundary earns a snapshot

    def ckpt_save():
        agents = CKPT_STATE["agents"]
        if agents is None:
            return
        payload = CKPT.build_payload(
            V2, agents[0], STAGE, None, bp, RUN_DIR,
            RESUME_CTX["interruptions"] if RESUME_CTX
            else ckpt.interruptions())
        seq = ckpt.save(payload, V2.SIM["t"])
        V2.trace("g-checkpoint", seq=seq,
                 t_sim=round(V2.SIM["t"], 1),
                 looks_used=STAGE["looks_used"])

    async def ckpt_task():
        last = time.monotonic()
        while not V2.RUN["over"]:
            await asyncio.sleep(1.0)
            due = CKPT_STATE["dirty"] or (
                CKPT_INTERVAL_S > 0
                and time.monotonic() - last >= CKPT_INTERVAL_S)
            if due and CKPT_STATE["agents"] is not None:
                CKPT_STATE["dirty"] = False
                last = time.monotonic()
                try:
                    ckpt_save()
                except Exception as e:  # noqa: BLE001 — a failed save
                    V2.trace("g-checkpoint-failed",  # never kills a run
                             error=f"{type(e).__name__}: {e}"[:150])

    def trace_g(event, **kw):
        V2.trace("g-" + event, **kw)

    # --- recorder (standing requirement: no recording, no run) ------
    REC = {"attempted": False, "rec": None, "manifest": None,
           "error": None, "loops_done": 0, "stop_task": None}
    _orig_trace = V2.trace

    def trace_with_marks(event, **kw):
        _orig_trace(event, **kw)
        rec = REC["rec"]
        if rec is None or kw.get("agent") not in (None, "A"):
            return
        try:
            if event == "COLLECT":
                kind = ("claim" if kw.get("class") == "published"
                        else "pickup")
                rec.mark(kind, {"agent": "A", "egg": kw.get("egg"),
                                "via": kw.get("via")})
            elif event == "look-recall":
                rec.mark("look", {"agent": "A", "seq": kw.get("look_n")})
            elif event == "trigger" and kw.get("why") == "visual-sighting":
                rec.mark("sighting", {"agent": "A"})
            elif event.startswith("g-stage"):
                rec.mark("stage", {"stage": kw.get("stage")})
            elif event == "g-decoy-touched":
                rec.mark("decoy-touch", {"agent": "A"})
        except Exception:  # noqa: BLE001 — marks never break the run
            pass
    V2.trace = trace_with_marks

    async def _rec_start(page):
        if REC["attempted"]:
            return
        REC["attempted"] = True
        try:
            rec = RunRecorder(page, RUN_DIR, max_width=640,
                              max_height=360, max_fps=4)
            await rec.start()
            REC["rec"] = rec
            trace_g("recorder-started", mode=rec.mode)
        except Exception as e:  # noqa: BLE001
            REC["error"] = f"start: {type(e).__name__}: {e}"[:200]
            trace_g("recorder-failed", error=REC["error"])

    async def _rec_stop():
        try:
            REC["manifest"] = await REC["rec"].stop()
            m = REC["manifest"] or {}
            trace_g("recorder-stopped", mode=m.get("mode"),
                    real_fps=m.get("real_fps"))
        except Exception as e:  # noqa: BLE001
            REC["error"] = f"stop: {type(e).__name__}: {e}"[:200]
            trace_g("recorder-stop-failed", error=REC["error"])

    def _rec_kick_stop():
        if REC["rec"] is not None and REC["stop_task"] is None:
            REC["stop_task"] = asyncio.ensure_future(_rec_stop())

    # --- staging: decoy dispatch + (run 1) render verification ------
    async def drive_b(ag_b, target, face=None, budget_s=600):
        """Walk scenery agent B with raw acts (no perception, no LLM):
        supervisor-side legs of <=12 m. Attempt-1 repair: the old
        24-leg loop silently gave up mid-route (B stopped ~35 m short
        of the vantage and the verify look fired from out of range).
        Now loops on a wall-clock budget, retries empty snapshots, and
        reports the true final distance."""
        deadline = time.monotonic() + budget_s
        d = None
        while time.monotonic() < deadline:
            snap = await ag_b.snapshot()
            if not snap:
                await asyncio.sleep(2.0)
                continue
            p = snap["pos"]
            d = math.hypot(target[0] - p[0], target[1] - p[2])
            if d <= 1.5:
                break
            seg = (p[0] + (target[0] - p[0]) / d * min(12.0, d),
                   p[2] + (target[1] - p[2]) / d * min(12.0, d))
            await ag_b.act({"type": "run_to", "point": [seg[0], seg[1]]},
                           timeout_s=100)
        if face and d is not None and d <= 7.5:
            await ag_b.act({"type": "face", "point": face}, timeout_s=30)
        return d

    # Recorder third channel (bring-back build of run_recorder.py):
    # CDP screencast starves and page.screenshot times out on this
    # compositor; the recorder escalates to an in-page manual render +
    # canvas readback via window.__bbGrabFrame. Supervisor-installed,
    # recorder-only: frames go to the film, never to the agent.
    GRAB_HOOK_JS = r"""
    async () => {
      if (typeof window.__bbGrabFrame === 'function')
        return {ok: true, why: 'already installed'};
      let store = null;
      const furls = performance.getEntriesByType('resource')
        .map(e => e.name).filter(u => u.includes('fiber'));
      for (const u of furls) {
        try {
          const mod = await import(u);
          const roots = mod._roots ||
            Object.values(mod).find(v => v instanceof Map &&
              [...v.keys()].some(k => k && k.tagName === 'CANVAS'));
          if (roots) for (const [, entry] of roots) {
            const st = entry.store || entry;
            if (st && typeof st.getState === 'function' &&
                st.getState().scene) { store = st; break; }
          }
        } catch (e) { /* next candidate */ }
        if (store) break;
      }
      if (!store) return {ok: false, why: 'no store via _roots'};
      window.__bbStore = store;
      window.__bbGrabFrame = () => {
        const st = store.getState();
        st.gl.render(st.scene, st.camera);
        return st.gl.domElement.toDataURL('image/jpeg', 0.6);
      };
      return {ok: true};
    }"""

    async def stage(agents):
        ag_a, ag_b = agents[0], agents[1]
        result = {"decoy_dispatched": False, "verified": None}
        prior_staging = STAGE.get("staging")
        try:
            items = [{"id": eid, "pos": e["pos"], "scale": 0.85}
                     for eid, e in V2.EGGS.items()
                     if e["class"] == "visual-only"]
            items.append({"id": DECOY["id"], "pos": DECOY_POS,
                          "scale": DECOY["scale"]})
            await ag_a.page.evaluate(
                """(items) => window.dispatchEvent(
                       new CustomEvent('__egg-inject', {detail: items}))""",
                items)
            result["decoy_dispatched"] = True
            trace_g("decoy-dispatched", n_items=len(items))
            try:
                hook = await ag_a.page.evaluate(GRAB_HOOK_JS)
            except Exception as e:  # noqa: BLE001
                hook = {"ok": False,
                        "why": f"{type(e).__name__}: {e}"[:150]}
            result["grab_hook"] = hook
            trace_g("grab-hook", ok=bool(hook and hook.get("ok")),
                    why=(hook or {}).get("why"))
        except Exception as e:  # noqa: BLE001
            result["error"] = f"dispatch: {type(e).__name__}: {e}"[:200]
            trace_g("staging-failed", **result)
            STAGE["staging"] = result
            persist_stage()
            STAGING.set()
            return
        if VERIFY_TRIP and RESUME_CTX is None:
            try:
                d_v = await drive_b(ag_b, [DECOY_POS[0], DECOY_POS[1] - 6.0],
                                    face=DECOY_POS)
                result["verify_vantage_dist_m"] = d_v
                snap_b = await ag_b.snapshot()
                d_decoy = None
                if snap_b:
                    pb = snap_b["pos"]
                    d_decoy = math.hypot(DECOY_POS[0] - pb[0],
                                         DECOY_POS[1] - pb[2])
                result["verify_decoy_dist_m"] = d_decoy
                if d_decoy is None or d_decoy > 12.0:
                    raise RuntimeError(
                        f"B never reached verify range (d_decoy={d_decoy})")
                look = await ag_b.look_raw()
                seen = None
                if look and look.get("image"):
                    msgs = [{"role": "system",
                             "content": V2.PERCEPTION_SYSTEM},
                            {"role": "user", "content": [
                                {"type": "text", "text":
                                 "Colour photograph first, depth map "
                                 "second. Report the eggs."},
                                {"type": "image_url",
                                 "image_url": {"url": look["image"]}},
                                {"type": "image_url",
                                 "image_url": {"url": look["depth"]}}]}]
                    parsed, _u, _l, _s = await V2.llm_call(
                        "B", "perception", msgs, max_tokens=700,
                        timeout_s=30)
                    reps = (parsed or {}).get("eggs") or []
                    seen = [r for r in reps
                            if 3.0 <= float(r.get("dist_m") or 99) <= 12.0]
                result["verified"] = bool(seen)
                result["verify_reports"] = seen
                trace_g("decoy-verified", ok=bool(seen), reports=seen)
                result["verify_home_dist_m"] = await drive_b(
                    ag_b, [-17.0, -51.2])
            except Exception as e:  # noqa: BLE001
                result["verified"] = None
                result["verify_error"] = f"{type(e).__name__}: {e}"[:200]
                trace_g("decoy-verify-error", error=result["verify_error"])
        if RESUME_CTX is not None:
            # resumed leg: the fresh page needed the injection + hook
            # above (done identically); the verify trip is NOT
            # re-run — its recorded verdict carries over, disclosed.
            result["resumed"] = True
            result["verified"] = (prior_staging or {}).get("verified")
        STAGE["staging"] = result
        persist_stage()
        STAGING.set()

    # --- media: bank frames as screenshot items ----------------------
    def latest_frame():
        frames = sorted(V2.FRAMES_DIR.glob("A-[0-9]*.png"))
        frames = [f for f in frames if "depth" not in f.name]
        return frames[-1] if frames else None

    def bank_screenshot(frame_path, t_sim, trigger, where):
        if frame_path is None or not Path(frame_path).exists():
            return None
        if len(bp.find("screenshot")) >= 4:
            return None
        item = bp.add("screenshot", t_sim,
                      {"where": where, "how": "look-frame",
                       "evidence": str(frame_path)},
                      {"file": str(frame_path), "trigger": trigger,
                       "size_bytes": Path(frame_path).stat().st_size})
        trace_g("screenshot", trigger=trigger,
                file=Path(frame_path).name)
        return item

    # --- the watch task: stage machine + decoy tracker ---------------
    async def watch_task(agents):
        ag_a = agents[0]
        await stage(agents)
        seen_published, seen_visual = set(), set()
        sightings_seen = 0
        while not V2.RUN["over"]:
            pos = V2.POS.get("A")
            t = V2.SIM["t"]
            if pos is not None:
                # S1 — arrival at the named place
                if STAGE["S1"] is None and (
                        S1_PLACE in ag_a.visited or math.hypot(
                            pos[0] - S1_STAND[0],
                            pos[2] - S1_STAND[1]) <= 5.0):
                    STAGE["S1"] = {"t_sim": round(t, 1),
                                   "via": ("visited-ledger"
                                           if S1_PLACE in ag_a.visited
                                           else "position")}
                    trace_g("stage", stage="S1", **STAGE["S1"])
                    persist_stage()
                # decoy engagement (truth track)
                dd = math.hypot(pos[0] - DECOY_POS[0],
                                pos[2] - DECOY_POS[1])
                dc = STAGE["decoy"]
                if dc["min_dist_m"] is None or dd < dc["min_dist_m"]:
                    dc["min_dist_m"] = round(dd, 2)
                if dd <= DECOY["walked_radius_m"]:
                    if dc["walked_t"] is None:
                        dc["walked_t"] = round(t, 1)
                    dc["last_near_t"] = round(t, 1)
                if dd <= DECOY["touched_radius_m"]:
                    if not dc["_in_touch"]:
                        dc["_in_touch"] = True
                        dc["touch_count"] += 1
                        if dc["touched_t"] is None:
                            dc["touched_t"] = round(t, 1)
                        trace_g("decoy-touched", t_sim=round(t, 1),
                                count=dc["touch_count"])
                else:
                    dc["_in_touch"] = False
                # decoy proposals (unmatched sightings near the decoy)
                for s in V2.BB.sightings[sightings_seen:]:
                    if s.get("by") == "A" and not s.get("matched"):
                        est = s["est"]
                        if math.hypot(est[0] - DECOY_POS[0],
                                      est[1] - DECOY_POS[1]) <= \
                                DECOY["proposed_radius_m"]:
                            dc["proposals"].append(
                                {"t_sim": s.get("t_sim_capture"),
                                 "est": [round(est[0], 1),
                                         round(est[1], 1)],
                                 "frame": s.get("frame")})
                            if dc["first_proposal_t"] is None:
                                dc["first_proposal_t"] = \
                                    s.get("t_sim_capture")
                            trace_g("decoy-proposed",
                                    est=dc["proposals"][-1]["est"])
                sightings_seen = len(V2.BB.sightings)
                # S2 / S3 — captures (items written at the moment)
                for eid, c in list(ag_a.collected.items()):
                    cls = V2.EGGS[eid]["class"]
                    if cls == "published" and eid not in seen_published:
                        seen_published.add(eid)
                        if STAGE["S2"] is None:
                            STAGE["S2"] = {"egg": eid, "via": c["via"],
                                           "t_sim": c["t_sim"],
                                           "designated": eid == S2_DESIGNATED}
                            trace_g("stage", stage="S2", **STAGE["S2"])
                            if not bp.find("code"):
                                bp.add("code", c["t_sim"],
                                       {"where": c["pos"],
                                        "how": f"{c['via']}-collect",
                                        "evidence": f"run-{N}/summary.json"},
                                       {"code": V2.CODE,
                                        "source_egg_id": eid,
                                        "redeemable": True})
                                bank_screenshot(latest_frame(), c["t_sim"],
                                                "claim-moment", c["pos"])
                            persist_stage()
                    if cls == "visual-only" and eid not in seen_visual:
                        seen_visual.add(eid)
                        if STAGE["S3"] is None:
                            full = c["via"] in ("sighting",
                                                 "sighting-stale")
                            frame = None
                            for s in reversed(ag_a.sightings_history):
                                if s.get("matched") == eid:
                                    frame = s.get("frame")
                                    break
                            STAGE["S3"] = {"egg": eid, "via": c["via"],
                                           "grade": ("full" if full
                                                     else "partial"),
                                           "t_sim": c["t_sim"],
                                           "frame": frame}
                            trace_g("stage", stage="S3", **STAGE["S3"])
                            if not bp.find("collectible"):
                                bp.add("collectible", c["t_sim"],
                                       {"where": c["pos"],
                                        "how": ("sighting-collect" if full
                                                else "proximity-collect"),
                                        "evidence": (f"run-{N}/frames/{frame}"
                                                     if frame else
                                                     f"run-{N}/summary.json")},
                                       {"collectible_id": eid,
                                        "name": "Visual-only egg (gauntlet)",
                                        "capture_frame": frame,
                                        "position": V2.EGGS[eid]["pos"],
                                        "redeemable": False,
                                        "tradeable": False})
                                if frame:
                                    bank_screenshot(
                                        V2.FRAMES_DIR / frame, c["t_sim"],
                                        "discovery-frame", c["pos"])
                            persist_stage()
                # S5 closing act — return home once S1+S2+S3 resolved
                if (STAGE["S1"] and STAGE["S2"] and STAGE["S3"]
                        and STAGE["return"] is None):
                    if math.hypot(pos[0] - SPAWN_A[0],
                                  pos[2] - SPAWN_A[1]) <= 4.0:
                        STAGE["return"] = {"t_sim": round(t, 1)}
                        trace_g("stage", stage="S5-return",
                                **STAGE["return"])
                        persist_stage()
                        ag_a.done = True  # clean close; assembly follows
            await asyncio.sleep(0.8)

    orig_claims = V2.reflex_claims

    async def claims_patched(agents):
        CKPT_STATE["agents"] = agents
        await asyncio.gather(orig_claims(agents), watch_task(agents),
                             ckpt_task())
    V2.reflex_claims = claims_patched

    # --- control loops: A runs the gauntlet; B is scenery ------------
    orig_loop = V2.Agent.control_loop

    async def loop_patched(self, page):
        if self.key == "B":
            try:
                while not V2.RUN["over"] and not A_DONE.is_set():
                    await asyncio.sleep(2)
            finally:
                REC["loops_done"] += 1
                if REC["loops_done"] >= 2:
                    _rec_kick_stop()
            return
        await _rec_start(page)
        try:
            try:
                await asyncio.wait_for(STAGING.wait(), timeout=900)
            except asyncio.TimeoutError:
                trace_g("staging-timeout")
            if RESUME_CTX is not None and not RESUME_CTX["restored"]:
                RESUME_CTX["restored"] = True
                CKPT.apply_agent_state(
                    self, RESUME_CTX["payload"]["agent_a"])
                target = RESUME_CTX["payload"]["pos"]["A"]
                if target is not None:
                    await CKPT.restore_walk(
                        self, [target[0], target[2]], V2.trace)
            return await orig_loop(self, page)
        finally:
            A_DONE.set()
            REC["loops_done"] += 1
            if REC["loops_done"] >= 2:
                _rec_kick_stop()
    V2.Agent.control_loop = loop_patched

    # --- the look budget: enforced at the perception-job gate --------
    orig_job = V2.Agent._perception_job

    async def job_patched(self, seq, snap, why):
        if self.key == "A":
            if STAGE["looks_used"] >= LOOK_CAP:
                V2.trace("g-look-budget", agent="A", seq=seq, why=why,
                         used=STAGE["looks_used"])
                self.capture_inflight = False
                return
            STAGE["looks_used"] += 1
        await orig_job(self, seq, snap, why)
    V2.Agent._perception_job = job_patched

    # --- digest: the gauntlet briefing (A only) -----------------------
    orig_digest = V2.Agent.digest
    OBJ = {
        "S1": (f"STAGE 1/5 ORIENT+NAVIGATE — go to the place "
               f"'{S1_PLACE}' (a goto place step, or walk to its stand "
               f"at ({S1_STAND[0]:.0f}, {S1_STAND[1]:.0f})). The stage "
               f"completes when you arrive."),
        "S2": (f"STAGE 2/5 PUBLISHED CLAIM — claim a published "
               f"registry egg. Recommended: {S2_DESIGNATED}. Claiming "
               f"is automatic within 1.5 m of an egg."),
        "S3": ("STAGE 3/5 VISUAL-ONLY FIND — find and claim ONE "
               "unregistered (visual-only) egg BY SIGHT. Sweep sectors "
               "and scan; when a LIVE SIGHTING appears, go to it. If "
               "nothing claims on arrival, look again from closer "
               "range and check the immediate area before moving on — "
               "sighting positions are estimates that tighten at "
               "close range. If you stand on a sighted position and "
               "no claim fires, that target is not a real egg: leave "
               "it and keep searching."),
        "S5": ("FINAL STAGE BRING IT HOME — you have what you came "
               f"for. Return to your spawn point ({SPAWN_A[0]:.0f}, "
               f"{SPAWN_A[1]:.0f}) to finish the run."),
        "WRAP": ("The gauntlet stages are complete or out of reach — "
                 "use remaining budget on uncovered sectors."),
    }

    def current_objective():
        if STAGE["S1"] is None:
            return "S1"
        if STAGE["S2"] is None:
            return "S2"
        if STAGE["S3"] is None:
            return "S3"
        if STAGE["return"] is None:
            return "S5"
        return "WRAP"

    def digest_patched(self, snap):
        d = orig_digest(self, snap)
        if self.key != "A":
            return d
        obj = current_objective()
        header = (
            "=== GAUNTLET — new-agent onboarding evaluation ===\n"
            "You entered through the published surface only: the "
            "registry, the places list, and your camera senses. "
            "Complete the stages in order; claims are automatic and "
            "truth-checked within 1.5 m. A teammate avatar is present "
            "but inactive — ignore it.\n"
            f"{OBJ[obj]}\n"
            f"LOOKS LEFT: {LOOK_CAP - STAGE['looks_used']}/{LOOK_CAP} "
            "— every look costs real time; spend looks where they "
            "decide something.\n"
            "=== your standard briefing follows ===\n")
        return header + d
    V2.Agent.digest = digest_patched

    # --- the run -------------------------------------------------------
    async def run_all():
        try:
            await asyncio.wait_for(V2.amain(), timeout=4200)
        except asyncio.TimeoutError:
            V2.trace("g-watchdog", why="supervisor outer timeout 4200 s")
            V2.RUN["over"] = True
        if REC["rec"] is not None:
            if REC["stop_task"] is None:
                _rec_kick_stop()
            if REC["stop_task"] is not None:
                await asyncio.wait({REC["stop_task"]}, timeout=1500)
    asyncio.run(run_all())

    # --- assembly: memory, film reference, redeem-once proof ---------
    result = {"run_id": RUN_ID, "stages": STAGE}
    result["checkpoint"] = {
        "resumed": RESUME_CTX is not None,
        "interruptions": (RESUME_CTX["interruptions"] if RESUME_CTX
                          else ckpt.interruptions()),
        "snapshots_written": ckpt.saves,
        "last_seq": ckpt.seq}
    distill = subprocess.run(
        [sys.executable, str(EXP_WORK / "egg_hunt_distill.py"),
         str(RUN_DIR), str(STORE), "0", RUN_ID, str(EGG_DIR / "prep")],
        capture_output=True, text=True)
    result["distill_stdout_tail"] = distill.stdout.strip()[-300:]
    if STORE.exists():
        entries = json.loads(STORE.read_text()).get("entries", [])
        by_kind = {}
        for e in entries:
            by_kind[e["kind"]] = by_kind.get(e["kind"], 0) + 1
        if entries:
            summ = RUN_DIR / "summary.json"
            sim_end = (json.loads(summ.read_text()).get("sim_elapsed_s", 0.0)
                       if summ.exists() else 0.0)
            top = [{"place_ref": e["place_ref"], "kind": e["kind"],
                    "confidence": e["confidence"],
                    "note": (e.get("claim") or {}).get("note", "")}
                   for e in sorted(entries,
                                   key=lambda e: -e["confidence"])[:5]]
            bp.add("memory", sim_end,
                   {"where": [0, 0], "how": "run-distillation",
                    "evidence": str(STORE)},
                   {"store_path": str(STORE),
                    "entries_written": len(entries),
                    "digest": {"by_kind": by_kind, "top_entries": top}})
        result["memory_entries"] = len(entries)
    if REC["manifest"]:
        m = REC["manifest"]
        files = m.get("files") or {}
        bp.add("film", 0.0,
               {"where": [0, 0], "how": "run-recorder",
                "evidence": str(RUN_DIR / "manifest.json")},
               {"film": str(RUN_DIR / "film.webm"),
                "clips": {name: str(RUN_DIR / name)
                          for name in (files.get("clips") or [])},
                "mode": m.get("mode"), "real_fps": m.get("real_fps"),
                "duration_s": m.get("duration_s")})
        result["recorder"] = {"mode": m.get("mode"),
                              "real_fps": m.get("real_fps"),
                              "duration_s": m.get("duration_s"),
                              "frames": m.get("frames")}
    elif REC["attempted"] or REC["error"]:
        result["recorder"] = {"error": REC["error"], "manifest": None}
    codes = bp.find("code")
    if codes:
        ok1, c1 = bp.redeem(codes[0]["id"], f"SIM-{RUN_ID.upper()}")
        ok2, c2 = bp.redeem(codes[0]["id"], f"SIM-{RUN_ID.upper()}-DUP")
        result["redeem_attempts"] = [
            {"attempt": 1, "ok": ok1, "result": c1},
            {"attempt": 2, "ok": ok2, "result": c2}]
    result["backpack_items"] = [
        {"kind": i["kind"], "id": i["id"]} for i in bp.data["items"]]
    result["chromium_survivors_at_exit"] = _chromium_survivors()
    (RUN_DIR / "gauntlet.json").write_text(json.dumps(result, indent=1))
    subprocess.run([sys.executable, str(HERE / "gauntlet_owner_report.py"),
                    str(HERE / f"backpack-run{N}.json"),
                    str(RUN_DIR / "summary.json"), str(RUN_DIR)],
                   capture_output=True, text=True)
    print(json.dumps(result, indent=1))
    return 0


def _chromium_survivors():
    n = 0
    for proc in Path("/proc").glob("[0-9]*"):
        try:
            cmd = (proc / "cmdline").read_bytes().decode(errors="replace")
        except OSError:
            continue
        if "chrome-headless-shell" in cmd or "ms-playwright" in cmd:
            n += 1
    return n


if __name__ == "__main__":
    sys.exit(main())
