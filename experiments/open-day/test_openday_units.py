#!/usr/bin/env python3
"""Open-Day unit checks (stack-free): energy math, XP ledger, bag
persistence across a full store reopen, conversation window, board
restore round-trip."""
import json
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import Store  # noqa: E402
from board import Board  # noqa: E402

fails = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        fails.append(name)


# --- energy cost ratios, read from openday.py source (it arg-parses on
# import, so parse the constants instead of importing) ---
src = open(os.path.join(HERE, "openday.py")).read()
cpm = dict(re.findall(r'"(go_to|run_to|drive)": ([\d.]+)', src.split("COST_PER_M = ")[1].split("}")[0]))
walk, drive, run = float(cpm["go_to"]), float(cpm["drive"]), float(cpm["run_to"])
check("run cost == 2x walk", abs(run - 2 * walk) < 1e-9)
check("walk < drive < run", walk < drive < run)
check("no action_cap outcome anywhere in openday.py",
      "action_cap" not in src)
check("exhausted outcome present", "exhausted_rest_needed" in src)
check("EXHAUST_MIN gate present", "EXHAUST_MIN = 5.0" in src)

tmp = tempfile.mkdtemp()
db = os.path.join(tmp, "t.db")
s = Store(db)

# --- energy behaviour through the store ---
s.reset_energy(["mara"])
check("energy starts 100", s.energy("mara") == 100.0)
d = 40.0  # metres
s.add_energy("mara", -walk * d)
e_walk = s.energy("mara")
s.reset_energy(["mara"])
s.add_energy("mara", -run * d)
check("run drains faster than walk over same distance",
      s.energy("mara") < e_walk)
s.reset_energy(["mara"])
s.add_energy("mara", -1000)
check("energy clamps at 0", s.energy("mara") == 0.0)
s.add_energy("mara", 3.5)  # one seated regen tick
check("seated regen adds", abs(s.energy("mara") - 3.5) < 1e-9)
s.add_energy("mara", 1000)
check("energy clamps at 100", s.energy("mara") == 100.0)

# --- XP ledger ---
s.add_xp("mara", "collect", 10, 10, "egg-01")
s.add_xp("mara", "conversation", 8, 8, "with sam")
tot = s.xp_of("mara")
check("xp accumulates", tot == {"xp": 18, "score": 18})
bysrc = s.xp_by_source("mara")
check("xp by source", bysrc.get("collect") == (1, 10)
      and bysrc.get("conversation") == (1, 8))

# --- visited: first time only ---
check("first visit is new", s.mark_visited("mara", "hall-0") is True)
check("second visit not new", s.mark_visited("mara", "hall-0") is False)

# --- conversation window: once per pair per window, order-free ---
check("conv award first", s.try_award_conversation("mara", "sam") is True)
check("conv award blocked in window",
      s.try_award_conversation("sam", "mara") is False)
check("conv award other pair ok",
      s.try_award_conversation("mara", "yuki") is True)

# --- bag persistence: board -> store -> full reopen -> restore ---
items = json.load(open(os.path.join(HERE, "..", "..", "items_openday.json")))
feed = os.path.join(tmp, "feed.jsonl")
b = Board(items, feed, os.path.join(tmp, "board_state.json"))
ok, _ = b.collect("fatima", "egg-01")
check("board collect ok", ok)
ok, _ = b.collect("fatima", "power-keycard")
check("board collect keycard ok", ok)
s.save_bags({k: b.bag(k) for k in ("fatima", "sam")})
before = s.bag_of("fatima")
s.close()

s2 = Store(db)  # full restart: new process-side object, same DB file
after = s2.bag_of("fatima")
check("bag identical after reopen",
      [e["item"] for e in after] == [e["item"] for e in before]
      == ["egg-01", "power-keycard"])
check("xp survives reopen", s2.xp_of("mara") == {"xp": 18, "score": 18})

# restore into a fresh board the way openday.main does
b2 = Board(items, feed, None)
for k, entries in s2.load_bags().items():
    for e in entries:
        it = b2.items.get(e["item"])
        if it and it["state"] == "available":
            it["state"] = "held"
            it["holder"] = k
            it["foundPlace"] = e.get("place")
            it["foundT"] = e.get("t")
            b2.bags.setdefault(k, []).append(e)
check("restored board bag matches",
      [e["item"] for e in b2.bag("fatima")] == ["egg-01", "power-keycard"])
check("restored item marked held",
      b2.items["egg-01"]["state"] == "held"
      and b2.items["egg-01"]["holder"] == "fatima")
ok, reason = b2.collect("sam", "egg-01")
check("restored item cannot be re-collected", not ok and reason == "taken")
s2.close()

print("FAILURES:", fails if fails else "none")
sys.exit(1 if fails else 0)
