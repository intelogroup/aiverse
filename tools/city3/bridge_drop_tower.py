#!/usr/bin/env python3
"""Remove a plan tower (plan.py `towers`) from the shipped world and collision GLBs.

Towers have no node of their own: their triangles are merged into B_Facade_*, roofs, shutters, Props and col_buildings. Every triangle of an
identity-transform mesh whose centroid lies in the tower rect (+0.3 m) is dropped (drop_tris, as the demolish pass does); bytes stay until
bridge_compact.py --drop-dead. Idempotent through the extras mark. Rebake the navmesh afterwards.
  python3 tools/city3/bridge_drop_tower.py minaret [--dry-run]      (repo root)
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from bridge_bazaar_demolish import drop_tris
from bridge_wave1 import Glb, save_glb

TOWERS = {"minaret": (93.5, 93.5, 101.5, 101.5)}   # GLB x0, z0, x1, z1 (plan rect [93.5,-101.5,101.5,-93.5], z = -plan y); stood in the citadel block
MARK = "dropped_towers"


def run(path, name, dry):
    g = Glb(path); j = g.gltf; marks = j.setdefault("extras", {}).setdefault(MARK, [])
    if name in marks: print({os.path.basename(path): "already"}); return
    R = {name: TOWERS[name]}; rep = {}
    for n in j["nodes"]:
        if "mesh" not in n or any(k in n for k in ("translation", "rotation", "scale", "matrix")): continue
        for p in j["meshes"][n["mesh"]]["primitives"]:
            if "indices" not in p: continue
            before = j["accessors"][p["indices"]]["count"]
            if not dry: drop_tris(g, p, R)
            after = j["accessors"][p["indices"]]["count"]
            if after != before: rep[n.get("name", "?")] = (before - after) // 3
    print({os.path.basename(path): rep})
    if dry: return
    marks.append(name); print("wrote", path, save_glb(path, j, g.bin), "bytes")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("tower", choices=sorted(TOWERS)); ap.add_argument("--dry-run", action="store_true"); a = ap.parse_args()
    A = "apps/console/public/assets"
    for f in ("world-city3.glb", "world-city3-collision.glb"): run(os.path.join(A, f), a.tower, a.dry_run)
