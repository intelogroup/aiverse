#!/usr/bin/env python3
"""Build + validate the drive layer's sealed staging record.

Writes prep/ground_truth_drive.json — SUPERVISOR-SIDE provenance. Its
sealed parts are the R2 selection record and the fitted energy cost;
R2's POSITION is published testimony (the spec is explicit: a rest
source nobody can find is a trap, §1c) and appears in the digest.

Two staging acts, both by the spec's own rules:
1. R2 selection (§1c): from the published 158 places — a named place
   >= 60 m from R1, not a stage target, not within 6 m of any truth
   egg (published or visual-only). Deterministic tie-break adopted by
   this build (the spec fixes the rule, not the pick): among
   qualifying places, the CLOSEST legal one to R1 (a source must be
   reachable to be a source), then lowest place id.
2. Energy-cost calibration (§1a, mandatory pre-flight): the actual
   travelled path length is computed from the gauntlet baselines'
   truth.jsonl, and the per-metre cost is fitted so condition B's
   100-unit endowment buys 1.3x the median baseline path. Condition
   C's 25 units then buy 0.325x — the spec's 0.35x intent is stated
   with an ≈, and 100/25 != 1.3/0.35 exactly, so the fit is anchored
   on B and C's realized ratio is recorded, not hidden.

RE-FIT AT G3 (2026-11-09, drive program Phase 2): the baseline set
is now COMPLETE — run 1, run 2 (attempt 3, resumed and scored),
and run 3, all completed and scored (GAUNTLET-REPORT headline).
The inputs and their dispositions are recorded in the sealed file.
The fit RULE is unchanged from the provisional fit; only the
input set completed.
"""
import json
import math
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from replay_drives import read_truth_track, path_length_m  # noqa: E402

EGG_PREP = Path.home() / "workspace/.build-tmp/experiments/egg-hunt/prep"
GAUNTLET = Path.home() / "workspace/.build-tmp/experiments/gauntlet"
RIG_PLACES = (Path.home() / "tmp-pip/aiverse-experiments/apps/console"
              / "public/assets/city3-places.json")

R1_POS = [-17.0, 51.2]                     # spawn = S5 return target
STAGE_TARGET_PLACES = {"stall-11"}         # S1's named place (sealed)
MIN_R2_FROM_R1_M = 60.0
MIN_R2_FROM_EGG_M = 6.0

# Calibration inputs: the completed gauntlet baseline set (G3 re-fit,
# 2026-11-09 — all three runs completed and scored; GAUNTLET-REPORT).
BASELINES = [
    (GAUNTLET / "run-1", "completed, scored (full run)"),
    (GAUNTLET / "run-2",
     "attempt 3: completed, scored — resumed from checkpoint after "
     "a runtime restart killed leg 1 (interruption disclosed in "
     "run-2/interruptions.json)"),
    (GAUNTLET / "run-3", "completed, scored (full run)"),
]


