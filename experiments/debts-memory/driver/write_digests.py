#!/usr/bin/env python3
"""E6: write Session-A memory digests (Session-1 schema + debts_text)
from a loans.py run dir into a memory dir Session B will load.
Usage: write_digests.py <run_dir> <out_memory_dir>
Fidelity: every open board debt must appear, with matching amount or
item, in BOTH parties' debts_text — checked before exit."""
import json
import os
import sys

RUN = sys.argv[1]
OUT = sys.argv[2]
os.makedirs(OUT, exist_ok=True)
summary = json.load(open(os.path.join(RUN, "summary.json")))
loans = json.load(open(os.path.join(RUN, "loans.json")))
debts = [d for d in loans.get("debts") or [] if not d.get("repaid")]
trades = loans.get("trades") or []

NAMES = {}
for line in open(os.path.join(RUN, "feed.jsonl")):
    pass  # names come from the items/board where needed

said_by = {}
logs_dir = os.path.join(RUN, "logs")
for fn in os.listdir(logs_dir):
    key = fn[:-6]
    said = []
    for line in open(os.path.join(logs_dir, fn)):
        e = json.loads(line)
        if e.get("kind") == "say_sent" and e.get("text"):
            said.append(e["text"])
    said_by[key] = said

problems = []
for key, s in summary.items():
    met = set(s.get("greeted") or [])
    for d in debts:
        if d["from"] == key:
            met.add(d["to"])
        if d["to"] == key:
            met.add(d["from"])
    for t in trades:
        if t.get("agent") == key:
            met.add(t.get("from"))
    my_debts = []
    for d in debts:
        what = (f"{d['remaining']} credits" if d["kind"] == "credits"
                else f"the {d['name']}")
        if d["to"] == key:
            my_debts.append(f"You owe {d['from']} {what}.")
        elif d["from"] == key:
            my_debts.append(f"{d['to']} owes you {what}.")
    debts_text = ""
    if my_debts:
        debts_text = ("Debts you carry from last time: "
                      + " ".join(my_debts))
    lent = sum(1 for d in (loans.get("debts") or []) if d["from"] == key)
    borrowed = sum(1 for d in (loans.get("debts") or [])
                   if d["to"] == key)
    episode = (
        f"I spent a market day in the verse. I visited "
        f"{len(s.get('visited') or [])} place(s): "
        f"{', '.join((s.get('visited') or [])[:6]) or 'none'}. "
        f"I met {len(met)} named agent(s): "
        f"{', '.join(sorted(met)) or 'none'}. I said "
        f"{s.get('says', 0)} line(s) and heard {s.get('heard', 0)}. "
        f"I made {lent} loan(s) and took {borrowed}.")
    digest = {
        "agent": f"s15-{key}", "key": key, "session": 2,
        "date": "2026-11-24",
        "met": {k: k for k in sorted(met)},
        "said": said_by.get(key, [])[:5],
        "heard": [],
        "places": s.get("visited") or [],
        "distance_m": s.get("distance_m", 0),
        "episode": episode,
        "debts_text": debts_text,
        "debts_open": [d for d in debts
                       if d["from"] == key or d["to"] == key],
    }
    with open(os.path.join(OUT, key + ".json"), "w") as f:
        json.dump(digest, f, indent=1)

# ---- fidelity check: board truth vs digest text ----
for d in debts:
    what = (f"{d['remaining']} credits" if d["kind"] == "credits"
            else f"the {d['name']}")
    for party, fragment in ((d["to"], f"You owe {d['from']} {what}"),
                            (d["from"], f"{d['to']} owes you {what}")):
        txt = json.load(open(os.path.join(OUT, party + ".json")))
        if fragment not in (txt.get("debts_text") or ""):
            problems.append((d["id"], party, fragment))
print(f"digests written: {len(summary)}; open debts: {len(debts)}; "
      f"fidelity problems: {len(problems)}")
for p in problems:
    print("FIDELITY MISS:", p)
sys.exit(1 if problems else 0)
