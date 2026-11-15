#!/usr/bin/env python3
"""ROUTE PROBE for E2-forced calibration (scripted, $0, no LLM).

Modes:
  map              provision an agent, attach, print the live map's
                   places (id/name/kind/room) as JSON.
  route <place_id> drive the E2F chain WALKING: spawn -> tea house
                   (go_to, enter, sit, stand) -> <place_id> (go_to)
                   -> spawn-nearest place (go_to), timing every act
                   (POST to terminal settle) and recording the body
                   position at each arrival. Prints a JSON evidence
                   object. Used to pick stop 2 and size the route
                   before the calibration rehearsals.

No secrets are printed (tokens stay in .secrets via the adapter).
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "harness"))
from devowner import DevOwner
from world import WorldAdapter, resolve_places

BASE = os.environ.get("AIVERSE_GATEWAY_BASE", "http://localhost:3100")


def _pos(obs):
    body = (obs or {}).get("body") or {}
    return {"x": body.get("x"), "z": body.get("z"),
            "posture": body.get("posture"),
            "inside": (obs or {}).get("insideRoom")}


def _timed_act(world, seq, intent, cap_s=600):
    act_id = f"e2fprobe-{world.run_id}-{seq}"
    t0 = time.time()
    status, _act = world.act(act_id, intent)
    if status not in (200, 201, 202):
        return {"intent": intent, "http": status,
                "seconds": round(time.time() - t0, 2), "final": None}
    final = world.poll_act(act_id, t0 + cap_s)
    return {"intent": intent, "http": status,
            "seconds": round(time.time() - t0, 2),
            "final": {"state": final.get("state"),
                      "outcome": final.get("outcome")}}


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "map"
    owner = DevOwner(BASE)
    owner.ensure_owner()
    run_id = f"e2fprobe-{mode}-{int(time.time()) % 100000}"
    world = WorldAdapter(run_id, base_url=BASE)
    prov = owner.provision(world, run_id)
    try:
        obs = world.attach()
        places = world.get_map()
        if mode == "map":
            print(json.dumps(
                {"places": places, "attach_pos": _pos(obs)}, indent=1))
            return 0
        candidate = sys.argv[2]
        resolved = resolve_places(places)
        tea = resolved["tea"]
        spawn_nearest = (obs.get("nearestPlace") or {}).get("id")
        ev = {"candidate": candidate, "tea": tea,
              "spawn_nearest": spawn_nearest,
              "attach_pos": _pos(obs), "legs": []}
        seq = 0
        steps = [
            {"type": "go_to", "place": tea["id"]},
            {"type": "enter", "place": tea["id"]},
            {"type": "sit"},
            {"type": "stand"},
            {"type": "go_to", "place": candidate},
            {"type": "go_to", "place": spawn_nearest},
        ]
        for intent in steps:
            seq += 1
            leg = _timed_act(world, seq, intent)
            leg["pos_after"] = _pos(world.observe())
            ev["legs"].append(leg)
        ev["total_seconds"] = round(sum(l["seconds"] for l in ev["legs"]), 2)
        print(json.dumps(ev, indent=1, default=str))
        return 0
    finally:
        try:
            world.detach()
        except Exception:
            pass
        try:
            owner.end_visit(prov["agent_id"], prov["visit_id"])
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
