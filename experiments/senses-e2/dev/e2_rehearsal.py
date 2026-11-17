#!/usr/bin/env python3
"""SCRIPTED CALIBRATION REHEARSAL for E2 (the body channel gate).

No LLM, zero spend: a deterministic ScriptedBrain drives the REAL
e1._Run body machinery (channels.BodyModel + enforce.py) against
the live dev stack through the scripted test owner, in three modes:

  walk-b2  walk everywhere in arm B2. Gate leg (a): completes with
           ZERO enforcement events and energy never in the zone
           (< 15); also measures leg (c), the mandatory sit's
           recovery, from the logged snapshots.
  run-b2   run everywhere in arm B2, departing the Tea House the
           moment it stands (no pre-rest). Gate leg (b): the
           departure MUST hit enforcement (depleted-lock refusal
           and/or too-depleted downgrade); the script then rests
           until the displayed energy reaches >= 30 and walks home
           — the recovery path must complete the errand.
  run-b1   run everywhere in arm B1. Gate leg (d): completes with
           the model draining to ~0 and ZERO enforcement — the
           numbers are informational only.

The ScriptedBrain decides from the prompt alone (nearest place,
inside/posture lines, the rendered body line's energy, the last
result's status) — the same information the real brain gets.

Prints a JSON evidence object per mode; exit 0 iff every mode's
checks pass. No secrets are printed.
"""
import json
import os
import re
import secrets
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "harness"))
import e1 as e1mod
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


class ScriptedBrain:
    """Deterministic errand pilot for one rehearsal mode."""

    def __init__(self, mode):
        self.mode = mode
        self.calls = 0
        self.run_usage = {"prompt_tokens": 0, "completion_tokens": 0}
        self.run_cost_usd = 0.0
        self.tea_id = None
        self.plaza_id = None
        self.went_out = False
        self.sat = False
        self.depart_tried = False
        self.refusal_seen = False

    def context_pressure(self):
        return 0.0

    def _move(self):
        return "run_to" if self.mode.startswith("run") else "go_to"

    def _depart(self, energy):
        if self.mode == "run-b2" and self.refusal_seen:
            if energy is not None and energy < 30:
                return {"type": "wait", "seconds": 10}
            return {"type": "go_to", "place": self.plaza_id}
        if self.mode == "run-b2" and not self.depart_tried:
            self.depart_tried = True
            return {"type": "run_to", "place": self.plaza_id}
        return {"type": self._move(), "place": self.plaza_id}

    def decide(self, prompt):
        if self.tea_id is None:
            ids = _PLACE_ID_RE.findall(prompt)
            if len(ids) >= 2:
                self.tea_id, self.plaza_id = ids[0], ids[-1]
        m = _ENERGY_RE.search(prompt)
        energy = int(m.group(1)) if m else None
        pm = _POSTURE_RE.search(prompt)
        posture = pm.group(1) if pm else "standing"
        inside = "You are inside:" in prompt
        nm = _NEAREST_RE.search(prompt)
        nearest = nm.group(1) if nm else None
        if '"status": "rejected"' in prompt:
            self.refusal_seen = True
        if not self.went_out:
            self.went_out = True
            return {"type": self._move(), "place": self.tea_id}
        if inside:
            if posture == "seated":
                self.sat = True
                return {"type": "stand"}
            if not self.sat:
                seats = _SEAT_LINE_RE.findall(prompt)
                intent = {"type": "sit"}
                if seats:
                    intent["sittable"] = seats[0]
                return intent
            return self._depart(energy)
        if nearest == self.tea_id and not self.sat:
            return {"type": "enter", "place": self.tea_id}
        if self.sat:
            return self._depart(energy)
        return {"type": self._move(), "place": self.tea_id}

    def turn(self, prompt):
        self.calls += 1
        intent = self.decide(prompt)
        reply = (f"Rehearsal {self.mode} step {self.calls}. "
                 + json.dumps(intent))
        return {"reply": reply, "intent": parse_intent(reply),
                "usage": {"prompt_tokens": 0, "completion_tokens": 0},
                "entry_cost_usd": 0.0}


