#!/usr/bin/env python3
"""Line the edge-ring streets with trees: a row behind each ring block's hedge, every ~11 m, clear of the gates and the houses.

Tree-lined residential streets are the cue that turns a row of lots into a street. Trees are clones of the world's own Tree_packtree_a/b/c nodes
(as the garden passes do), 2 m inside the hedge line (bridge_ring_frontage.py), skipped within 2.5 m of a walk gate or 2 m of a house footprint;
each gets a 0.5 m trunk collision box. Idempotent (extras mark). Rebake the navmesh afterwards.
  python3 tools/city3/bridge_ring_trees.py [world.glb] [collision.glb] [--dry-run]
"""
import argparse
import copy
import json
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
from bridge_bazaar_open_space import G
from bridge_garden_block import col_mesh, house_footprints
from bridge_ring_frontage import plan_blocks
from bridge_wave1 import Glb, save_glb

MARK = "ring_trees_pass"
SPACING, INSET, GATE_CLEAR, HOUSE_CLEAR = 11.0, 2.0, 2.5, 2.0


def layout(seed=7311):
    rnd = random.Random(seed); blocks, fp = plan_blocks(), house_footprints(); out = []
    by_block = {}
    for hid, (_, r) in fp.items():
        if hid.startswith("house-ring-"):
            ij = hid.split("-")[2]; by_block.setdefault((int(ij[0]), int(ij[1])), []).append(r)
    for (i, j), houses in by_block.items():
        x0, z0, x1, z1 = blocks[(i, j)]
        side = "W" if i == 0 else "E" if i == 5 else "N" if j == 0 else "S"
        along_x = side in "NS"
        line = {"W": x1, "E": x0, "N": z0, "S": z1}[side]; inward = {"W": -1, "E": 1, "N": 1, "S": -1}[side]
        gates = [((h[0] + h[2]) / 2 if along_x else (h[1] + h[3]) / 2) for h in houses]
        lo, hi = (x0, x1) if along_x else (z0, z1)
        a = lo + 3.0
        while a <= hi - 3.0:
            p = (a, line + inward * (0.7 + INSET)) if along_x else (line + inward * (0.7 + INSET), a)
            x, z = (p[0], p[1]) if along_x else (p[0], p[1])
            if all(abs(a - g) > GATE_CLEAR for g in gates) and not any(h[0] - HOUSE_CLEAR < x < h[2] + HOUSE_CLEAR and h[1] - HOUSE_CLEAR < z < h[3] + HOUSE_CLEAR for h in houses):
                out.append((x + rnd.uniform(-0.4, 0.4), z + rnd.uniform(-0.4, 0.4), rnd.choice(("Tree_packtree_a", "Tree_packtree_b", "Tree_packtree_c"))))
            a += SPACING
    return out


def run(world, colp, dry):
    trees = layout(); print(json.dumps({"trees": len(trees)}))
    if dry:
        return
    w, c = Glb(world), Glb(colp); j = w.gltf
    if j.get("extras", {}).get(MARK):
        print({"already": True}); return
    scene = j["scenes"][j.get("scene", 0)]["nodes"]
    tmpl = {n["name"]: n for n in j["nodes"] if n.get("name", "").startswith("Tree_packtree_") and "." not in n["name"]}
    tmpl = tmpl or {n["name"].split(".")[0]: n for n in j["nodes"] if n.get("name", "").startswith("Tree_packtree_")}
    boxes = []
    for k, (x, z, nm) in enumerate(trees):
        n = copy.deepcopy(tmpl.get(nm) or next(iter(tmpl.values())))
        n["name"] = f"{nm}.ring{k}"; n["translation"] = [x, G, z]; n["rotation"] = [0, math.sin(k), 0, math.cos(k)]
        j["nodes"].append(n); scene.append(len(j["nodes"]) - 1)
        boxes.append((x - .25, x + .25, z - .25, z + .25, G, G + 3))
    col_mesh(c, boxes, "col_ring_trees")
    j.setdefault("extras", {})[MARK] = True
    print("wrote", world, save_glb(world, j, w.bin), "bytes"); print("wrote", colp, save_glb(colp, c.gltf, c.bin), "bytes")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("world", nargs="?", default="apps/console/public/assets/world-city3.glb")
    ap.add_argument("collision", nargs="?", default="apps/console/public/assets/world-city3-collision.glb")
    ap.add_argument("--dry-run", action="store_true"); a = ap.parse_args()
    run(a.world, a.collision, a.dry_run)
