#!/usr/bin/env python3
"""Diagnostic: why did tamper staging see no free seat inside the
tea house? Provision one agent, go + enter, then dump the scene
across repeated observes, a look, and a face turn. No brain, no
spend, no secrets printed."""
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


def scene_dump(obs, label):
    body = obs.get("body", {}) or {}
    scene = obs.get("scene") or []
    kinds = {}
    seats = []
    for e in scene:
        if isinstance(e, dict):
            kinds[e.get("kind")] = kinds.get(e.get("kind"), 0) + 1
            if e.get("kind") == "seat":
                seats.append({k: e.get(k) for k in
                              ("id", "state", "distance")})
    return {"label": label,
            "inside": obs.get("insideRoom"),
            "posture": body.get("posture"),
            "x": body.get("x"), "z": body.get("z"),
            "heading": body.get("heading"),
            "gaze": body.get("gaze"),
            "scene_kinds": kinds, "seats": seats}


def main():
    ev = {}
    owner = DevOwner(BASE)
    owner.ensure_owner()
    tag = f"staging-diag-{secrets.token_hex(3)}"
    world = WorldAdapter(tag, base_url=BASE)
    info = owner.provision(world, tag)
    try:
        world.attach()
        places = world.get_map()
        tea = resolve_places(places)["tea"]
        ev["tea"] = tea["id"]
        ev["go"] = fly(world, "diag-go",
                       {"type": "go_to", "place": tea["id"]}, 240)
        ev["enter"] = fly(world, "diag-enter",
                          {"type": "enter", "place": tea["id"]}, 240)
        dumps = []
        dumps.append(scene_dump(world.observe(), "observe-1"))
        time.sleep(3)
        dumps.append(scene_dump(world.observe(), "observe-2"))
        view = world.look()
        vobs = view.get("observation") if isinstance(view, dict) \
            else None
        if vobs:
            dumps.append(scene_dump(vobs, "look"))
        dumps.append(scene_dump(world.observe(), "observe-3"))
        # Turn around in place (face the opposite heading) and look.
        body = (dumps[-1] or {})
        ev["face"] = fly(world, "diag-face",
                         {"type": "face", "headingDeg": 180}, 60)
        dumps.append(scene_dump(world.observe(), "observe-after-face"))
        ev["dumps"] = dumps
    finally:
        try:
            world.detach()
        except Exception:
            pass
        owner.end_visit(info["agent_id"], info["visit_id"])
    print(json.dumps(ev, indent=1, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
