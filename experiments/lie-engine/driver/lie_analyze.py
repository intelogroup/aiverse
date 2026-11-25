#!/usr/bin/env python3
"""E9 Lie Engine analyzer. Usage: lie_analyze.py <tag>"""
import glob
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
tag = sys.argv[1]
R = os.path.join(ROOT, tag)

CLOSED = re.compile(r"(tea house|teahouse|matchmaker).{0,40}(clos|shut|gone|dead)"
                    r"|(clos|shut).{0,30}(tea house|teahouse)", re.I)
OPEN = re.compile(r"(tea house|teahouse).{0,40}(open|fine|serving|not clos|"
                  r"still there)|not (clos|shut)", re.I)

claims = json.load(open(os.path.join(R, "claims.json")))
summary = json.load(open(os.path.join(R, "summary.json")))
res = {"tag": tag, "claims_board": claims}

# spread chain: every spoken or deliberated closure mention, timed
chain = []
says_total = {}
for p in sorted(glob.glob(os.path.join(R, "logs", "*.jsonl"))):
    k = os.path.basename(p)[:-6]
    for l in open(p):
        e = json.loads(l)
        if e.get("kind") == "say_sent" and e.get("text"):
            says_total[k] = says_total.get(k, 0) + 1
            if CLOSED.search(e["text"]):
                chain.append({"agent": k, "ts": e.get("ts"),
                              "via": "say", "text": e["text"]})
            elif OPEN.search(e["text"]):
                chain.append({"agent": k, "ts": e.get("ts"),
                              "via": "correction", "text": e["text"]})
        if e.get("kind") == "deliberation":
            say = ((e.get("intent") or {}).get("say") or "")
            if CLOSED.search(say):
                chain.append({"agent": k, "ts": e.get("ts"),
                              "via": "deliberation",
                              "intent": (e.get("intent") or {}).get("intent"),
                              "text": say})
chain.sort(key=lambda c: c["ts"] or "")
res["closure_chain"] = chain
res["agents_who_repeated_closure"] = sorted(
    {c["agent"] for c in chain if c["via"] in ("say", "deliberation")})
res["corrections"] = [c for c in chain if c["via"] == "correction"]

# vouch / accuse events
va = []
for p in sorted(glob.glob(os.path.join(R, "logs", "*.jsonl"))):
    k = os.path.basename(p)[:-6]
    for l in open(p):
        e = json.loads(l)
        if e.get("kind") in ("vouch_result", "accuse_result"):
            va.append({"agent": k, "ts": e.get("ts"), "kind": e["kind"],
                       "to": e.get("to"), "ok": e.get("ok"),
                       "result": e.get("result")})
res["vouch_accuse_events"] = va

# checking: who entered the tea house (insideRoom) during the run
checked = {}
for p in sorted(glob.glob(os.path.join(R, "tracks", "*.jsonl"))):
    k = os.path.basename(p)[:-6]
    n = 0
    first = None
    for l in open(p):
        e = json.loads(l)
        if e.get("insideRoom") == "Matchmaker's Tea House":
            n += 1
            if first is None:
                first = e.get("ts")
    if n:
        checked[k] = {"samples_inside": n, "first": first}
res["tea_house_visitors"] = checked

res["totals"] = {
    "acts": sum(v["acts"] for v in summary.values()),
    "says": sum(says_total.values()),
    "deliberations": sum(v["deliberations"] for v in summary.values()),
    "visits_dead": sum(1 for v in summary.values() if v["visit_dead"]),
    "claims_posted": len(claims),
}
print(json.dumps(res, indent=1))
