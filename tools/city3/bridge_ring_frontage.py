#!/usr/bin/env python3
"""Give the edge-ring houses a front: a stone walk from each house to its lot line and a low hedge along the street side of each ring block.

A house standing alone on a lawn reads as dropped there; a walk to the street and a hedge line with a gate gap make it a lot (the cue every good
stylized suburb uses). Ring houses come from districts.json (house-ring-<i><j>-<n>, ring_houses.py) with footprints from their GLBs; the street side
of block (i, j) is +x for i=0, -x for i=5, -z for j=0, +z otherwise. Hedges reuse the lawn's embedded Leafy Grass texture (bridge_lawn_texture.py),
darker, and get collision boxes. Idempotent (extras mark).
  python3 tools/city3/bridge_ring_frontage.py [world.glb] [collision.glb] [--dry-run]
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
from bridge_bazaar_open_space import G, MATS, Builder, emit
from bridge_garden_block import col_mesh, house_footprints
from bridge_wave1 import Glb, save_glb

MARK = "ring_frontage_pass"
WALK, HEDGE_H, HEDGE_D, GATE = 1.6, 0.85, 0.6, 2.4
MATS.setdefault("hedge", ((0.2, 0.38, 0.12), 0.95, 0, None))


def plan_blocks():
    return {(b["i"], b["j"]): (b["inner"][0], -b["inner"][3], b["inner"][2], -b["inner"][1]) for b in json.load(open(os.path.join(HERE, "plan.json")))["blocks"]}


def layout():
    blocks, fp = plan_blocks(), house_footprints()
    b = Builder(); col = []
    by_block = {}
    for hid, (_, r) in fp.items():
        if hid.startswith("house-ring-"):
            ij = hid.split("-")[2]; by_block.setdefault((int(ij[0]), int(ij[1])), []).append(r)
    for (i, j), houses in by_block.items():
        x0, z0, x1, z1 = blocks[(i, j)]
        side = "W" if i == 0 else "E" if i == 5 else "N" if j == 0 else "S"   # the block's street side, toward the city
        along_x = side in "NS"
        line = {"W": x1, "E": x0, "N": z0, "S": z1}[side]; inward = {"W": -1, "E": 1, "N": 1, "S": -1}[side]
        gates = []
        for hx0, hz0, hx1, hz1 in houses:
            c = (hx0 + hx1) / 2 if along_x else (hz0 + hz1) / 2
            face = {"W": hx1, "E": hx0, "N": hz0, "S": hz1}[side]
            a0, a1 = sorted((face, line))
            if along_x:
                b.box("stone", c - WALK / 2, c + WALK / 2, a0, a1, G + .03, G + .07, uv=1.5)
            else:
                b.box("stone", a0, a1, c - WALK / 2, c + WALK / 2, G + .03, G + .07, uv=1.5)
            gates.append(c)
        # the hedge runs the length of the street side, a gate gap at each walk
        lo, hi = (x0, x1) if along_x else (z0, z1)
        cuts = sorted([lo + 0.5] + [g - GATE / 2 for g in gates] + [g + GATE / 2 for g in gates] + [hi - 0.5])
        h0, h1 = sorted((line + inward * 0.1, line + inward * (0.1 + HEDGE_D)))
        for s, e in zip(cuts[0::2], cuts[1::2]):
            if e - s < 0.5:
                continue
            if along_x:
                b.box("hedge", s, e, h0, h1, G, G + HEDGE_H, uv=2.0); col.append((s, e, h0, h1, G, G + HEDGE_H))
            else:
                b.box("hedge", h0, h1, s, e, G, G + HEDGE_H, uv=2.0); col.append((h0, h1, s, e, G, G + HEDGE_H))
    return b, col, len(by_block)


def run(world, colp, dry):
    b, col, n = layout()
    print(json.dumps({"ring_blocks": n, "quads": sum(len(d["P"]) // 4 for d in b.q.values()), "hedge_boxes": len(col)}))
    if dry:
        return
    w, c = Glb(world), Glb(colp); j = w.gltf
    if j.get("extras", {}).get(MARK):
        print({"already": True}); return
    cache = {}
    def mats(k):
        if k not in cache:
            col_, r, mt, _ = MATS[k]
            j["materials"].append({"name": "BzRing_" + k, "pbrMetallicRoughness": {"baseColorFactor": [*col_[:3], 1], "metallicFactor": mt, "roughnessFactor": r}})
            cache[k] = len(j["materials"]) - 1
        return cache[k]
    emit(w, j, b, "BzRing", mats)
    # hedges wear the lawn's leafy texture, darker and denser
    tex = {im.get("name"): ti for ti, t in enumerate(j.get("textures", [])) for im in [j["images"][t["source"]]] if "source" in t}
    if "leafy_grass_diff" in tex and "hedge" in cache:
        tt = {"KHR_texture_transform": {"scale": [3.0, 3.0]}}
        m = j["materials"][cache["hedge"]]
        m["pbrMetallicRoughness"].update({"baseColorTexture": {"index": tex["leafy_grass_diff"], "extensions": tt}, "baseColorFactor": [0.32, 0.62, 0.25, 1.0]})
        if "leafy_grass_nor" in tex:
            m["normalTexture"] = {"index": tex["leafy_grass_nor"], "scale": 1.0, "extensions": tt}
    col_mesh(c, col, "col_ring_hedges")
    j.setdefault("extras", {})[MARK] = True
    print("wrote", world, save_glb(world, j, w.bin), "bytes"); print("wrote", colp, save_glb(colp, c.gltf, c.bin), "bytes")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("world", nargs="?", default="apps/console/public/assets/world-city3.glb")
    ap.add_argument("collision", nargs="?", default="apps/console/public/assets/world-city3-collision.glb")
    ap.add_argument("--dry-run", action="store_true"); a = ap.parse_args()
    run(a.world, a.collision, a.dry_run)
