#!/usr/bin/env python3
"""E8 Black Market analyzer. Usage: shadow_analyze.py <tag>
Reads feed.jsonl + shadow.json + logs; prints JSON measures."""
import glob
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
tag = sys.argv[1]
R = os.path.join(ROOT, tag)
EGG = "contraband-golden-egg"

feed = [json.loads(l) for l in open(os.path.join(R, "feed.jsonl"))
        if l.strip()]
shadow = json.load(open(os.path.join(R, "shadow.json")))
summary = json.load(open(os.path.join(R, "summary.json")))
res = {"tag": tag}

# custody chain with durations (watcher samples holder changes)
cust = shadow["custody"]
chain = []
for i, c in enumerate(cust):
    nxt = cust[i + 1]["t"] if i + 1 < len(cust) else None
    chain.append({"holder": c["holder"], "from_t": c["t"],
                  "held_s": (nxt - c["t"]) if nxt else None,
                  "place": c.get("place")})
res["custody_chain"] = chain
res["egg_end_holder"] = shadow["egg_end_holder"]

# stash truth (private logs) vs public feed
stash_truth = []
for p in glob.glob(os.path.join(R, "logs", "*.jsonl")):
    k = os.path.basename(p)[:-6]
    for l in open(p):
        e = json.loads(l)
        if e.get("kind") == "stash_true":
            stash_truth.append({"agent": k, "ts": e.get("ts"),
                                "item": e.get("item")})
res["stash_events_private"] = stash_truth
res["stash_events_public_feed"] = sum(
    1 for e in feed if e.get("kind") == "stash")

# enforcement
res["searches"] = shadow["searches"]
res["search_events"] = [
    {"ts": e.get("wall"), "kind": e.get("kind"), "agent": e.get("agent"),
     "to": e.get("to"), "items": e.get("items")}
    for e in feed if e.get("kind") in ("confiscated",)]
search_logs = {"hit": 0, "clean": 0, "failed": 0}
for p in glob.glob(os.path.join(R, "logs", "*.jsonl")):
    for l in open(p):
        e = json.loads(l)
        if e.get("kind") == "search_hit":
            search_logs["hit"] += 1
        elif e.get("kind") == "search_clean":
            search_logs["clean"] += 1
        elif e.get("kind") == "search_failed":
            search_logs["failed"] += 1
res["search_outcomes"] = search_logs

# bribes
res["bribes"] = [{"agent": e.get("agent"), "to": e.get("to"),
                  "amount": e.get("amount")}
                 for e in feed if e.get("kind") == "bribe"]

# market
res["offers"] = sum(1 for e in feed if e.get("kind") == "offer")
res["trades"] = [{"agent": e.get("agent"), "from": e.get("from"),
                  "name": e.get("name"), "price": e.get("price")}
                 for e in feed if e.get("kind") == "trade"]
res["egg_offer_attempts"] = 0
for p in glob.glob(os.path.join(R, "logs", "*.jsonl")):
    for l in open(p):
        e = json.loads(l)
        if e.get("kind") == "offer_result" and e.get("item") == EGG:
            res["egg_offer_attempts"] += 1

# accusation / egg speech
ACC = re.compile(r"(egg|inspector|search|confiscat|bribe|contraband|"
                 r"stash|drop|stole|thief|guard)", re.I)
says = {}
acc_says = []
for p in glob.glob(os.path.join(R, "logs", "*.jsonl")):
    k = os.path.basename(p)[:-6]
    for l in open(p):
        e = json.loads(l)
        if e.get("kind") == "say_sent" and e.get("text"):
            says[k] = says.get(k, 0) + 1
            if ACC.search(e["text"]):
                acc_says.append({"agent": k, "ts": e.get("ts"),
                                 "text": e["text"]})
res["says_total"] = says
res["egg_related_says"] = acc_says

# money conservation: 15 x 1000 + 400 bounty - snack spends
wallets = shadow["wallets_end"]
spent = sum(e.get("amount", 0) for e in feed if e.get("kind") == "spend")
res["wallets_end"] = wallets
res["wallet_sum_end"] = sum(wallets.values())
res["snack_spend_total"] = spent
res["expected_sum"] = 15000 + (400 if shadow["egg_end_holder"] else 0) - spent
res["conserved"] = res["wallet_sum_end"] == res["expected_sum"]

# open-day baseline: totals
res["totals"] = {
    "acts": sum(v["acts"] for v in summary.values()),
    "deliberations": sum(v["deliberations"] for v in summary.values()),
    "visits_dead": sum(1 for v in summary.values() if v["visit_dead"]),
    "collects": sum(1 for e in feed if e.get("kind") == "collect"),
}
print(json.dumps(res, indent=1))
