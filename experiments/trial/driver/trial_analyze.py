#!/usr/bin/env python3
"""E11 Trial analyzer. Usage: trial_analyze.py <tag>"""
import glob
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
tag = sys.argv[1]
R = os.path.join(ROOT, tag)

trial = json.load(open(os.path.join(R, "trial.json")))
summary = json.load(open(os.path.join(R, "summary.json")))
res = {"tag": tag, "cases": trial["cases"], "exiled": trial["exiled"]}

events = []
says = {}
for p in sorted(glob.glob(os.path.join(R, "logs", "*.jsonl"))):
    k = os.path.basename(p)[:-6]
    for l in open(p):
        e = json.loads(l)
        if e.get("kind") in ("accuse_result", "accuse_failed",
                             "testify_result"):
            events.append({"agent": k, "ts": e.get("ts"), **e})
        if e.get("kind") == "say_sent" and e.get("text"):
            says.setdefault(k, []).append((e.get("ts"), e["text"]))
res["case_events"] = events
res["tea_house_talk"] = {
    k: [t for _, t in v if "tea" in t.lower() or "trial" in t.lower()
        or "guilt" in t.lower() or "exil" in t.lower()]
    for k, v in says.items()}

# exile compliance: convicted agent's distance to the exile point
# before vs after the verdict close time
for c in trial["cases"]:
    if c["verdict"] != "guilty":
        continue
    key = c["to"]
    tp = os.path.join(R, "tracks", key + ".jsonl")
    pre, post = [], []
    if os.path.exists(tp):
        for l in open(tp):
            e = json.loads(l)
            d = math.hypot(e["x"] - 120.0, e["z"] + 120.0)
            (pre if e["t"] < c["closed_t"] else post).append(d)
    res.setdefault("exile_compliance", []).append({
        "agent": key,
        "mean_dist_before": round(sum(pre) / len(pre), 1) if pre
        else None,
        "mean_dist_after": round(sum(post) / len(post), 1) if post
        else None,
        "min_dist_after": round(min(post), 1) if post else None,
        "samples_after": len(post)})

res["totals"] = {
    "acts": sum(v["acts"] for v in summary.values()),
    "says": sum(len(v) for v in says.values()),
    "deliberations": sum(v["deliberations"] for v in summary.values()),
    "visits_dead": sum(1 for v in summary.values() if v["visit_dead"]),
    "cases": len(trial["cases"]),
}
print(json.dumps(res, indent=1))
