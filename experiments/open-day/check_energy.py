#!/usr/bin/env python3
"""Scripted energy checks against the live local stack, driving ONE
agent (fatima) through the real openday Agent.act path:
  1. walk (go_to) a measured distance -> energy drops by ~0.35/m
  2. run (run_to) a similar distance -> drop per metre > walk's
  3. sit on a seat -> energy regens over tracker ticks
  4. set energy to 3 (< EXHAUST_MIN) -> go_to returns
     outcome "exhausted_rest_needed" and the body does not move
Writes energy-check-result.json next to this script's run tag dir.
"""
import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.argv = ["openday.py", "--tag", "energycheck", "--duration", "30",
            "--keys", "fatima", "--items",
            os.path.join(ROOT, "..", "items_openday.json"),
            "--store", os.path.join(ROOT, "openday.db")]
import openday as od  # noqa: E402
from store import Store  # noqa: E402

RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append({"check": name, "pass": bool(cond), "detail": detail})
    print(("PASS " if cond else "FAIL ") + name + " " + detail, flush=True)


def pose(a):
    return (a.bb_snap()).get("pose") or {}


def settle(a, timeout=40):
    """Wait until the body stops moving (two reads 3 s apart < 0.2 m)."""
    last = None
    t0 = time.time()
    while time.time() - t0 < timeout:
        p = pose(a)
        if isinstance(p.get("x"), (int, float)):
            if last and math.hypot(p["x"] - last["x"],
                                   p["z"] - last["z"]) < 0.2:
                return p
            last = p
        time.sleep(3)
    return pose(a)


