#!/usr/bin/env python3
"""E2 hand-audit dump (pre-registered audit step).

Prints, from the raw e2 run traces (not the summary):
  1. EVERY turn the classifier flagged as a body reference, with
     the agent's FULL report text and the displayed body values —
     so a human can confirm or strike each flag (idiom watch:
     "the rest of the way", "rest" as remainder, "pace" as speed
     of progress with no body sense).
  2. Every anticipatory-regulation event with its context.
  3. Every B2 first-refusal + the next turn's intent.
  4. A seeded random sample of voiced-but-unflagged turns, for
     false-negative checking.
  5. Per-run one-liners for all 36 runs (outcome, turns, run
     count, min energy, enforcement) for the reconciliation.

Usage: python3 dev/e2_audit.py [--sample 18] [--seed 42]
"""
import argparse
import glob
import json
import os
import random
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "harness"))
import e2  # noqa: E402
import e3v  # noqa: E402

RUNS = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "..", "runs")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=18)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    flagged, regs, refusals, unflagged, oneliners = [], [], [], [], []
    found = e2.scan_footers(RUNS)
    attempts = []
    for key in sorted(found):
        attempts.extend(found[key])
    for att in sorted(attempts, key=lambda x: x["path"]):
        path = att["path"]
        name = os.path.basename(path)
        arm = att["arm"]
        recs = e2.read_records(path)
        footer = att["footer"]
        a = e2.analyze_records(recs, arm)
        run_id = name[:-6]
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
        for ev in a["ref_events"]:
            flagged.append((run_id, arm, ev,
                            by_turn.get(ev["turn"], "")))
        for ev in a["regulation_events"]:
            regs.append((run_id, arm, ev,
                         by_turn.get(ev["turn"], "")))
        frt = a.get("first_refusal_turn")
        if frt is not None:
            nxt = next((r for r in recs
                        if not r.get("footer")
                        and r.get("turn") == frt + 1), None)
            ncall = (nxt or {}).get("tool_call") or {}
            fr = {"turn": frt,
                  "response": a.get("first_refusal_response"),
                  "next_intent": ncall.get("type")}
            refusals.append((run_id, fr, by_turn.get(frt, ""),
                             by_turn.get(frt + 1, "")))
        ref_turns = set(a["body_ref_turns"])
        for r in recs:
            if r.get("footer"):
                continue
            rep = by_turn.get(r.get("turn"), "")
            if rep and r.get("turn") not in ref_turns:
                unflagged.append((run_id, arm,
                                  r.get("turn"), rep))
        enf = footer.get("body_enforcement") or {}
        oneliners.append(
            f"{run_id}: {footer.get('outcome')} turns="
            f"{footer.get('turns')} wall={footer.get('wall_seconds')} "
            f"run_to={footer.get('run_to_count')} minE="
            f"{footer.get('body_min_energy')} enf={enf} "
            f"refs={a['body_ref_count']} regs="
            f"{a['regulation_count']} cost={footer.get('cost_usd')}")

    print("=== PER-RUN ONE-LINERS ===")
    for line in oneliners:
        print(line)
    print(f"\n=== FLAGGED BODY REFERENCES: {len(flagged)} ===")
    for run_id, arm, ev, rep in flagged:
        print(f"\n[{arm}] {run_id} turn {ev['turn']} "
              f"dispE={ev['disp_energy']}")
        print(f"  REPORT: {rep}")
        print(f"  QUOTE : {ev['quote']}")
    print(f"\n=== REGULATION EVENTS: {len(regs)} ===")
    for run_id, arm, ev, rep in regs:
        print(f"[{arm}] {run_id} turn {ev['turn']} {ev['kind']} "
              f"dispE={ev['disp_energy']}: {rep}")
    print(f"\n=== B2 FIRST REFUSALS: {len(refusals)} ===")
    for run_id, fr, rep_at, rep_next in refusals:
        print(f"\n{run_id}: refusal turn {fr['turn']} -> response "
              f"{fr['response']} (next intent {fr['next_intent']})")
        print(f"  AT  : {rep_at}")
        print(f"  NEXT: {rep_next}")
    rng = random.Random(args.seed)
    sample = rng.sample(unflagged, min(args.sample, len(unflagged)))
    print(f"\n=== UNFLAGGED VOICED SAMPLE: {len(sample)} of "
          f"{len(unflagged)} ===")
    for run_id, arm, t, rep in sample:
        print(f"[{arm}] {run_id} turn {t}: {rep}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
