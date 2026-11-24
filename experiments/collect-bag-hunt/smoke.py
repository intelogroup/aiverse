#!/usr/bin/env python3
"""Gates 3+4 smoke for the Collect+Bag hunt (local stack only).
fatima: spawn -> go_to egg-01 -> collect (board) -> play PickUp -> bag check.
deshawn: spawn -> go_to egg-01 -> collect attempt -> must be 'taken'.
fatima: go_to house-cabin-1 -> enter -> collect relic-sun (inside) -> bag.
Cleanup: DELETE both bodies, verify 404. Board here is a THROWAWAY
smoke board (own feed file); the real run board starts fresh."""
import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
COHORT = os.path.join(HERE, "cohort")
sys.path.insert(0, os.path.join(COHORT, "driver"))
from client import AgentClient  # noqa: E402
from board import Board  # noqa: E402

ITEMS = json.load(open(os.path.join(HERE, "items.json")))
FEED = os.path.join(HERE, "smoke-feed.jsonl")
if os.path.exists(FEED):
    os.remove(FEED)
board = Board(ITEMS, FEED)
sec = json.load(open(os.path.join(COHORT, "secrets.json")))


def act(c, action, wait_s=90):
    c.act_seq += 1
    aid = f"smoke-{c.name}-{c.act_seq:03d}-" \
        f"{action.get('type').replace('_', '-')}"[:80]
    post = c.call("POST", "/act", {"id": aid, "action": action})
    if post.status not in (200, 202):
        return {"outcome": f"post_{post.status}", "record": post.body}
    deadline = time.time() + wait_s
    while time.time() < deadline:
        r = c.call("GET", f"/act/{aid}?waitMs=10000", max_attempts=4)
        if r.status == 200 and isinstance(r.body, dict):
            a = r.body.get("act") if isinstance(r.body.get("act"), dict) \
                else r.body
            oc = a.get("outcome")
            if isinstance(oc, dict) and oc.get("status"):
                return {"outcome": oc["status"], "ok": oc.get("ok"),
                        "detail": str(oc.get("detail"))[:120]}
            if a.get("state") in ("settled", "complete", "completed"):
                return {"outcome": str(oc), "state": a.get("state")}
        time.sleep(0.4)
    return {"outcome": "timeout"}


def observe(c):
    r = c.observe()
    d = r.body.get("observation") or r.body
    return d if isinstance(d, dict) else {}


def pose(c):
    b = observe(c).get("body") or {}
    return b


def dist_to(c, x, z):
    b = pose(c)
    return math.hypot(b.get("x", 1e9) - x, b.get("z", 1e9) - z), b


def spawn(key, figure):
    c = AgentClient(sec["agents"][key]["agentToken"], 1, key,
                    lambda ev: None)
    post = c.call("POST", "/body", {"body": figure})
    print(f"{key}: spawn {post.status}")
    assert post.status in (200, 201), post.body
    return c


results = {}
fat = spawn("fatima", "summer")
egg = next(i for i in ITEMS if i["id"] == "egg-01")
r = act(fat, {"type": "go_to", "point": [egg["x"], egg["z"]]})
d, b = dist_to(fat, egg["x"], egg["z"])
print(f"fatima go_to egg-01: {r['outcome']}, dist={d:.2f}, pose={b.get('x')},{b.get('z')}")
assert d <= 2.5, "fatima not within collect radius of egg-01"
ok, reason = board.collect("fatima", "egg-01")
print(f"board collect fatima egg-01: {ok} {reason}")
assert ok
r = act(fat, {"type": "play", "clip": "PickUp"}, wait_s=45)
print(f"fatima play PickUp: {r}")
results["pickup_outcome"] = r["outcome"]
bag = board.bag("fatima")
print(f"fatima bag: {bag}")
assert bag and bag[0]["item"] == "egg-01"
results["gate3a"] = "fatima collected egg-01, PickUp played, bag shows it"

des = spawn("deshawn", "remy")
r = act(des, {"type": "go_to", "point": [egg["x"], egg["z"]]})
d, _ = dist_to(des, egg["x"], egg["z"])
ok, reason = board.collect("deshawn", "egg-01")
print(f"deshawn at egg-01 dist={d:.2f}; collect -> {ok} {reason}")
assert not ok and reason == "taken"
results["gate3b"] = "second collect of same item failed 'taken'"

# Gate 4: cabin chain with fatima -> relic-sun inside Stone Cabin
relic = next(i for i in ITEMS if i["id"] == "relic-sun")
r = act(fat, {"type": "go_to", "place": "house-cabin-1"})
print(f"fatima go_to house-cabin-1: {r['outcome']}")
r = act(fat, {"type": "enter", "place": "house-cabin-1"}, wait_s=60)
obs = observe(fat)
print(f"fatima enter: {r['outcome']}, insideRoom={obs.get('insideRoom')}")
assert obs.get("insideRoom") == "Stone Cabin", obs.get("insideRoom")
d, b = dist_to(fat, relic["x"], relic["z"])
if d > 2.5:
    r = act(fat, {"type": "go_to", "point": [relic["x"], relic["z"]]},
            wait_s=60)
    d, b = dist_to(fat, relic["x"], relic["z"])
print(f"fatima dist to relic-sun inside: {d:.2f}")
assert d <= 2.5
ok, reason = board.collect("fatima", "relic-sun")
print(f"board collect fatima relic-sun: {ok} {reason}")
assert ok
bag = board.bag("fatima")
print(f"fatima bag now: {bag}")
assert any(e["item"] == "relic-sun" and "Stone Cabin" in e["place"]
           for e in bag)
results["gate4"] = "cabin chain: go_to -> enter -> collect inside, place=Stone Cabin (inside)"

for key, c in (("fatima", fat), ("deshawn", des)):
    d = c.call("DELETE", "/body")
    chk = c.body()
    print(f"{key} cleanup: DELETE {d.status}, body after {chk.status}")
    results[f"cleanup_{key}"] = (d.status, chk.status)

print("SMOKE RESULT " + json.dumps(results))
json.dump(results, open(os.path.join(HERE, "smoke-result.json"), "w"),
          indent=1)
