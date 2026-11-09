#!/usr/bin/env python3
"""DESCRIPTIVE (in-sample, no training) scoring of the incumbent claim rule
for decision type (c) claim/abstain. Rule: percept_uncertainty.make_sighting
(VLM source, no depth): claim_worthy iff sigma_2d = 0.32*r <= COLLECT_R/2
= 0.75 m, i.e. r <= 2.34 m. Applied to the staged sightings the sigma curve
was FITTED on -> this is a consistency description, NOT a held-out test.
A claim 'would succeed' iff the sighting's measured position error <= 1.5 m
(the gateway claim radius)."""
import json, sys, pathlib
sys.path.insert(0, str(pathlib.Path.home() / "workspace/.build-tmp/experiments/visibility"))
from percept_uncertainty import make_sighting

EH = pathlib.Path.home() / "workspace/.build-tmp/experiments/egg-hunt"
rows = []
d = json.load(open(EH / "staged-trials-luna/trials_summary.json"))
for r in d["rows"]:
    rows.append({"model": "luna", **r})
for line in open(EH / "staged-trials-agnes/trials.jsonl"):
    r = json.loads(line)
    rows.append({"model": "agnes", "trial": r["trial"], "dist_m": r["dist_m"],
                 "hit": r["hit"], "match_err_m": r.get("match_err_m")})

hits = [r for r in rows if r["hit"]]
print(f"staged sightings: {len(rows)} trials, {len(hits)} hits with measured error")
for r in hits:
    s = make_sighting([0, 0], r["dist_m"], source="vlm")
    r["licensed"] = s["claim_worthy"]
    r["would_succeed"] = r["match_err_m"] is not None and r["match_err_m"] <= 1.5
    print(f"  {r['model']:>5} trial {r['trial']}: r={r['dist_m']:>4} m  err={r['match_err_m']} m  "
          f"rule licenses claim: {r['licensed']}  claim would succeed: {r['would_succeed']}")
lic = [r for r in hits if r["licensed"]]
ref = [r for r in hits if not r["licensed"]]
print(f"\nlicensed: {len(lic)}/{len(hits)}; licensed success: "
      f"{sum(r['would_succeed'] for r in lic)}/{len(lic) if lic else 0}")
print(f"refused hits that WOULD have succeeded at range: "
      f"{sum(r['would_succeed'] for r in ref)}/{len(ref)} "
      f"(the rule trades these for an approach-and-relook, by design)")
print("note: all staged hits are at 4-15 m; the rule licenses claims only <= 2.34 m,")
print("so on this fitted set it fires zero times and errs zero times. In-sample only.")
json.dump({"n_trials": len(rows), "n_hits": len(hits),
           "hits": [{k: r[k] for k in ("model", "trial", "dist_m", "match_err_m", "licensed", "would_succeed")} for r in hits]},
          open(pathlib.Path.home() / "workspace/.build-tmp/experiments/decision-head/results/claim_rule_descriptive.json", "w"), indent=1)
