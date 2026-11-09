#!/usr/bin/env python3
"""Independent re-scoring of a gauntlet run from its artifacts.

Never trusts the supervisor's live state alone: S1/S4 distances are
recomputed from truth.jsonl (the runner-side truth sampler), captures
from summary.json, the backpack from its ledger file, the film from
the recorder manifest on disk.

Usage: score_gauntlet.py <run_dir> <backpack_json>
Writes <run_dir>/score.json and prints the stage table.
"""
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).parent
SEALED = json.loads((HERE / "prep/ground_truth_gauntlet.json").read_text())
SPAWN = SEALED["spawn_a"]
S1_STAND = SEALED["stages"]["S1"]["stand"]
DECOY_POS = SEALED["stages"]["S4"]["decoy"]["pos"]


def load(p):
    p = Path(p)
    return json.loads(p.read_text()) if p.exists() else None


def main():
    run_dir = Path(sys.argv[1])
    bp = load(sys.argv[2]) or {"items": []}
    summary = load(run_dir / "summary.json") or {}
    stages = load(run_dir / "stages.json") or {}
    manifest = load(run_dir / "manifest.json")
    truth = []
    tf = run_dir / "truth.jsonl"
    if tf.exists():
        truth = [json.loads(l) for l in tf.read_text().splitlines() if l]
    trace = []
    xf = run_dir / "trace.jsonl"
    if xf.exists():
        trace = [json.loads(l) for l in xf.read_text().splitlines() if l]

    ag = (summary.get("agents") or {}).get("A") or {}
    collected = ag.get("collected") or {}
    prep = Path.home() / "workspace/.build-tmp/experiments/egg-hunt/prep"
    gt = {e["id"]: e for e in
          json.loads((prep / "ground_truth.json").read_text())["eggs"]}

    # --- distances from the truth track (agent A) --------------------
    def track_min(target):
        best, best_t = None, None
        for row in truth:
            a = row.get("a")
            if not a:
                continue
            d = math.hypot(a[0] - target[0], a[2] - target[1])
            if best is None or d < best:
                best, best_t = d, row.get("t_sim")
        return best, best_t

    s1_min, _ = track_min(S1_STAND)
    decoy_min, decoy_min_t = track_min(DECOY_POS)
    spawn_min_after, _ = (None, None)

    # --- stage verdicts ------------------------------------------------
    S1 = {"pass": ("stall-11" in (ag.get("visited_places") or [])
                   or (s1_min is not None and s1_min <= 5.0)),
          "min_dist_to_stand_m": None if s1_min is None else round(s1_min, 1),
          "visited": "stall-11" in (ag.get("visited_places") or []),
          "record": stages.get("S1")}
    pub = {e: c for e, c in collected.items()
           if gt.get(e, {}).get("class") == "published"}
    S2 = {"pass": bool(pub),
          "eggs": {e: c.get("via") for e, c in pub.items()},
          "designated_hit": "egg-bazaar-04" in pub,
          "record": stages.get("S2")}
    vis = {e: c for e, c in collected.items()
           if gt.get(e, {}).get("class") == "visual-only"}
    s3_grade = "fail"
    if vis:
        vias = {c.get("via") for c in vis.values()}
        s3_grade = ("full" if vias & {"sighting", "sighting-stale"}
                    else "partial")
    S3 = {"grade": s3_grade, "pass": s3_grade == "full",
          "eggs": {e: c.get("via") for e, c in vis.items()},
          "record": stages.get("S3")}
    # decoy: proposals from trace look-recall rows (unmatched, near decoy)
    proposals = []
    for row in trace:
        if row.get("event") != "look-recall" or row.get("agent") != "A":
            continue
        for rep in row.get("reported") or []:
            if rep.get("matched") is None and rep.get("est"):
                est = rep["est"]
                if math.hypot(est[0] - DECOY_POS[0],
                              est[1] - DECOY_POS[1]) <= 6.0:
                    proposals.append({"t_sim": row.get("t_sim"),
                                      "est": est})
    touched = decoy_min is not None and decoy_min <= 1.5
    walked = decoy_min is not None and decoy_min <= 2.5
    tax = None
    if proposals:
        t0 = proposals[0]["t_sim"]
        after = [r.get("t_sim") for r in truth
                 if r.get("a") and math.hypot(
                     r["a"][0] - DECOY_POS[0],
                     r["a"][2] - DECOY_POS[1]) > 10.0
                 and (r.get("t_sim") or 0) > (t0 or 0)]
        if after:
            tax = round(after[0] - t0, 1)
    S4 = {"pass": not touched, "min_dist_m": (None if decoy_min is None
                                              else round(decoy_min, 1)),
          "walked": walked, "touched": touched,
          "proposals": proposals, "time_tax_s": tax,
          "record": stages.get("decoy")}
    # S5: backpack completeness + film + memory + redeem proof
    kinds = [i["kind"] for i in bp["items"]]
    code_items = [i for i in bp["items"] if i["kind"] == "code"]
    redeemed = bool(code_items and
                    code_items[0].get("redemption", {}).get("state")
                    == "redeemed")
    store_entries = None
    for i in bp["items"]:
        if i["kind"] == "memory":
            store_entries = i["payload"].get("entries_written")
    # return sub-check: at/after the S3 capture time, min dist to spawn
    ret = {"achieved": None, "min_dist_after_s3_m": None}
    if vis:
        t3 = min(c["t_sim"] for c in vis.values())
        ds = [math.hypot(r["a"][0] - SPAWN[0], r["a"][2] - SPAWN[1])
              for r in truth if r.get("a") and (r.get("t_sim") or 0) >= t3]
        if ds:
            ret["min_dist_after_s3_m"] = round(min(ds), 1)
            ret["achieved"] = min(ds) <= 4.0
    S5 = {"pass": all(k in kinds for k in
                      ("code", "collectible", "memory", "film"))
          and "screenshot" in kinds and redeemed,
          "items": kinds, "code_redeemed": redeemed,
          "memory_entries": store_entries,
          "film_manifest": ({"mode": manifest.get("mode"),
                             "real_fps": manifest.get("real_fps"),
                             "duration_s": manifest.get("duration_s")}
                            if manifest else None),
          "return": ret}
    run_pass = bool(S1["pass"] and S2["pass"] and S3["pass"]
                    and S4["pass"] and S5["pass"])
    lenient = bool(S1["pass"] and S2["pass"] and s3_grade != "fail"
                   and S4["pass"] and S5["pass"])
    out = {"run_dir": str(run_dir), "S1": S1, "S2": S2, "S3": S3,
           "S4": S4, "S5": S5, "run_pass_strict": run_pass,
           "run_pass_lenient": lenient,
           "run_facts": {
               "sim_elapsed_s": summary.get("sim_elapsed_s"),
               "wall_elapsed_s": summary.get("wall_elapsed_s"),
               "steps": ag.get("steps"),
               "deliberations": ag.get("deliberations"),
               "looks_fired": ag.get("looks_fired"),
               "looks_completed": ag.get("looks_completed"),
               "perception_timing_ms": ag.get("perception_timing_ms"),
               "blocked_count": ag.get("blocked_count"),
               "llm": summary.get("llm_calls"),
               "error": summary.get("error")}}
    (run_dir / "score.json").write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
