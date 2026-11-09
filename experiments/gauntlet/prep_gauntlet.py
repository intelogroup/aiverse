#!/usr/bin/env python3
"""Build + validate the gauntlet's sealed ground truth.

Writes prep/ground_truth_gauntlet.json — SUPERVISOR-SIDE ONLY. The
decoy record in it must never be served, fetched, or placed in any
agent-reachable artifact (per-manifest hiddenness law). The decoy
reaches the page only as a one-shot __egg-inject payload at run time.
"""
import json
import math
from pathlib import Path

HERE = Path(__file__).parent
EGG_PREP = Path.home() / "workspace/.build-tmp/experiments/egg-hunt/prep"

SPAWN_A = [-17.0, 51.2]
S1_PLACE = "stall-11"
S1_STAND = [-35.0, 51.2]
S2_DESIGNATED = "egg-bazaar-04"
DECOY_ID = "gauntlet-decoy-01"
DECOY_POS = [0.0, 15.2]


def main():
    truth = json.loads((EGG_PREP / "ground_truth.json").read_text())
    eggs = truth["eggs"]
    problems = []

    def mindist(pos, pool):
        return min(math.hypot(pos[0] - e["pos"][0], pos[1] - e["pos"][1])
                   for e in pool)

    # S1 stand must be clean: no truth egg within 10 m (an S1 arrival
    # must not be able to trip a claim or stand on the S3 target).
    d = mindist(S1_STAND, eggs)
    if d < 10.0:
        problems.append(f"S1 stand too close to a truth egg: {d:.1f} m")
    # Decoy: >= 10 m from EVERY truth egg (matcher binds at 5.0 m;
    # sigma_vlm ~0.32r makes misattribution a >5-sigma event at 17 m).
    d = mindist(DECOY_POS, eggs)
    if d < 10.0:
        problems.append(f"decoy too close to a truth egg: {d:.1f} m")
    decoy_nearest = min(eggs, key=lambda e: math.hypot(
        DECOY_POS[0] - e["pos"][0], DECOY_POS[1] - e["pos"][1]))
    # S2 designated target exists and is published.
    tgt = next((e for e in eggs if e["id"] == S2_DESIGNATED), None)
    if not tgt or tgt["class"] != "published":
        problems.append("S2 designated target missing/not published")
    if problems:
        print("PREP FAILED:", problems)
        return 1

    sealed = {
        "note": ("SEALED — supervisor-side truth for the onboarding "
                 "gauntlet. Never served, never fetched, never in an "
                 "agent prompt. The decoy reaches the page only as a "
                 "one-shot __egg-inject payload (closure pattern)."),
        "spawn_a": SPAWN_A,
        "stages": {
            "S1": {"place": S1_PLACE, "stand": S1_STAND,
                   "arrive_visited_m": 6.0, "arrive_pos_m": 5.0},
            "S2": {"designated_egg": S2_DESIGNATED,
                   "designated_pos": tgt["pos"],
                   "pass": "any published egg collected"},
            "S3": {"pass_full_via": ["sighting", "sighting-stale"],
                   "pass_partial_via": ["proximity"],
                   "targets": "any of the 15 visual-only eggs"},
            "S4": {"decoy": {"id": DECOY_ID, "pos": DECOY_POS,
                             "scale": 0.85, "carries_code": False,
                             "nearest_truth_egg": decoy_nearest["id"],
                             "nearest_truth_m": round(mindist(DECOY_POS, eggs), 1),
                             "proposed_radius_m": 6.0,
                             "walked_radius_m": 2.5,
                             "touched_radius_m": 1.5}},
            "S5": {"return_to": SPAWN_A, "return_radius_m": 4.0},
        },
        "budgets": {"sim_budget_s": 2400, "step_cap": 90, "look_cap": 25,
                    "wall_ceiling_s": 3600, "outer_timeout_s": 4200},
    }
    out = HERE / "prep" / "ground_truth_gauntlet.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(sealed, indent=1))
    print(f"prep OK: decoy {DECOY_ID} at {DECOY_POS}, nearest truth egg "
          f"{decoy_nearest['id']} at {mindist(DECOY_POS, eggs):.1f} m; "
          f"S1 stand clearance {mindist(S1_STAND, eggs):.1f} m -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
