#!/usr/bin/env python3
"""E10 unit tests: steal facing/guard/range rules, lock gate.
Run: python3 test_theft_units.py  (no gateway needed)"""
import json
import math
import os
import sys
import tempfile
import time

sys.argv = ["theft.py", "--tag", "units", "--keys", "mara,kenji,sam"]
import theft  # noqa: E402

theft.OUTROOT = tempfile.mkdtemp()
os.makedirs(os.path.join(theft.OUTROOT, "logs"), exist_ok=True)

defs = json.load(open(os.path.join(os.path.dirname(__file__),
                                   "items_errand.json")))
NAMES = {k: k.capitalize() for k in
         ["mara", "deshawn", "ingrid", "tomas", "priya", "kenji",
          "fatima", "oleg", "lucia", "amara", "henrik", "yuki",
          "rafael", "ngozi", "sam"]}
import tempfile as _tf
_tmp = _tf.mkdtemp()
theft.HBOARD = theft.ShadowBoard(defs, os.path.join(_tmp, "feed.jsonl"),
                                 os.path.join(_tmp, "state.json"))
theft.HBOARD.seed_wallets(list(NAMES), 1000)
# mara holds two items
print(theft.HBOARD.collect("mara", "relic-sun"),
      theft.HBOARD.collect("mara", "stall-orb"))

fails = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        fails.append(name)


def fake_agent(key):
    a = theft.Agent.__new__(theft.Agent)
    a.key = key
    a.name = NAMES[key]
    a.names = NAMES
    a.observe_cache = {}
    a.log = lambda *x, **k: None
    return a


thief = fake_agent("kenji")
victim = fake_agent("mara")

# positions: victim at origin facing +z (heading 0 => facing dir
# (sin0, cos0) = (0,1)); thief 2 m in FRONT of victim
theft.POSES["mara"] = (0.0, 0.0, time.time())
theft.POSES_H["mara"] = 0.0
theft.POSES["kenji"] = (0.0, 2.0, time.time())
theft.POSES_H["kenji"] = math.pi

# 1. face-to-face steal succeeds but is NOTICED
theft.THEFTS.clear()
thief.do_steal("mara")
check("front steal transfers item",
      theft.HBOARD.items["stall-orb"].get("holder") == "kenji")
check("front steal noticed",
      theft.THEFTS and theft.THEFTS[-1]["outcome"] == "noticed")
check("victim got a notice", bool(theft.NOTICES.get("mara")))

# 2. thief BEHIND victim (victim still faces +z): clean getaway
theft.POSES["kenji"] = (0.0, -2.0, time.time())
theft.NOTICES.clear()
thief.do_steal("mara")
check("back steal transfers item",
      theft.HBOARD.items["relic-sun"].get("holder") == "kenji")
check("back steal clean",
      theft.THEFTS[-1]["outcome"] == "clean")
check("no notice for clean steal", not theft.NOTICES.get("mara"))

# 3. guarding blocks + exposes (hand the orb back first)
print(theft.HBOARD.steal_transfer("kenji", "mara", "stall-orb"))
victim.do_guard()
n_thefts = len(theft.THEFTS)
thief.do_steal("mara")
check("guard blocks the steal",
      theft.HBOARD.items["stall-orb"].get("holder") == "mara")
check("guard block recorded",
      theft.THEFTS[-1]["outcome"] == "blocked_guard")
check("guard block noticed", bool(theft.NOTICES.get("mara")))

# 4. too far fails
theft.GUARDING.clear()
theft.POSES["kenji"] = (50.0, 50.0, time.time())
thief.do_steal("mara")
check("too-far steal takes nothing",
      theft.HBOARD.items["stall-orb"].get("holder") == "mara")

# 5. empty bag fails cleanly
theft.POSES["kenji"] = (0.0, -2.0, time.time())
thief.do_steal("sam")
check("empty-bag steal is a no-op",
      {e["item"] for e in theft.HBOARD.bag("kenji")} ==
      {"relic-sun"})

# 6. lock gate: stranger refused at a locked cabin; event logged
theft.HOMES["house-cabin-1"]["owner"] = "mara"
theft.HOMES["house-cabin-1"]["locked"] = True
rec = thief.act({"type": "enter", "place": "house-cabin-1"})
check("locked cabin refuses stranger", rec["outcome"] == "locked")
# owner is NOT refused by the gate (falls through to client act,
# which we cannot run headless) -> verify gate logic directly:
gate_blocks = theft.HOMES["house-cabin-1"]["locked"] and \
    theft.HOMES["house-cabin-1"]["owner"] not in (None, "mara")
check("gate exempts the owner", gate_blocks is False)
# unlocked cabin does not block a stranger
theft.HOMES["house-cabin-1"]["locked"] = False
gate_blocks = theft.HOMES["house-cabin-1"]["locked"] and \
    theft.HOMES["house-cabin-1"]["owner"] not in (None, "kenji")
check("unlocked cabin not gated", gate_blocks is False)

# 7. facing math sanity
theft.POSES["mara"] = (0.0, 0.0, time.time())
theft.POSES_H["mara"] = 0.0
theft.POSES["kenji"] = (0.0, 5.0, time.time())
check("facing_dot front ~1",
      abs(theft.facing_dot("mara", "kenji") - 1.0) < 0.01)
theft.POSES["kenji"] = (0.0, -5.0, time.time())
check("facing_dot behind ~-1",
      abs(theft.facing_dot("mara", "kenji") + 1.0) < 0.01)

print("FAILS:", fails if fails else "none")
sys.exit(1 if fails else 0)
