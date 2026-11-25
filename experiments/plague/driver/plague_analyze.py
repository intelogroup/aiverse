#!/usr/bin/env python3
"""E12 Plague analyzer. Usage: plague_analyze.py <tag>"""
import glob
import json
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
tag = sys.argv[1]
R = os.path.join(ROOT, tag)

plague = json.load(open(os.path.join(R, "plague.json")))
summary = json.load(open(os.path.join(R, "summary.json")))
res = {"tag": tag, "transmissions": plague["transmissions"],
       "health_end": plague["health_end"],
       "doses_left": plague["doses_left"],
       "quarantine": plague["quarantine"]}

events = []
says = {}
state_changes = []
for p in sorted(glob.glob(os.path.join(R, "logs", "*.jsonl"))):
    k = os.path.basename(p)[:-6]
    for l in open(p):
        e = json.loads(l)
        kd = e.get("kind")
        if kd in ("diagnose_result", "treat_result",
                  "quarantine_declared"):
            events.append({"agent": k, "ts": e.get("ts"), **e})
        elif kd in ("exposed", "symptomatic", "recovered"):
            state_changes.append({"agent": k, "ts": e.get("ts"),
                                  "t": e.get("t"), "kind": kd,
                                  "source": e.get("from") or
                                  e.get("source")})
        elif kd == "say_sent" and e.get("text"):
            says.setdefault(k, []).append((e.get("ts"), e["text"]))
res["health_events"] = events
res["state_changes"] = sorted(state_changes,
                               key=lambda x: x["t"] or 0)

ILL = re.compile(r"cough|sick|ill|fever|grey|medicine|dose|"
                 r"quarantine|contag", re.I)
res["illness_talk"] = {k: [t for _, t in v if ILL.search(t)]
                       for k, v in says.items()}
res["cough_says"] = {k: sum(1 for _, t in v if "*cough*" in t)
                     for k, v in says.items()}

# quarantine compliance: declared agents' mean distance to the
# isolation point and to the crowd centroid while symptomatic
iso = (-24.21, -111.26)
comp = {}
for k in plague["quarantine"]:
    tp = os.path.join(R, "tracks", k + ".jsonl")
    ds = []
    if os.path.exists(tp):
        for l in open(tp):
            e = json.loads(l)
            s = e.get("self") or {}
            if "x" not in s:
                continue
            ds.append(math.hypot(s["x"] - iso[0], s["z"] - iso[1]))
    comp[k] = {"mean_dist_to_isolation": round(sum(ds) / len(ds), 1)
               if ds else None,
               "min_dist_to_isolation": round(min(ds), 1) if ds
               else None}
res["quarantine_compliance"] = comp

infected = {tr["to"] for tr in plague["transmissions"]}
res["totals"] = {
    "acts": sum(v["acts"] for v in summary.values()),
    "says": sum(len(v) for v in says.values()),
    "deliberations": sum(v["deliberations"] for v in summary.values()),
    "visits_dead": sum(1 for v in summary.values() if v["visit_dead"]),
    "ever_infected_beyond_zero": len(infected),
    "transmissions": len(plague["transmissions"]),
    "diagnoses": sum(1 for e in events
                     if e["kind"] == "diagnose_result" and e.get("ok")),
    "treatments": sum(1 for e in events
                      if e["kind"] == "treat_result" and e.get("ok")),
    "quarantines": len(plague["quarantine"]),
}
print(json.dumps(res, indent=1))
