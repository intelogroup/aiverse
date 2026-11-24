#!/usr/bin/env python3
"""Clear the loose scenery standing where a placed house now stands.

Houses placed on an already landscaped block (edge ring, gardens) would have trees, bushes, rocks, benches or a gazebo poking through them. Every
scene-root node named like loose scenery (Tree_, ls_*, SK_*, Kit_ garden pieces, PartyCups) whose position lies inside a house footprint
(+MARGIN) leaves the scene. Footprints come from the house GLBs via districts.json (bridge_garden_block.house_footprints). Idempotent.
  python3 tools/city3/bridge_clear_footprints.py [world.glb] [--dry-run]
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
from bridge_garden_block import house_footprints
from bridge_wave1 import Glb, save_glb

LOOSE = ("Tree_", "ls_", "SK_", "Kit_garden", "Kit_orchard", "Kit_meadow", "Kit_commons", "Kit_grove", "PartyCups", "edge_kit", "Bush", "Rock")
MARGIN = 1.5


def inside(x, z, rects):
    return any(r[0] - MARGIN <= x <= r[2] + MARGIN and r[1] - MARGIN <= z <= r[3] + MARGIN for r in rects)


def run(path, dry):
    rects = [r for _, r in house_footprints().values()]
    g = Glb(path); j = g.gltf; scene = j["scenes"][j.get("scene", 0)]["nodes"]
    rem = [i for i in scene if j["nodes"][i].get("name", "").startswith(LOOSE) and "translation" in j["nodes"][i]
           and inside(j["nodes"][i]["translation"][0], j["nodes"][i]["translation"][2], rects)]
    print(json.dumps({"houses": len(rects), "loose_nodes_removed": len(rem), "sample": [j["nodes"][i]["name"] for i in rem[:6]]}))
    if dry or not rem:
        return
    for i in rem:
        scene.remove(i)
    print("wrote", path, save_glb(path, j, g.bin), "bytes")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("world", nargs="?", default="apps/console/public/assets/world-city3.glb"); ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    assert inside(1, 1, [(0, 0, 2, 2)]) and not inside(10, 10, [(0, 0, 2, 2)])
    run(a.world, a.dry_run)