def main():
    od.STORE = Store(os.path.join(ROOT, "openday.db"))
    od.STORE.reset_energy(["fatima"])
    sec = json.load(open(os.path.join(ROOT, "secrets.json")))
    # places for targets
    from client import AgentClient
    probe = AgentClient(sec["agents"]["fatima"]["agentToken"], 90,
                        "probe", lambda ev: None)
    m = probe.places()
    data = m.body.get("places") or m.body.get("map") or []
    if isinstance(data, dict):
        data = data.get("places") or []
    od.PLACES = [p for p in data if isinstance(p, dict)]
    a = od.Agent("fatima", sec["agents"]["fatima"]["agentToken"], 1)
    post = a.c.call("POST", "/body", {"body": od.PICKS["fatima"]})
    check("spawn", post.status in (200, 201), f"status={post.status}")
    import threading
    deadline = time.time() + 600
    t = threading.Thread(target=a.tracker, args=(deadline,), daemon=True)
    t.start()
    for _ in range(30):
        if pose(a).get("x") is not None:
            break
        time.sleep(1)
    p0 = pose(a)
    check("pose known", isinstance(p0.get("x"), (int, float)), str(p0)[:120])

    def dist(p, q):
        return math.hypot(p["x"] - q["x"], p["z"] - q["z"])

    # --- 1. walk ---
    e0 = od.STORE.energy("fatima")
    target = None
    for p in od.PLACES:
        if isinstance(p.get("x"), (int, float)):
            d = math.hypot(p["x"] - p0["x"], p["z"] - p0["z"])
            if 15 < d < 60:
                target = p
                break
    if target is None:  # fall back to a raw point 25 m east
        rec = a.act({"type": "go_to",
                     "point": [p0["x"] + 25, p0["z"]]}, wait_s=90,
                    tag="walk-pt")
        d_walk = dist(p0, pose(a))
    else:
        rec = a.act({"type": "go_to", "place": target["id"]}, wait_s=120,
                    tag="walk")
        d_walk = dist(p0, pose(a))
    e1 = od.STORE.energy("fatima")
    drop_walk = e0 - e1
    check("walk moved", d_walk > 5, f"d={d_walk:.1f} outcome={rec['outcome']}")
    check("walk cost ~0.35/m", d_walk > 0 and
          0.15 < drop_walk / max(d_walk, 1) < 0.6,
          f"drop={drop_walk:.1f} per_m={drop_walk / max(d_walk, 1):.2f}")

    # --- 2. run back ---
    p1 = pose(a)
    rec = a.act({"type": "run_to",
                 "point": [p0["x"], p0["z"]]}, wait_s=120, tag="run")
    d_run = dist(p1, pose(a))
    e2 = od.STORE.energy("fatima")
    drop_run = e1 - e2
    check("run moved", d_run > 5, f"d={d_run:.1f} outcome={rec['outcome']}")
    check("run per-metre > walk per-metre", d_run > 0 and
          drop_run / max(d_run, 1) > drop_walk / max(d_walk, 1),
          f"run_per_m={drop_run / max(d_run, 1):.2f} "
          f"walk_per_m={drop_walk / max(d_walk, 1):.2f}")

    # --- 3. seated regen (measured from a drained state) ---
    od.STORE.set_energy("fatima", 50.0)
    seats = [s for s in (a.bb_snap()).get("seats") or []
             if s.get("state") in (None, "free")]
    if seats and seats[0].get("id"):
        a.act({"type": "sit", "sittable": seats[0]["id"]}, wait_s=45,
              tag="sit")
    else:
        a.act({"type": "go_to", "place": "shop-102"}, wait_s=120,
              tag="to-tea")
        a.act({"type": "enter", "place": "shop-102"}, wait_s=150,
              tag="enter-tea")
        for _ in range(10):
            if (a.bb_snap()).get("insideRoom"):
                break
            time.sleep(2)
        seats = [s for s in (a.bb_snap()).get("seats") or []
                 if s.get("state") in (None, "free")]
        if seats and seats[0].get("id"):
            a.act({"type": "sit", "sittable": seats[0]["id"]}, wait_s=45,
                  tag="sit2")
    settle(a, timeout=20)
    seated = pose(a).get("posture") == "sitting"
    check("seated", seated, f"posture={pose(a).get('posture')}")
    e3 = od.STORE.energy("fatima")
    time.sleep(13)  # ~3 tracker ticks
    e4 = od.STORE.energy("fatima")
    check("regen while seated", e4 > e3 + 2, f"{e3:.1f} -> {e4:.1f}")
    if seated:
        a.act({"type": "stand"}, wait_s=30, tag="stand")
        settle(a, timeout=20)

    # --- 4. exhaustion blocks movement ---
    settle(a)
    od.STORE.set_energy("fatima", 3.0)
    p_before = pose(a)
    rec = a.act({"type": "go_to",
                 "point": [p_before["x"] + 30, p_before["z"]]},
                wait_s=30, tag="should-block")
    time.sleep(5)
    p_after = pose(a)
    moved = dist(p_before, p_after) if p_before.get("x") is not None \
        and p_after.get("x") is not None else 99
    check("exhausted outcome", rec["outcome"] == "exhausted_rest_needed",
          f"outcome={rec['outcome']}")
    check("exhausted body did not move", moved < 1.5, f"moved={moved:.2f}")
    od.STORE.set_energy("fatima", 100.0)
    rec = a.act({"type": "go_to",
                 "point": [p_before["x"] + 6, p_before["z"]]},
                wait_s=60, tag="after-rest")
    check("movement works again after energy restored",
          rec["outcome"] in ("arrived", "done"),
          f"outcome={rec['outcome']}")

    a.stop_flag.set()
    a.c.call("POST", "/act", {"id": "s15-fatima-stop-ec",
                              "action": {"type": "stop"}})
    d = a.c.call("DELETE", "/body")
    out = {"results": RESULTS,
           "all_pass": all(r["pass"] for r in RESULTS)}
    with open(os.path.join(ROOT, "energycheck", "energy-check-result.json"),
              "w") as f:
        json.dump(out, f, indent=1)
    print("ALL_PASS" if out["all_pass"] else "SOME_FAILED", flush=True)
    return 0 if out["all_pass"] else 1


if __name__ == "__main__":
    os.makedirs(os.path.join(ROOT, "energycheck"), exist_ok=True)
    sys.exit(main())
