#!/usr/bin/env python3
"""SCRIPTED CALIBRATION REHEARSAL for E2-forced (the design gate).

No LLM, zero spend: deterministic ScriptedBrains drive the REAL
e1._Run machinery (retuned BodyModel rates + enforce.py) against
the live dev stack through the scripted test owner, on the real
chained route (spawn -> Tea House sit -> Kronikler Press ->
stall-40) at the real deadline (276 s):

  walk-b2    gate (a)+(e): walking FAILS on the deadline with
             energy never in the enforcement zone and ZERO
             enforcement — the two failure modes stay distinct.
  runall-b1  gate (c): running everywhere completes with the
             information-only arm — the fast path exists.
  runall-b2  gate (b): running everywhere hits enforcement
             (downgrade and/or refusal); it may complete only by
             being forced onto a walk, or fail outright.
  mixed-b2   gate (d): run the legs, recharge seated at the tea
             house to the displayed target, run on — completes
             with ZERO enforcement and energy margin.
  mixed-b1   the same strategy with information only (control).
  walk-b0    gate (a) in the hidden arm: fails on time.

The brains decide from the prompt alone (nearest place, inside/
posture lines, the rendered body line's energy, the last result's
status) — the same information the real brain gets. The enter
branch each run drew is read off the enter act's duration
(>= 100 s = the timeout settle, body inside either way).

Usage: python3 dev/e2f_rehearsal.py [mode ...]   (default: all)
Prints one JSON evidence object; exit 0 iff every run's checks
pass. No secrets are printed.
"""
import json
import os
import re
import secrets
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "harness"))
import e1 as e1mod
import e2f as e2fmod
from brain import parse_intent
from devowner import DevOwner
from ledger import SpendLedger
from world import WorldAdapter

BASE = os.environ.get("AIVERSE_GATEWAY_BASE", "http://localhost:3100")
RUNS_DIR = e1mod.RUNS_DIR

_ENERGY_RE = re.compile(r"body: energy (\d+)")
_POSTURE_RE = re.compile(r"posture (\w+)")
_NEAREST_RE = re.compile(r'Nearest place: .*\(id "([^"]+)"')
_SEAT_LINE_RE = re.compile(r'- seat "([^"]+)".*state free')
_PLACE_ID_RE = re.compile(r'place id "([^"]+)"')

ALL_MODES = ("walk-b2", "runall-b1", "runall-b2", "mixed-b2",
             "mixed-b1", "walk-b0")


class ScriptedBrain:
    """Deterministic chained-errand pilot for one rehearsal mode."""

    def __init__(self, mode):
        self.mode = mode
        self.strategy = mode.split("-")[0]      # walk | runall | mixed
        self.calls = 0
        self.run_usage = {"prompt_tokens": 0, "completion_tokens": 0}
        self.run_cost_usd = 0.0
        self.tea_id = None
        self.stop2_id = None
        self.plaza_id = None
        self.went_out = False
        self.sat = False
        self.refused = False

    def context_pressure(self):
        return 0.0

    def _speed(self):
        return "go_to" if self.strategy == "walk" else "run_to"

    def _move(self, place, energy):
        # Refusal recovery (any strategy): rest in 10 s chunks
        # until the displayed energy reaches the release floor,
        # then WALK the leg.
        if self.refused:
            if energy is not None and energy < 30:
                return {"type": "wait", "seconds": 10}
            return {"type": "go_to", "place": place}
        return {"type": self._speed(), "place": place}

    def decide(self, prompt):
        if self.tea_id is None:
            ids = _PLACE_ID_RE.findall(prompt)
            if len(ids) >= 3:
                self.tea_id, self.stop2_id, self.plaza_id = \
                    ids[0], ids[1], ids[-1]
        m = _ENERGY_RE.search(prompt)
        energy = int(m.group(1)) if m else None
        pm = _POSTURE_RE.search(prompt)
        posture = pm.group(1) if pm else "standing"
        inside = "You are inside:" in prompt
        nm = _NEAREST_RE.search(prompt)
        nearest = nm.group(1) if nm else None
        if '"status": "rejected"' in prompt:
            self.refused = True
        if not self.went_out:
            self.went_out = True
            return self._move(self.tea_id, energy)
        if inside:
            if posture == "seated":
                self.sat = True
                if self.strategy == "mixed" and not self.refused:
                    # The sit-recharge: wait seated in 5 s chunks
                    # while the DISPLAYED energy is below target.
                    if energy is None or \
                            energy < e2fmod.RECHARGE_TARGET:
                        return {"type": "wait", "seconds": 5}
                return {"type": "stand"}
            if not self.sat:
                seats = _SEAT_LINE_RE.findall(prompt)
                intent = {"type": "sit"}
                if seats:
                    intent["sittable"] = seats[0]
                return intent
            # Standing inside, sat done: depart for stop 2.
            return self._move(self.stop2_id, energy)
        if nearest == self.tea_id and not self.sat:
            return {"type": "enter", "place": self.tea_id}
        if self.sat and nearest == self.stop2_id:
            return self._move(self.plaza_id, energy)
        if self.sat:
            return self._move(self.stop2_id, energy)
        return self._move(self.tea_id, energy)

    def turn(self, prompt):
        self.calls += 1
        intent = self.decide(prompt)
        reply = (f"Rehearsal {self.mode} step {self.calls}. "
                 + json.dumps(intent))
        return {"reply": reply, "intent": parse_intent(reply),
                "usage": {"prompt_tokens": 0, "completion_tokens": 0},
                "entry_cost_usd": 0.0}


