#!/usr/bin/env python3
"""SCRIPTED REHEARSAL for E6 peripheral vision. No paid brain,
zero spend: for each arm, run harness/e6.py's real run loop with
a scripted brain (wait x12) against the live dev stack and assert
the manipulation actually holds against the real sim:

  all arms: staging completes (primary inside, standing); the
  staged seat's bearing lands in a SIDE sector band; the
  confederate pre-stages OUTSIDE; at T=4 it enters and sits on
  the target seat (verified on its own observe); the runner-
  computed digest shows ZERO body pixels before T and body
  pixels from T on, with the majority in the staged side sector.
  P0: no prompt carries digest text (runner still computes it).
  P1: every prompt carries the digest line; none carries a
  change note.
  P2: prompts carry the digest; the turn-4 prompt carries a
  'Changed:' note naming the body appearing in the side sector.

Prints a JSON evidence object; exit 0 iff every check passes.
No secrets are printed (ids/names/counts only).
"""
import json
import os
import secrets
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "harness"))
import e6
from brain import parse_intent
from devowner import DevOwner
from ledger import SpendLedger
from world import WorldAdapter

BASE = os.environ.get("AIVERSE_GATEWAY_BASE", "http://localhost:3100")
SCRIPT = ['{"type":"wait","seconds":2}'] * 12


class ScriptedBrain:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = 0
        self.run_usage = {"prompt_tokens": 0, "completion_tokens": 0}
        self.run_cost_usd = 0.0

    def turn(self, user_text):
        self.calls += 1
        reply = self.replies.pop(0) if self.replies else \
            '{"type": "wait", "seconds": 2}'
        return {"reply": reply, "intent": parse_intent(reply),
                "usage": {"prompt_tokens": 0, "completion_tokens": 0},
                "entry_cost_usd": 0.0}

    def context_pressure(self):
        return 0.0


def run_arm(arm, owner, runs_dir):
    tag = f"e6-rehearsal-{arm.lower()}-" + secrets.token_hex(3)
    path = os.path.join(runs_dir, tag + ".jsonl")
    world = WorldAdapter(tag, base_url=BASE)
    conf_world = WorldAdapter(tag + "-conf", base_url=BASE)
    brain = ScriptedBrain(SCRIPT)
    run = e6._Run(arm, tag, path, SpendLedger(), brain, world,
                  conf_world=conf_world, dev_owner=owner)
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
    for arm in e6.ARMS:
        footer, turns = run_arm(arm, owner, runs_dir)
        pre = f"{arm}: "
        if len(turns) != 12 or footer["outcome"] != "phase_complete":
            ev["arms"][arm] = {"outcome": footer["outcome"],
                               "reason": footer.get("reason"),
                               "turns_logged": len(turns)}
            checks[pre + "phase_complete"] = False
            continue
        cs = [r["channel_state"] for r in turns]
        digests = [c["digest_counts"] for c in cs]
        body_totals = []
        side_share = []
        for d in digests:
            counts = {}
            for k, n in d.items():
                s, b, c = k.split("|")
                counts[(s, b, c)] = n
            total, per = e6.body_pixels(counts)
            body_totals.append(total)
            side_share.append(
                (per["ahead-left"] + per["ahead-right"]) / total
                if total else None)
        prompts = [r["prompt_text"] for r in turns]
        choice = (footer.get("staging") or {}).get("seat_choice") or {}
        ev["arms"][arm] = {
            "outcome": footer["outcome"],
            "target_seat": footer.get("target_seat"),
            "seat_choice": choice,
            "conf_staging": footer.get("conf_staging"),
            "event": footer.get("event"),
            "visibility": footer.get("visibility"),
            "body_pixels_per_turn": body_totals,
            "side_share_per_turn": side_share,
            "digest_line_turn1": cs[0]["digest_line"],
            "digest_line_turn4": cs[3]["digest_line"],
            "change_note_turn4": cs[3]["change_note"],
            "look_errors": [c["look_error"] for c in cs
                            if c["look_error"]],
        }
        checks[pre + "phase_complete"] = True
        checks[pre + "conf_outside_before_event"] = \
            (footer.get("conf_staging") or {}).get("inside_room") != \
            (footer.get("tea") or {}).get("name")
        checks[pre + "conf_seated_on_target"] = \
            (footer.get("event") or {}).get("post_seated_on") == \
            footer.get("target_seat")
        checks[pre + "staged_bearing_side_band"] = \
            17.0 <= abs(choice.get("bearing_after_deg") or 0) <= 40.0
        checks[pre + "no_body_pixels_pre_event"] = \
            all(t == 0 for t in body_totals[:3])
        checks[pre + "body_pixels_from_event"] = \
            all(t > 0 for t in body_totals[3:])
        checks[pre + "visibility_turn_4"] = \
            (footer.get("visibility") or {}).get("turn") == 4
        checks[pre + "visibility_side_sector"] = \
            bool((footer.get("visibility") or {}).get("side_sector"))
        checks[pre + "no_look_errors"] = \
            not ev["arms"][arm]["look_errors"]
        if arm == "P0":
            checks[pre + "prompts_digest_free"] = all(
                "Periphery:" not in p and "Changed:" not in p
                for p in prompts)
        if arm == "P1":
            checks[pre + "prompts_carry_digest"] = all(
                "Periphery:" in p for p in prompts)
            checks[pre + "prompts_note_free"] = all(
                "Changed:" not in p for p in prompts)
        if arm == "P2":
            checks[pre + "prompts_carry_digest"] = all(
                "Periphery:" in p for p in prompts)
            checks[pre + "turn4_change_note_names_body"] = \
                "body appeared" in prompts[3]
    checks["zero_spend"] = ledger.spent() == spent_before
    ev["checks"] = checks
    ev["verdict"] = all(checks.values())
    print(json.dumps(ev, indent=1, default=str))
    return 0 if ev["verdict"] else 1


if __name__ == "__main__":
    sys.exit(main())
