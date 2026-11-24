#!/usr/bin/env python3
"""E8 Black Market unit tests: board contraband rules + driver search."""
import json
import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.argv = ["shadow.py", "--tag", "shadowunit", "--keys", "oleg,sam,mara",
            "--duration", "10"]
import shadow as sh  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + f" {detail}")
    if not ok:
        fails.append(name)


items = json.load(open(os.path.join(HERE, "items_shadow.json")))
tmp = tempfile.mkdtemp()
b = sh.ShadowBoard(items, os.path.join(tmp, "feed.jsonl"),
                   os.path.join(tmp, "state.json"))
b.seed_wallets(["oleg", "sam", "mara", "yuki"], 1000)
EGG = sh.EGG

# mara collects the egg + a relic
print(b.collect("mara", EGG), b.collect("mara", "relic-sun"))
check("collect egg", b.items[EGG]["holder"] == "mara")

# bazaar refuses the egg three ways
ok, r = b.post_offer("mara", EGG, 800)
check("offer egg refused", not ok and r == "contraband_refused", r)
ok, r = b.give("mara", "yuki", EGG)
check("give egg refused", not ok and r == "contraband_refused", r)
b.offers["of-x"] = {"id": "of-x", "seller": "mara", "item": EGG,
                    "name": "Golden Egg", "price": 800, "t": 0}
ok, r = b.buy("yuki", "of-x")
check("buy egg refused", not ok and r == "contraband_refused", r)

# normal market still works + credits move
ok, r = b.post_offer("mara", "relic-sun", 300)
oid = r
ok, r = b.buy("yuki", oid)
check("normal trade settles", ok and b.items["relic-sun"]["holder"] == "yuki"
      and b.wallet("yuki") == 700 and b.wallet("mara") == 1300,
      f"{r} wallets yuki={b.wallet('yuki')} mara={b.wallet('mara')}")

# stash: unattributed feed, item lands at the drop, another collects
ok, r = b.stash("mara", EGG, sh.DROP[0], sh.DROP[1])
feed = open(os.path.join(tmp, "feed.jsonl")).read()
stash_lines = [l for l in feed.splitlines() if '"stash"' in l]
check("stash works + feed unattributed",
      ok and b.items[EGG]["state"] == "available"
      and stash_lines and "mara" not in stash_lines[-1],
      stash_lines[-1][:110] if stash_lines else "no stash line")
ok, r = b.collect("yuki", EGG)
check("another collects from drop", ok and b.items[EGG]["holder"] == "yuki")

# bribe: instant, flagged, conserved
ok, r = b.bribe("yuki", "oleg", 200)
check("bribe transfers", ok and b.wallet("yuki") == 500
      and b.wallet("oleg") == 1200, r)
ok, r = b.bribe("yuki", "oleg", 99999)
check("bribe insufficient refused", not ok, r)

# confiscate: whole bag home, egg back in the open
taken = b.confiscate("yuki", "oleg")
check("confiscation takes whole bag",
      set(taken) == {"relic-sun", EGG} and b.bag("yuki") == []
      and b.items[EGG]["state"] == "available"
      and b.items[EGG]["x"] == 16.5, f"taken={taken}")

# spend (snacks) draws the same wallet
check("spend ok", b.spend("mara", 30, "snack:snack-bun")
      and b.wallet("mara") == 1270)
check("spend insufficient", not b.spend("mara", 99999, "snack:x"))

# driver-level search: range + inspector-only + hit confiscates
sh.HBOARD = b
b.collect("mara", EGG)
sh.POSES["oleg"] = (0.0, 0.0, time.time())
sh.POSES["mara"] = (2.0, 0.0, time.time())
sh.POSES["sam"] = (100.0, 100.0, time.time())


class FakeAgent(sh.Agent.__mro__[1]):  # object-ish shell w/o __init__
    pass


def bare_agent(key):
    a = object.__new__(sh.Agent)
    a.key = key
    return a


a = bare_agent("oleg")
check("search hit confiscates", a.do_search("mara") is True
      and b.bag("mara") == [] and sh.SEARCHES["oleg"] == 1)
b.collect("mara", EGG)
a2 = bare_agent("sam")
check("search out of range refused", a2.do_search("mara") is False
      and sh.SEARCHES["sam"] == 0 and b.items[EGG]["holder"] == "mara")
a3 = bare_agent("mara")
check("non-inspector search refused", a3.do_search("oleg") is False)
sh.POSES["sam"] = (1.0, 0.0, time.time())
check("search clean when no egg on target",
      bare_agent("sam").do_search("oleg") is True
      and sh.SEARCHES["sam"] == 1)

print("UNIT", "ALL PASS" if not fails else f"FAILURES: {fails}")
sys.exit(1 if fails else 0)