def run_mode(mode, owner, ledger):
    arm = "B2" if mode.endswith("b2") else "B1"
    run_id = f"e2cal-{mode}-{secrets.token_hex(3)}"
    path = os.path.join(RUNS_DIR, run_id + ".jsonl")
    brain = ScriptedBrain(mode)
    world = WorldAdapter(run_id, base_url=BASE)
    run = e1mod._Run("A0", run_id, path, ledger, brain, world,
                     dev_owner=owner, verbal=True, body_arm=arm)
    footer = run.execute()
    recs = []
    with open(path) as f:
        for line in f:
            if line.strip():
                recs.append(json.loads(line))
    trajectory = []
    for r in recs:
        if r.get("footer"):
            continue
        cs = r.get("channel_state") or {}
        snap = cs.get("body_snapshot") or {}
        trajectory.append({
            "turn": r.get("turn"),
            "intent": (r.get("tool_call") or {}).get("type"),
            "executed": cs.get("body_executed_type"),
            "energy": snap.get("energy"),
            "strain": snap.get("strain"),
            "act_seconds": cs.get("body_act_seconds"),
            "enforcement": [e.get("kind")
                            for e in cs.get("body_enforcement", [])],
            "status": r.get("tool_result_status"),
        })
    enf = footer.get("body_enforcement") or {}
    ev = {"mode": mode, "arm": arm, "run_id": run_id,
          "outcome": footer.get("outcome"),
          "reason": footer.get("reason"),
          "turns": footer.get("turns"),
          "wall_seconds": footer.get("wall_seconds"),
          "body_min_energy": footer.get("body_min_energy"),
          "body_final": footer.get("body_final"),
          "enforcement": enf,
          "first_refusal_turn": footer.get("first_refusal_turn"),
          "trajectory": trajectory}
    if mode == "walk-b2":
        snaps = [t["energy"] for t in trajectory
                 if t["energy"] is not None]
        # Leg (c): the seated window sits between the sit-decision
        # turn's snapshot and the return-decision turn's snapshot.
        sit_idx = next((i for i, t in enumerate(trajectory)
                        if t["intent"] == "sit"), None)
        ret_idx = next((i for i, t in enumerate(trajectory)
                        if t["intent"] == "go_to"
                        and i > (sit_idx or 0)), None)
        if sit_idx is not None and ret_idx is not None:
            ev["sit_recovery"] = round(snaps[ret_idx] - snaps[sit_idx], 1)
        ev["checks"] = {
            "completed": footer.get("outcome") == "completed",
            "zero_enforcement": sum(enf.values()) == 0,
            "min_energy_above_zone": (footer.get("body_min_energy")
                                      or 0) > 15,
            "sit_recovery_meaningful": ev.get("sit_recovery", 0) >= 10,
        }
    elif mode == "run-b2":
        min_e = footer.get("body_min_energy")
        ev["checks"] = {
            "completed": footer.get("outcome") == "completed",
            "enforcement_fired": sum(enf.values()) >= 1,
            "battery_hit_the_zone": (min_e if min_e is not None
                                     else 100) <= 14,
            "recovered_and_completed": bool(
                footer.get("first_refusal_turn") is not None
                or enf.get("downgrade", 0) >= 1)
                and footer.get("outcome") == "completed",
        }
    elif mode == "run-b1":
        min_e = footer.get("body_min_energy")
        ev["checks"] = {
            "completed": footer.get("outcome") == "completed",
            "zero_enforcement": sum(enf.values()) == 0,
            "drained_to_near_zero": (min_e if min_e is not None
                                     else 100) <= 5,
        }
    ev["verdict"] = all(ev["checks"].values())
    return ev


def main():
    ledger = SpendLedger()
    spent_before = ledger.spent()
    owner = DevOwner(BASE)
    owner.ensure_owner()
    out = {"base": BASE, "modes": {}}
    ok = True
    for mode in ("walk-b2", "run-b2", "run-b1"):
        ev = run_mode(mode, owner, ledger)
        out["modes"][mode] = ev
        ok = ok and ev["verdict"]
    out["spend_delta_usd"] = round(ledger.spent() - spent_before, 6)
    out["verdict"] = ok and out["spend_delta_usd"] == 0
    print(json.dumps(out, indent=1, default=str))
    return 0 if out["verdict"] else 1


if __name__ == "__main__":
    sys.exit(main())
