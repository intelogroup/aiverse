#!/usr/bin/env python3
"""SCRIPTED REHEARSAL for the tamper-discrimination test. No paid
brain, zero spend: for each arm, run harness/tamper.py's real run
loop with a scripted brain (wait x4, look, stand, wait x6) against
the live dev stack and assert the manipulation actually holds
against the real sim:

  veridical:     the silent sit seats the body on the selected seat;
                 the channel reports seated from turn 4 until the
                 scripted stand (turn 6) stands it back up.
  feed_lie:      no world act at the event; the real body stands all
                 12 turns; the channel reports seated from turn 4;
                 the selected seat stays 'free' in the scene.
  silent_change: the silent sit seats the body; the scene marks the
                 seat 'yours' and the position shifts at turn 4,
                 while the BODY SENSE line stays byte-identical for
                 all 12 turns and the position line's posture token
                 never leaves 'standing'.

Prints a JSON evidence object; exit 0 iff every check passes.
No secrets are printed (ids/names/counts only).
"""
import json
import os
import secrets
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "harness"))
import tamper
from brain import parse_intent
from devowner import DevOwner
from ledger import SpendLedger
from world import WorldAdapter

BASE = os.environ.get("AIVERSE_GATEWAY_BASE", "http://localhost:3100")
SCRIPT = (['{"type":"wait","seconds":1}'] * 4 +
          ['{"type":"look"}'] +
          ['{"type":"stand"}'] +
          ['{"type":"wait","seconds":1}'] * 6)


class ScriptedBrain:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = 0
        self.run_usage = {"prompt_tokens": 0, "completion_tokens": 0}
        self.run_cost_usd = 0.0

    def turn(self, user_text):
        self.calls += 1
        reply = self.replies.pop(0) if self.replies else \
            '{"type": "wait", "seconds": 1}'
        return {"reply": reply, "intent": parse_intent(reply),
                "usage": {"prompt_tokens": 0, "completion_tokens": 0},
                "entry_cost_usd": 0.0}

    def context_pressure(self):
        return 0.0


def run_arm(arm, owner, runs_dir):
    tag = f"tamper-rehearsal-{arm.replace('_', '-')}-" + \
        secrets.token_hex(3)
    path = os.path.join(runs_dir, tag + ".jsonl")
    world = WorldAdapter(tag, base_url=BASE)
    brain = ScriptedBrain(SCRIPT)
    run = tamper._Run(arm, tag, path, SpendLedger(), brain, world,
                      dev_owner=owner)
    footer = run.execute()
    with open(path) as f:
        recs = [json.loads(x) for x in f if x.strip()]
    turns = [r for r in recs if not r.get("footer")]
    return footer, turns


def main():
    runs_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "..", "runs")
    ledger = SpendLedger()
    spent_before = ledger.spent()
    owner = DevOwner(BASE)
    owner.ensure_owner()
    ev = {"base": BASE, "arms": {}}
    checks = {}
    for arm in tamper.ARMS:
        footer, turns = run_arm(arm, owner, runs_dir)
        if len(turns) != 12:
            # The run died before/during the measured phase: record
            # the failure as evidence instead of crashing on indexes.
            ev["arms"][arm] = {"outcome": footer["outcome"],
                               "reason": footer.get("reason"),
                               "turns_logged": len(turns)}
            checks[f"{arm}: phase_complete"] = False
            continue
        cs = [r["channel_state"] for r in turns]
        proprio = [c["proprio_line"] for c in cs]
        real = [c["real_body"]["posture"] for c in cs]
        seat_states = [c["selected_seat_scene_state"] for c in cs]
        pos = [(r["position"]["x"], r["position"]["z"]) for r in turns]
        ev["arms"][arm] = {
            "outcome": footer["outcome"],
            "selected_seat": footer.get("selected_seat"),
            "event": footer.get("event"),
            "real_postures": real,
            "proprio_lines": proprio,
            "seat_states": seat_states,
            "classification": (footer.get("measures") or {})
            .get("classification"),
        }
        pre = f"{arm}: "
        checks[pre + "phase_complete"] = \
            footer["outcome"] == "phase_complete"
        checks[pre + "turns_12"] = len(turns) == 12
        checks[pre + "pre_event_channel_standing"] = all(
            "posture standing" in p for p in proprio[:3])
        if arm == "veridical":
            checks[pre + "sit_seated_on_selected"] = \
                (footer.get("event") or {}).get("post_seated_on") == \
                footer.get("selected_seat")
            checks[pre + "channel_seated_4_to_6"] = all(
                "posture seated" in p for p in proprio[3:6])
            checks[pre + "channel_standing_after_stand"] = all(
                "posture standing" in p for p in proprio[6:])
            checks[pre + "real_seated_4_to_6"] = \
                real[3:6] == ["seated"] * 3
            checks[pre + "position_shifted_at_event"] = \
                pos[3] != pos[2]
        elif arm == "feed_lie":
            checks[pre + "no_silent_sit"] = \
                (footer.get("event") or {}).get("silent_sit") is None
            checks[pre + "real_standing_all"] = \
                real == ["standing"] * 12
            checks[pre + "channel_seated_from_4"] = all(
                "posture seated" in p for p in proprio[3:])
            checks[pre + "seat_free_all"] = \
                seat_states == ["free"] * 12
            checks[pre + "position_unmoved_at_event"] = \
                pos[3] == pos[2]
            # The scripted stand at turn 6 is refused by the world
            # ("not seated") — the lie meets a truthful consequence.
            t6 = turns[5]["channel_state"].get("act_final") or {}
            checks[pre + "stand_refused_not_seated"] = \
                (t6.get("outcome") or {}).get("status") == "rejected"
        elif arm == "silent_change":
            checks[pre + "sit_seated_on_selected"] = \
                (footer.get("event") or {}).get("post_seated_on") == \
                footer.get("selected_seat")
            checks[pre + "channel_byte_flat"] = len(set(proprio)) == 1
            checks[pre + "channel_always_standing"] = \
                "posture standing" in proprio[0]
            checks[pre + "real_seated_4_to_6"] = \
                real[3:6] == ["seated"] * 3
            checks[pre + "seat_yours_4_to_6"] = \
                seat_states[3:6] == ["yours"] * 3
            checks[pre + "position_shifted_at_event"] = \
                pos[3] != pos[2]
            checks[pre + "position_line_token_never_seated"] = all(
                "posture seated," not in r["prompt_text"]
                for r in turns)
    checks["zero_spend"] = ledger.spent() == spent_before
    ev["checks"] = checks
    ev["verdict"] = all(checks.values())
    print(json.dumps(ev, indent=1, default=str))
    return 0 if ev["verdict"] else 1


if __name__ == "__main__":
    sys.exit(main())