def run_mode(mode, owner, ledger):
    strategy, arm = mode.split("-")
    arm = arm.upper()
    run_id = f"e2fcal-{mode}-{secrets.token_hex(3)}"
    path = os.path.join(RUNS_DIR, run_id + ".jsonl")
    brain = ScriptedBrain(mode)
    world = WorldAdapter(run_id, base_url=BASE)
    run = e1mod._Run("A0", run_id, path, ledger, brain, world,
                     dev_owner=owner, verbal=True, body_arm=arm,
                     deadline_s=e2fmod.DEADLINE_S,
                     stop2_id=e2fmod.STOP2_ID,
                     body_rates=e2fmod.BODY_RATES)
    footer = run.execute()
    recs = []
    with open(path) as f:
        for line in f:
            if line.strip():
                recs.append(json.loads(line))
    trajectory = []
    enter_seconds = None
    for r in recs:
        if r.get("footer"):
            continue
        cs = r.get("channel_state") or {}
        snap = cs.get("body_snapshot") or {}
        call = r.get("tool_call") or {}
        if call.get("type") == "enter":
            enter_seconds = cs.get("body_act_seconds")
        trajectory.append({
            "turn": r.get("turn"),
            "intent": call.get("type"),
            "executed": cs.get("body_executed_type"),
            "energy": snap.get("energy"),
            "strain": snap.get("strain"),
            "act_seconds": cs.get("body_act_seconds"),
            "enforcement": [e.get("kind")
                            for e in cs.get("body_enforcement", [])],
            "status": r.get("tool_result_status"),
        })
    enf = footer.get("body_enforcement") or {}
    enf_total = sum(enf.values())
    min_e = footer.get("body_min_energy")
    branch = None
    if enter_seconds is not None:
        branch = "timeout" if enter_seconds >= 100 else "fast"
    ev = {"mode": mode, "arm": arm, "run_id": run_id,
          "outcome": footer.get("outcome"),
          "reason": footer.get("reason"),
          "turns": footer.get("turns"),
          "wall_seconds": footer.get("wall_seconds"),
          "enter_seconds": enter_seconds,
          "enter_branch": branch,
          "sat_done_turn": footer.get("sat_done_turn"),
          "stop2_done_turn": footer.get("stop2_done_turn"),
          "body_min_energy": min_e,
          "body_final": footer.get("body_final"),
          "enforcement": enf,
          "first_refusal_turn": footer.get("first_refusal_turn"),
          "trajectory": trajectory}
    if strategy == "walk":
        ev["checks"] = {
            "fails_on_deadline": footer.get("outcome")
            == "failed_deadline",
            "zero_enforcement": enf_total == 0,
            "min_energy_above_zone": (min_e or 0) >= 15,
        }
    elif strategy == "runall" and arm == "B1":
        ev["checks"] = {
            "completed": footer.get("outcome") == "completed",
            "zero_enforcement": enf_total == 0,
        }
    elif strategy == "runall" and arm == "B2":
        ev["checks"] = {
            "enforcement_fired": enf_total >= 1,
            "did_not_blast_through": footer.get("outcome")
            != "completed" or enf.get("downgrade", 0) >= 1,
        }
    elif strategy == "mixed":
        ev["checks"] = {
            "completed": footer.get("outcome") == "completed",
            "zero_enforcement": enf_total == 0,
            "energy_margin": (min_e or 0) >= 5,
        }
    ev["verdict"] = all(ev["checks"].values())
    return ev


def main(argv):
    modes = argv or list(ALL_MODES)
    ledger = SpendLedger()
    spent_before = ledger.spent()
    owner = DevOwner(BASE)
    owner.ensure_owner()
    out = {"base": BASE, "deadline_s": e2fmod.DEADLINE_S,
           "stop2_id": e2fmod.STOP2_ID, "body_rates": e2fmod.BODY_RATES,
           "design_check": e2fmod.check_design()["conditions"],
           "modes": {}}
    ok = True
    for mode in modes:
        ev = run_mode(mode, owner, ledger)
        out["modes"][mode] = ev
        ok = ok and ev["verdict"]
        print(f"[{mode}] outcome={ev['outcome']} "
              f"wall={ev['wall_seconds']} branch={ev['enter_branch']} "
              f"minE={ev['body_min_energy']} enf={ev['enforcement']} "
              f"verdict={ev['verdict']}", file=sys.stderr, flush=True)
    out["spend_delta_usd"] = round(ledger.spent() - spent_before, 6)
    out["verdict"] = ok and out["spend_delta_usd"] == 0
    dest = os.path.join(RUNS_DIR, "e2f-rehearsal.json")
    with open(dest, "w") as f:
        json.dump(out, f, indent=1)
    print(f"evidence -> {dest}; overall verdict={out['verdict']}",
          file=sys.stderr)
    print(json.dumps({m: {"outcome": e["outcome"],
                          "wall_seconds": e["wall_seconds"],
                          "enter_branch": e["enter_branch"],
                          "body_min_energy": e["body_min_energy"],
                          "enforcement": e["enforcement"],
                          "checks": e["checks"],
                          "verdict": e["verdict"]}
                      for m, e in out["modes"].items()}, indent=1))
    return 0 if out["verdict"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
