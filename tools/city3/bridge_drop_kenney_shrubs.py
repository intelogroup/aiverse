#!/usr/bin/env python3
"""Drop the Kenney Nature Kit shrubs (flat-coloured low-poly bushes, flowers and rocks) from the edge-ring landscape.

bridge_landscape_kit.py scattered ls_bush/ls_flower/ls_rock under the Landscape_edge_* groups; next to the prebuilt houses and the scanned clock
tower they read as low-poly (user, 2026-11-24: delete low-poly builds). The trees (LIB_hero meshes), stone paths and ground stay. Idempotent.
  python3 tools/city3/bridge_drop_kenney_shrubs.py [world.glb] [--dry-run]
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
from bridge_wave1 import Glb, save_glb

DROP = ("ls_bush", "ls_flower", "ls_rock")

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("world", nargs="?", default="apps/console/public/assets/world-city3.glb"); ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    g = Glb(a.world); j = g.gltf; n = 0
    for grp in j["nodes"]:
        if not grp.get("name", "").startswith("Landscape_edge") or "children" not in grp:
            continue
        keep = [c for c in grp["children"] if not j["nodes"][c].get("name", "").startswith(DROP)]
        n += len(grp["children"]) - len(keep)
        if not a.dry_run:
            grp["children"] = keep
    print({"shrub_nodes_dropped": n})
    if n and not a.dry_run:
        print("wrote", a.world, save_glb(a.world, j, g.bin), "bytes")
