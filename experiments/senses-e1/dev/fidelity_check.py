#!/usr/bin/env python3
"""WORLD FIDELITY GATE for the dev-local rig (plan: the E1 pilot may
only run on a world that matches production facts on record).

Provisions one agent through the scripted test owner (register ->
claim -> full-size visit) and flies the E1 errand SCRIPTED (no
brain), checking the LOCAL world against the production facts
verified 2026-11-10/14:

  * /world/map returns 158 places
  * the harness's resolution lands on shop-102, "Matchmaker's Tea
    House" (room "tea") — not a "Today's Tea" decoy
  * the sim resolves the bare query "tea" to shop-102, exactly as
    the Nov 10 production flight did
  * go_to settles as arrived (navmesh present); enter puts the body
    inside the tea room
  * the world's only interactable, tea-radio, can be interacted
    with from inside and is perceivable at its stand point
  * the return leg to the spawn-area place (the plan's "plaza drop
    point" — the real map has no plaza-named place) settles arrived

Prints a JSON evidence object with per-leg seconds; exit 0 iff
every check passes. No secrets are printed (ids/names/counts only).
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


def main():
    ev = {"base": BASE, "legs": {}}
    owner = DevOwner(BASE)
    owner.ensure_owner()
    # Agent names are unique gateway-wide; every probe gets a fresh
    # one (the e1 runner's run ids already carry random suffixes).
    run_tag = f"fidelity-{secrets.token_hex(3)}"
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
        ev["tea_match_count"] = len(resolved["tea_matches"])

        ev["legs"]["go_tea_query"] = fly(
            world, "fid-go", {"type": "go_to", "place": "tea"}, 240)
        ev["legs"]["enter_tea"] = fly(
            world, "fid-enter", {"type": "enter", "place": tea["id"]},
            180)
        obs_in = world.observe()
        ev["inside_room"] = obs_in.get("insideRoom")
        ev["legs"]["interact_radio"] = fly(
            world, "fid-radio", {"type": "interact",
                                 "target": "tea-radio"}, 180)
        obs_radio = world.observe()
        radio = [e for e in (obs_radio.get("scene") or [])
                 if isinstance(e, dict) and e.get("id") == "tea-radio"]
        ev["radio_after_interact"] = radio
        ev["legs"]["return"] = fly(
            world, "fid-return", {"type": "go_to",
                                  "place": plaza["id"]}, 300)
        obs_home = world.observe()
        ev["home_nearest"] = obs_home.get("nearestPlace")

        def arrived(leg, target=None):
            o = (leg or {}).get("outcome") or {}
            return leg.get("state") in ("settled", "done", "completed") \
                and o.get("status") == "arrived" \
                and (target is None or o.get("target") == target)

        ev["checks"] = {
            "place_count_is_158": len(places) == 158,
            "tea_is_shop_102": bool(tea) and tea["id"] == "shop-102",
            "plaza_resolves": plaza is not None,
            "sim_resolves_tea_to_shop_102": arrived(
                ev["legs"]["go_tea_query"], "shop-102"),
            "enter_puts_body_inside": bool(ev["inside_room"]),
            "interact_radio_ok": (
                ev["legs"]["interact_radio"].get("state") in
                ("settled", "done", "completed") and
                ((ev["legs"]["interact_radio"].get("outcome") or {})
                 .get("ok") is not False)),
            "radio_perceivable_at_stand": len(radio) >= 1,
            "return_arrived": arrived(ev["legs"]["return"],
                                      plaza["id"]),
            "home_nearest_is_plaza": (
                (ev["home_nearest"] or {}).get("id") == plaza["id"]),
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
