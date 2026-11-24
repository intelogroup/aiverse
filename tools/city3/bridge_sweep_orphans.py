#!/usr/bin/env python3
"""Sweep the leftovers of demolished buildings out of the shipped world GLB.

The demolition and edge-landscape passes cut facade triangles inside each footprint, but shutters, roof tiles, cornices and the bunting strung
between facades live in other merged meshes and were left hanging in the air (seen live 2026-11-24: pennants and shutters up to 24 m over lawns).
Every identity-transform mesh triangle is dropped when its centroid is above the height for its mesh family and outside every KEEP rect (the
buildings still standing, and the plaza with its string lights): Props above 6.0 m (street lamps top out near 5.3 m), building-only families
(shutters, roofs, facades, awnings, blade signs) above 3.0 m. Bytes stay until bridge_compact.py --drop-dead. Rebake the navmesh afterwards.
  python3 tools/city3/bridge_sweep_orphans.py [world.glb] [--dry-run]
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
from bridge_landscape_kit import add_accessor, add_view
from bridge_wave1 import Glb, save_glb

KEEP = {   # GLB x0, z0, x1, z1 (+1 m margin where a facade sits on the rect edge)
    "plaza": (-60, -60, 60, 60),               # clock tower, fountain, stalls, string lights
    "tea_house": (-41, -88, -9, -69),           # Tea House 102 (interiors/index.json rect + 3.5 m)
    "troyes_hall": (15.5, -119.5, 54.5, -75.5),  # Kit_hall0, plan rect [16.5, 76.5, 53.5, 118.5]
}
FAMILY = {"Props": 6.0}
BUILDING = ("Shutters", "RoofFlat", "RoofTile", "B_Facade_", "Awnings", "BladeSigns", "Cornice", "Balcon")


def floor_for(name):
    if name in FAMILY:
        return FAMILY[name]
    return 3.0 if name.startswith(BUILDING) else None


def keep_mask(c):
    k = np.zeros(len(c), bool)
    for x0, z0, x1, z1 in KEEP.values():
        k |= (c[:, 0] > x0) & (c[:, 0] < x1) & (c[:, 2] > z0) & (c[:, 2] < z1)
    return k


def run(path, dry):
    g = Glb(path); j = g.gltf; rep = {}
    for n in j["nodes"]:
        name = n.get("name", ""); y0 = floor_for(name)
        if y0 is None or "mesh" not in n or any(k in n for k in ("translation", "rotation", "scale", "matrix")):
            continue
        for p in j["meshes"][n["mesh"]]["primitives"]:
            if "indices" not in p:
                continue
            P = g.acc_raw(p["attributes"]["POSITION"]); I = g.indices_of(p).reshape(-1, 3); c = P[I].mean(1)
            kill = (c[:, 1] > y0) & ~keep_mask(c)
            if kill.any():
                rep[name] = rep.get(name, 0) + int(kill.sum())
                if not dry:
                    keep = I[~kill].astype("<u4").ravel()
                    if not len(keep):
                        keep = np.zeros(3, "<u4")
                    p["indices"] = add_accessor(g, add_view(g, keep.tobytes(), 34963), 5125, len(keep), "SCALAR")
    print(json.dumps({"dropped_tris": rep}))
    if not dry:
        print("wrote", path, save_glb(path, j, g.bin), "bytes")


def selftest():
    c = np.array([[0, 10, 0], [100, 10, 100], [-25, 10, -80]], float)
    assert keep_mask(c).tolist() == [True, False, True]
    assert floor_for("Props") == 6.0 and floor_for("B_Facade_sand") == 3.0 and floor_for("Tree_x") is None
    print("selftest ok")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("world", nargs="?", default="apps/console/public/assets/world-city3.glb")
    ap.add_argument("--dry-run", action="store_true"); ap.add_argument("--selftest", action="store_true"); a = ap.parse_args()
    selftest() if a.selftest else run(a.world, a.dry_run)
