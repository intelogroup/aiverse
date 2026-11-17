#!/usr/bin/env python3
"""E3-verbal hand-audit dump (pre-registered audit step).

Prints, from the raw e3v run traces (not the summary):
  1. EVERY turn the classifier flagged as a time reference, with
     the agent's FULL report text, the cleaned text the lexicons
     saw, the displayed clock, and real elapsed — so a human can
     confirm or strike each flag.
  2. Every echo turn (verbatim clock-line parroting).
  3. A seeded random sample of voiced-but-unflagged turns, for
     false-negative checking.

Usage: python3 dev/e3v_audit.py [--sample 15] [--seed 42]
"""
import argparse
import glob
import json
import os
import random
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "harness"))
import e3v  # noqa: E402

RUNS = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "..", "runs")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=15)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    flagged, echoes, unflagged_voiced = [], [], []
    for path in sorted(glob.glob(os.path.join(RUNS, "e3v-*.jsonl"))):
        recs = e3v.e3mod.read_records(path)
        footer = next((r for r in recs if r.get("footer")), {})
        if footer.get("verbal") is not True:
            continue
        mode = {v: k for k, v in e3v.CHANNEL_MODE.items()}[
            footer.get("sham_mode")]
        a = e3v.analyze_records(recs, mode)
        run_id = os.path.basename(path)[:-6]
        by_turn = {}
        for r in recs:
            if r.get("footer"):
                continue
            cs = r.get("channel_state") or {}
            call = r.get("tool_call") or {}
            intent = call if isinstance(call, dict) \
                and "type" in call else None
            by_turn[r.get("turn")] = e3v.report_of(
                cs.get("brain_reply") or "", intent)
        disp = {d["turn"]: d for d in a["displayed"]}
        for ev in a["ref_events"]:
            t = ev["turn"]
            flagged.append((run_id, mode, t, ev, by_turn.get(t, "")))
        for t in a["echo_turns"]:
            echoes.append((run_id, mode, t, by_turn.get(t, "")))
        ref_turns = set(a["time_ref_turns"])
        for d in a["displayed"]:
            t = d["turn"]
            rep = by_turn.get(t, "")
            if rep and t not in ref_turns:
                unflagged_voiced.append(
                    (run_id, mode, t, d, rep))

    print(f"=== FLAGGED TIME REFERENCES: {len(flagged)} ===")
    for run_id, mode, t, ev, rep in flagged:
        print(f"\n[{mode}] {run_id} turn {t} "
              f"disp_remaining={ev['disp_remaining']} "
              f"real_elapsed={ev['real_elapsed']}")
        print(f"  REPORT: {rep}")
        print(f"  QUOTE : {ev['quote']}")
    print(f"\n=== ECHO TURNS: {len(echoes)} ===")
    for run_id, mode, t, rep in echoes:
        print(f"[{mode}] {run_id} turn {t}: {rep}")
    rng = random.Random(args.seed)
    sample = rng.sample(unflagged_voiced,
                        min(args.sample, len(unflagged_voiced)))
    print(f"\n=== UNFLAGGED VOICED SAMPLE: {len(sample)} of "
          f"{len(unflagged_voiced)} ===")
    for run_id, mode, t, d, rep in sample:
        print(f"[{mode}] {run_id} turn {t} "
              f"disp_remaining={d['disp_remaining']} "
              f"real_elapsed={d['real_elapsed']}: {rep}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