def main():
    problems = []
    places = json.loads(RIG_PLACES.read_text())
    if len(places) != 158:
        problems.append(f"places file has {len(places)} entries, "
                        f"expected the published 158")
    # provenance: this places file must be the rig's own testimony —
    # its stall-11 stand has to match the gauntlet's sealed S1 stand.
    s11 = next((p for p in places if p["id"] == "stall-11"), None)
    sealed_g = json.loads((GAUNTLET / "prep/ground_truth_gauntlet.json")
                          .read_text())
    if not s11 or s11["stand"] != sealed_g["stages"]["S1"]["stand"]:
        problems.append("stall-11 stand mismatch vs gauntlet sealed "
                        "record — wrong places file")
    truth = json.loads((EGG_PREP / "ground_truth.json").read_text())
    eggs = truth["eggs"]

    def egg_clearance(pos):
        return min(math.hypot(pos[0] - e["pos"][0], pos[1] - e["pos"][1])
                   for e in eggs)

    qualifying = []
    for p in places:
        if p["id"] in STAGE_TARGET_PLACES:
            continue
        stand = [float(p["stand"][0]), float(p["stand"][1])]
        d_r1 = math.hypot(stand[0] - R1_POS[0], stand[1] - R1_POS[1])
        if d_r1 < MIN_R2_FROM_R1_M:
            continue
        d_egg = egg_clearance(stand)
        if d_egg < MIN_R2_FROM_EGG_M:
            continue
        qualifying.append({"id": p["id"], "pos": stand,
                           "dist_from_r1_m": round(d_r1, 2),
                           "egg_clearance_m": round(d_egg, 2)})
    if not qualifying:
        problems.append("no place qualifies as R2 under the §1c rule")
        print("PREP FAILED:", problems)
        return 1
    qualifying.sort(key=lambda q: (q["dist_from_r1_m"], q["id"]))
    r2 = qualifying[0]

    paths = {}
    for run_dir, disposition in BASELINES:
        paths[run_dir.name] = {
            "path_m": round(path_length_m(read_truth_track(run_dir)), 1),
            "disposition": disposition}
    median_m = statistics.median(v["path_m"] for v in paths.values())
    cost = 100.0 / (1.3 * median_m)
    calib = {
        "baseline_paths_m": paths,
        "median_path_m": round(median_m, 1),
        "fit_anchor": "B: 100 units = 1.3 x median baseline path",
        "b_range_m": round(100.0 / cost, 1),
        "c_range_m": round(25.0 / cost, 1),
        "c_ratio_realized": round((25.0 / cost) / median_m, 3),
        "c_ratio_spec_intent": 0.35,
        "provisional": False,
        "provisional_why": ("resolved at G3 (2026-11-09): the "
                            "baseline set is complete — three "
                            "completed, scored gauntlet runs; this "
                            "fit supersedes the provisional fit "
                            "(cost 0.9843/m on run-1 + the stopped "
                            "run-2 attempt-1 prefix)"),
    }
    sealed = {
        "note": ("Sealed staging provenance for the drive layer "
                 "(DRIVE-LAYER-SPEC v1). R2's position is PUBLISHED "
                 "testimony and appears in the agent's digest; this "
                 "file's sealed content is the selection record and "
                 "the fitted cost."),
        "r1": {"id": "home-bench", "pos": R1_POS, "home": True,
               "anchor": "spawn point (-17, 51.2); also the S5 return "
                         "target"},
        "r2": {"id": r2["id"], "pos": r2["pos"], "home": False,
               "dist_from_r1_m": r2["dist_from_r1_m"],
               "egg_clearance_m": r2["egg_clearance_m"],
               "selection_rule": ("published place, stand >= 60 m from "
                                  "R1, not a stage target, stand >= 6 m "
                                  "from every truth egg; closest legal "
                                  "to R1, then lowest id"),
               "qualifying_count": len(qualifying)},
        "energy_cost_per_m_fitted": round(cost, 5),
        "calibration": calib,
        "r1_closure_window_sim": [600, 1200],
    }
    if problems:
        print("PREP FAILED:", problems)
        return 1
    dest = HERE / "prep"
    dest.mkdir(exist_ok=True)
    (dest / "ground_truth_drive.json").write_text(
        json.dumps(sealed, indent=1))
    print(f"R2: {r2['id']} at {r2['pos']} "
          f"({r2['dist_from_r1_m']} m from R1, egg clearance "
          f"{r2['egg_clearance_m']} m, {len(qualifying)} qualifying)")
    print(f"calibration: median baseline path {median_m:.1f} m -> "
          f"cost {cost:.5f}/m (B range {100.0/cost:.0f} m, "
          f"C range {25.0/cost:.0f} m = "
          f"{(25.0/cost)/median_m:.3f}x median)")
    print(f"wrote {dest / 'ground_truth_drive.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
