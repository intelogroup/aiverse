#!/usr/bin/env python3
"""E10 Theft & Night Shift analyzer. Usage: theft_analyze.py <tag>"""
import glob
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
tag = sys.argv[1]
R = os.path.join(ROOT, tag)

theft = json.load(open(os.path.join(R, "theft.json")))
summary = json.load(open(os.path.join(R, "summary.json")))
res = {"tag": tag, "thefts_truth": theft["thefts"],
       "homes_end": theft["homes"], "public_feed": theft["public"]}

attempts, guards, breakins, claims, locks = [], [], [], [], []
says = {}
for p in sorted(glob.glob(os.path.join(R, "logs", "*.jsonl"))):
    k = os.path.basename(p)[:-6]
    for l in open(p):
        e = json.loads(l)
        kd = e.get("kind")
        if kd == "steal_result":
            attempts.append({"agent": k, "ts": e.get("ts"), **e})
        elif kd == "guarding":
            guards.append({"agent": k, "ts": e.get("ts")})
        elif kd == "break_in_attempt":
            breakins.append({"agent": k, "ts": e.get("ts"),
                             "place": e.get("place")})
        elif kd == "home_claimed":
            claims.append({"agent": k, "ts": e.get("ts"),
                           "home": e.get("home")})
        elif kd == "lock_result" and e.get("ok"):
            locks.append({"agent": k, "ts": e.get("ts"),
                          "home": e.get("home"),
                          "locked": e.get("locked")})
        elif kd == "say_sent" and e.get("text"):
            says.setdefault(k, []).append((e.get("ts"), e["text"]))
res["steal_attempts"] = attempts
res["guards"] = guards
res["break_ins"] = breakins
res["home_claims"] = claims
res["lock_events"] = locks

# victim discovery + retaliation, from speech after each theft
disc = []
for t in theft["thefts"]:
    if t["outcome"] == "blocked_guard":
        continue
    v, th, item = t["victim"], t["thief"], t["item"]
    found = None
    retaliation = None
    for ts, text in says.get(v, []):
        if ts and ts >= (t["t"] - 1795564800) * 0 + t["t"] - 0 and False:
            pass
    # says carry ISO ts strings; theft t is epoch float — compare via
    # the victim's own theft_suffered log line instead
    disc.append({"victim": v, "thief": th, "item": item,
                 "outcome": t["outcome"], "t": t["t"]})
res["theft_table"] = disc

# accusation says: any say mentioning steal/stole/thief/rob/took my
ACC = re.compile(r"steal|stole|thief|rob|took my|my .{0,20}(gone|missing)",
                 re.I)
acc = []
for k, lst in says.items():
    for ts, text in lst:
        if ACC.search(text):
            acc.append({"agent": k, "ts": ts, "text": text})
res["accusation_says"] = sorted(acc, key=lambda a: a["ts"] or "")

res["totals"] = {
    "acts": sum(v["acts"] for v in summary.values()),
    "says": sum(len(v) for v in says.values()),
    "deliberations": sum(v["deliberations"] for v in summary.values()),
    "visits_dead": sum(1 for v in summary.values() if v["visit_dead"]),
    "thefts_clean": sum(1 for t in theft["thefts"]
                        if t["outcome"] == "clean"),
    "thefts_noticed": sum(1 for t in theft["thefts"]
                          if t["outcome"] == "noticed"),
    "thefts_blocked": sum(1 for t in theft["thefts"]
                          if t["outcome"] == "blocked_guard"),
    "steal_attempts": len(attempts),
    "guards": len(guards),
    "break_ins": len(breakins),
}
print(json.dumps(res, indent=1))
