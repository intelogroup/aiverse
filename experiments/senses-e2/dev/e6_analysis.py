#!/usr/bin/env python3
"""Final E6 accounting: rebuild all 16 attempts (15 batch + 1
infra re-run) from their run-log footers, in execution order,
merge through harness/e6.summarize (last attempt per (arm, slot)
wins the slot; every attempt stays listed), write
runs/e6-summary-final.json, and print a deep-dive table for the
report. Read-only; spends nothing."""
import glob
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "harness"))
import e6
from ledger import SpendLedger

RUNS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..",
                    "runs")


def load_run(path):
    recs = [json.loads(x) for x in open(path) if x.strip()]
    foot = [r for r in recs if r.get("footer")][0]
    turns = [r for r in recs if not r.get("footer")]
    return foot, turns


def main():
    batch = json.load(open(os.path.join(RUNS, "e6-summary.json")))
    order = list(batch["execution_order"])
    rerun = json.load(open(os.path.join(RUNS, "e6-rerun.out")))
    order.append(rerun[0]["run_id"])
    attempts = []
    dive = {}
    for run_id in order:
        path = os.path.join(RUNS, run_id + ".jsonl")
        foot, turns = load_run(path)
        parts = run_id.split("-")
        arm = parts[1].upper()
        slot = parts[2]
        attempts.append({"arm": arm, "slot": slot, "run_id": run_id,
                         "path": path, "footer": foot})
        if foot.get("outcome") != "phase_complete":
            dive[run_id] = {"arm": arm, "outcome": foot["outcome"],
                            "reason": foot.get("reason"),
                            "cost": foot.get("accounted_cost_usd")}
            continue
        m = foot["measures"]
        t4 = turns[3]["channel_state"] if len(turns) > 3 else {}
        react_turn = m.get("noticed_turn")
        react = None
        if react_turn is not None:
            f = turns[react_turn - 1]["channel_state"]["features"]
            react = {"turn": react_turn, "prose": f["prose"][:220],
                     "intent_type": f["intent_type"],
                     "person_match": f["person_match"],
                     "greeting": f["greeting"],
                     "act_reaction": f["act_reaction"]}
        pre = []
        for t in turns[:3]:
            f = t["channel_state"]["features"]
            if f["person_match"] or f["greeting"]:
                pre.append({"turn": t["turn"], "prose": f["prose"][:220],
                            "person_match": f["person_match"],
                            "greeting": f["greeting"]})
        dive[run_id] = {
            "arm": arm, "outcome": foot["outcome"],
            "cost": foot.get("accounted_cost_usd"),
            "wall_s": foot.get("wall_seconds"),
            "load1": [foot.get("load1_start"), foot.get("load1_end")],
            "seat": foot.get("target_seat"),
            "bearing_after": (foot.get("staging") or {})
            .get("seat_choice", {}).get("bearing_after_deg"),
            "event_duration_s": (foot.get("event") or {})
            .get("duration_s"),
            "visibility": foot.get("visibility"),
            "scene_body_at_T": bool(t4.get("scene_bodies")),
            "digest_at_T": t4.get("digest_line"),
            "note_at_T": t4.get("change_note"),
            "classification": m["classification"],
            "react": react,
            "verbal": m["verbal_report"], "greeting_m": m["greeting"],
            "act_m": m["act_reaction"],
            "false_reaction": m["false_reaction"],
            "pre_event_mentions": pre,
            "door_mentions": m["door_mentions"],
            "digest_chars": foot.get("digest_chars_per_turn"),
            "note_chars": foot.get("note_chars_per_turn"),
        }
    ledger = SpendLedger()
    summary = e6.summarize(attempts, ledger, seed=batch["seed"],
                           order=order)
    summary["note"] = ("Final merged accounting: 15 batch attempts "
                       "+ 1 infra re-run of slot (P2, p1) whose "
                       "batch attempt died in confederate staging "
                       "(infra_failed, $0). summarize() keeps the "
                       "last attempt per (arm, slot); all 16 "
                       "attempts are listed.")
    out = os.path.join(RUNS, "e6-summary-final.json")
    with open(out, "w") as f:
        json.dump(summary, f, indent=1)
    print(json.dumps({"summary": summary, "dive": dive}, indent=1,
                     default=str))


if __name__ == "__main__":
    main()
