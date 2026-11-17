#!/usr/bin/env python3
"""SCRIPTED SIT REHEARSAL for retune-2 (Jim, 2026-11-14: swap the
radio for a sit). No brain, zero spend: provisions one agent through
the scripted test owner and flies the NEW E1 choreography scripted:

  spawn -> go_to tea house -> enter -> (seats perceivable inside?)
  -> sit -> prove SAT by the sim's own signals (act outcome status
  "seated" + observe body.posture "seated" + seatedOn)
  -> stand (outcome "stood", posture back to "standing")
  -> go_to the spawn drop point (stall-40) -> arrived.

Sit mechanics under test (packages/world-sim/src/actionProtocol.ts
ACTION_TYPES: sit "{sittable?}", stand "{}"; scout.ts: a bare sit
engages the nearest free sittable within SIT_ENGAGE_RANGE=30 m, the
body routes to its approach point, turns, and the act settles
{ok: true, status: "seated", target: <seat id>}).

Prints a JSON evidence object; exit 0 iff every check passes.
No secrets are printed (ids/names/counts only).
"""
import json
import os
import secrets
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "harness"))
from devowner import DevOwner
from world import WorldAdapter, resolve_places

BASE = os.environ.get("AIVERSE_GATEWAY_BASE", "http://localhost:3100")


def fly(world, act_id, intent, budget_s):
    t0 = time.time()
    status, _ = world.act(act_id, intent)
    final = world.poll_act(act_id, t0 + budget_s)
    return {"post_status": status, "seconds": round(time.time() - t0, 1),
            "state": final.get("state"), "outcome": final.get("outcome")}


def settled(leg):
    return (leg or {}).get("state") in ("settled", "done", "completed")


def outcome(leg):
    return (leg or {}).get("outcome") or {}


def main():
    ev = {"base": BASE, "legs": {}}
    owner = DevOwner(BASE)
    owner.ensure_owner()
    run_tag = f"sit-rehearsal-{secrets.token_hex(3)}"
    world = WorldAdapter(run_tag, base_url=BASE)
    info = owner.provision(world, run_tag)
    ev["agent_id"] = info["agent_id"]
    try:
        obs0 = world.attach()
        ev["spawn_pos"] = {k: obs0.get("body", {}).get(k)
                           for k in ("x", "z")}
        ev["spawn_nearest"] = obs0.get("nearestPlace")
        places = world.get_map()
        ev["place_count"] = len(places)
        resolved = resolve_places(places)
        tea, plaza = resolved["tea"], resolved["plaza"]
        ev["plaza_basis"] = "name" if plaza else None
        if plaza is None and ev["spawn_nearest"]:
            plaza = next((p for p in places
                          if p.get("id") == ev["spawn_nearest"]["id"]),
                         None)
            ev["plaza_basis"] = "spawn_nearest" if plaza else None
        ev["tea"] = tea
        ev["plaza"] = plaza

        ev["legs"]["go_tea"] = fly(
            world, "sitreh-go", {"type": "go_to", "place": tea["id"]},
            240)
        ev["legs"]["enter_tea"] = fly(
            world, "sitreh-enter", {"type": "enter",
                                    "place": tea["id"]}, 240)
        obs_in = world.observe()
        ev["inside_room"] = obs_in.get("insideRoom")
        ev["posture_inside"] = (obs_in.get("body") or {}).get("posture")
        seats = [e for e in (obs_in.get("scene") or [])
                 if isinstance(e, dict) and e.get("kind") == "seat"]
        ev["seats_perceived_inside"] = seats

        # Sit the way the task invites: name a perceived free seat,
        # else a bare sit (nearest free sittable within range).
        free = [s for s in seats if s.get("state") == "free"]
        sit_intent = {"type": "sit"}
        if free:
            sit_intent["sittable"] = free[0]["id"]
        ev["sit_intent"] = sit_intent
        ev["legs"]["sit"] = fly(world, "sitreh-sit", sit_intent, 180)
        obs_sat = world.observe()
        ev["posture_after_sit"] = (obs_sat.get("body") or {}).get(
            "posture")
        ev["seated_on"] = (obs_sat.get("body") or {}).get("seatedOn")

        ev["legs"]["stand"] = fly(
            world, "sitreh-stand", {"type": "stand"}, 60)
        obs_up = world.observe()
        ev["posture_after_stand"] = (obs_up.get("body") or {}).get(
            "posture")

        ev["legs"]["return"] = fly(
            world, "sitreh-return", {"type": "go_to",
                                     "place": plaza["id"]}, 300)
        obs_home = world.observe()
        ev["home_nearest"] = obs_home.get("nearestPlace")

        ev["checks"] = {
            "tea_is_shop_102": bool(tea) and tea["id"] == "shop-102",
            "plaza_resolves": plaza is not None,
            "go_tea_arrived": settled(ev["legs"]["go_tea"]) and
                outcome(ev["legs"]["go_tea"]).get("status")
                == "arrived",
            "enter_puts_body_inside": bool(ev["inside_room"]),
            "seat_perceivable_inside": len(seats) >= 1,
            "sit_settled_seated": settled(ev["legs"]["sit"]) and
                outcome(ev["legs"]["sit"]).get("ok") is True and
                outcome(ev["legs"]["sit"]).get("status") == "seated",
            "posture_seated_after_sit":
                ev["posture_after_sit"] == "seated",
            "seated_on_a_tea_seat":
                str(ev["seated_on"] or "").startswith("tea-"),
            "stand_settled_stood": settled(ev["legs"]["stand"]) and
                outcome(ev["legs"]["stand"]).get("status") == "stood",
            "posture_standing_after_stand":
                ev["posture_after_stand"] == "standing",
            "return_arrived": settled(ev["legs"]["return"]) and
                outcome(ev["legs"]["return"]).get("status")
                == "arrived" and
                outcome(ev["legs"]["return"]).get("target")
                == plaza["id"],
            "home_nearest_is_plaza":
                (ev["home_nearest"] or {}).get("id") == plaza["id"],
        }
        ev["verdict"] = all(ev["checks"].values())
    finally:
        try:
            world.detach()
        except Exception:
            pass
        owner.end_visit(info["agent_id"], info["visit_id"])
    print(json.dumps(ev, indent=1, default=str))
    return 0 if ev.get("verdict") else 1


if __name__ == "__main__":
    sys.exit(main())
