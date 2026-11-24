#!/usr/bin/env python3
"""Shade the market square: tree allées along its two cross avenues and a tree row round its rim, each tree in a wood-chip pit.

The 120 m plaza was a stone floor with 80 stalls in four blocks and nothing standing between them; a European market square reads as one
because of its tree rows. Allées at x = +-13.4 and z = +-13.4 (the axis avenues' kerbs are at 10 and cars drive them; stall blocks start 15 m out), every 8 m, clear of
the fountain (r_out 10); the rim row 2.5 m inside the plaza edge, every 9 m, clear of the four street entries. Trees are clones of the
world's Tree_packtree nodes (one species, a formal row) with a 0.5 m trunk box; pits reuse BzGround_bed (bridge_house_grounds.py).
Idempotent (extras mark). Rebake the navmesh afterwards.
  python3 tools/city3/bridge_plaza_trees.py [world.glb] [collision.glb] [--dry-run]
"""
import argparse
import copy
import json
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
from bridge_bazaar_open_space import G, Builder, emit
from bridge_garden_block import col_mesh
from bridge_wave1 import Glb, save_glb

MARK = "plaza_trees_pass"
TREE = "Tree_packtree_c"
ALLEE, STEP, RIM, RIM_STEP, PIT = 13.4, 8.0, 57.5, 9.0, 1.4   # the axis avenues (plan streets c 0, w 20) cross the plaza: kerbs at +-10


def layout():
    plan = json.load(open(os.path.join(HERE, "plan.json")))
    fr = plan["fountain"]["r_out"] + 4.0
    stalls = [(s["c"][0] - s["size"][0] / 2, -s["c"][1] - s["size"][1] / 2, s["c"][0] + s["size"][0] / 2, -s["c"][1] + s["size"][1] / 2) for s in plan["stalls"]]
    lamps = [(l[0], -l[1]) for l in plan["lamps"]]
    pts = []
    a = fr
    while a <= 56.0:
        for s in (-1, 1):
            pts += [(ALLEE, s * a), (-ALLEE, s * a), (s * a, ALLEE), (s * a, -ALLEE)]
        a += STEP
    a = -RIM + 4.0
    while a <= RIM - 4.0:
        if abs(a) > 14.0:   # the avenues enter on the axes (a rim tree at 9.5 stood in the mouth: apps/sim drive tests caught it)
            pts += [(a, RIM), (a, -RIM), (RIM, a), (-RIM, a)]
        a += RIM_STEP
    ok = lambda x, z: not any(r[0] - 1.0 < x < r[2] + 1.0 and r[1] - 1.0 < z < r[3] + 1.0 for r in stalls) and not any((x - lx) ** 2 + (z - lz) ** 2 < 2.0 ** 2 for lx, lz in lamps)
    out = []
    for x, z in dict.fromkeys(pts):
        if ok(x, z):
            out.append((x, z))
    return out


def run(world, colp, dry):
    trees = layout(); print(json.dumps({"trees": len(trees)}))
    if dry:
        return
    w, c = Glb(world), Glb(colp); j = w.gltf
    if j.get("extras", {}).get(MARK):
        print({"already": True}); return
    scene = j["scenes"][j.get("scene", 0)]["nodes"]
    tmpl = next(n for n in j["nodes"] if n.get("name", "").startswith(TREE) and "mesh" in n)
    rnd = random.Random(4471); b = Builder(); boxes = []
    for k, (x, z) in enumerate(trees):
        n = copy.deepcopy(tmpl); a = rnd.uniform(0, 2 * math.pi); s = rnd.uniform(.92, 1.08)
        n["name"] = f"{TREE}.plaza{k}"; n["translation"] = [x, G, z]; n["rotation"] = [0, math.sin(a / 2), 0, math.cos(a / 2)]
        n["scale"] = [v * s for v in tmpl.get("scale", [1, 1, 1])]
        j["nodes"].append(n); scene.append(len(j["nodes"]) - 1)
        b.box("bed", x - PIT / 2, x + PIT / 2, z - PIT / 2, z + PIT / 2, G + .03, G + .08, uv=1.5)
        boxes.append((x - .25, x + .25, z - .25, z + .25, G, G + 3))
    bed = next(i for i, m in enumerate(j["materials"]) if m.get("name") == "BzGround_bed")
    emit(w, j, b, "BzPlazaTreePits", lambda k: bed)
    col_mesh(c, boxes, "col_plaza_trees")
    j.setdefault("extras", {})[MARK] = True
    print("wrote", world, save_glb(world, j, w.bin), "bytes"); print("wrote", colp, save_glb(colp, c.gltf, c.bin), "bytes")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("world", nargs="?", default="apps/console/public/assets/world-city3.glb")
    ap.add_argument("collision", nargs="?", default="apps/console/public/assets/world-city3-collision.glb")
    ap.add_argument("--dry-run", action="store_true"); a = ap.parse_args()
    run(a.world, a.collision, a.dry_run)
