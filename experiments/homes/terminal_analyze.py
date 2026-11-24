#!/usr/bin/env python3
"""E2b terminal analyzer. Usage: terminal_analyze.py <phase_dir>
Reads logs/ + homes.json; writes terminal_analysis.json.
Measures: terminal uses (who/query/result/title), Pavilion entries by
non-owners (from pose tracks), and information spread: distinctive
title tokens (len>=6) appearing in later say lines — by the querier
(firsthand report) or by others (secondhand spread)."""
import json
import os
import re
import sys

KEYS = ["mara", "deshawn", "ingrid", "tomas", "priya", "kenji", "fatima",
        "oleg", "lucia", "amara", "henrik", "yuki", "rafael", "ngozi", "sam"]
STOP = {"pavilion", "cabin", "the", "house", "about", "verse", "terminal"}


def load_jsonl(path):
    out = []
    if os.path.exists(path):
        for line in open(path):
            try:
                out.append(json.loads(line))
            except Exception:
                pass
    return out


def main():
    d = sys.argv[1]
    uses, says = [], []
    for k in KEYS:
        for e in load_jsonl(os.path.join(d, "logs", k + ".jsonl")):
            if e.get("kind") == "terminal_use":
                uses.append({"agent": k, "t": e["t"], "query": e.get("query"),
                             "result": e.get("result"),
                             "title": e.get("title")})
            elif e.get("kind") == "say_sent":
                says.append({"agent": k, "t": e["t"],
                             "text": e.get("text") or ""})
    says.sort(key=lambda s: s["t"])

    spread = []
    for u in uses:
        if u["result"] != "ok" or not u["title"]:
            continue
        tokens = [w.lower() for w in re.findall(r"[A-Za-z]{6,}", u["title"])
                  if w.lower() not in STOP]
        if not tokens:
            continue
        for s in says:
            if s["t"] <= u["t"]:
                continue
            low = s["text"].lower()
            hit = [t for t in tokens if t in low]
            if hit:
                spread.append({
                    "token": hit, "from_query_by": u["agent"],
                    "title": u["title"], "speaker": s["agent"],
                    "secondhand": s["agent"] != u["agent"],
                    "text": s["text"][:120],
                    "delay_s": round(s["t"] - u["t"])})

    pavilion_entries = {}
    for k in KEYS:
        ticks = [e for e in load_jsonl(os.path.join(d, "tracks", k + ".jsonl"))
                 if e.get("kind") == "pose"]
        n, prev = 0, None
        for e in ticks:
            room = e.get("insideRoom")
            if room == "Zen Tea Pavilion" and prev != room:
                n += 1
            prev = room
        if n:
            pavilion_entries[k] = n

    homes = {}
    hp = os.path.join(d, "homes.json")
    if os.path.exists(hp):
        homes = {cid: v["owner"]
                 for cid, v in json.load(open(hp)).items()}
    out = {"terminal_uses": uses,
           "uses_ok": sum(1 for u in uses if u["result"] == "ok"),
           "unique_users": sorted({u["agent"] for u in uses}),
           "pavilion_entries": pavilion_entries,
           "spread_events": spread,
           "secondhand_spread": sum(1 for s in spread if s["secondhand"]),
           "owners": homes}
    with open(os.path.join(d, "terminal_analysis.json"), "w") as f:
        json.dump(out, f, indent=1)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
