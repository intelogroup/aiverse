#!/usr/bin/env python3
"""Hedge the yard blocks' street edges, a gate gap wherever a yard walk reaches the street (the inner-block twin of bridge_ring_frontage.py).

For each yard block (bridge_garden_block.GARDENS with yard=True and houses), a 0.85 m hedge runs 0.1 m inside every edge of the block rect, cut
2.4 m wide opposite each house on every side. Hedges reuse the lawn's Leafy Grass texture,
darker, and get collision. Idempotent (extras mark). Rebake the navmesh afterwards.
  python3 tools/city3/bridge_yard_hedges.py [world.glb] [collision.glb] [--dry-run]
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
import bridge_garden_block as gb
from bridge_bazaar_open_space import G, MATS, Builder, emit
from bridge_garden_block import col_mesh
from bridge_wave1 import Glb, save_glb

MARK = "yard_hedges_pass"
HEDGE_H, HEDGE_D, GATE = 0.85, 0.6, 2.4
MATS.setdefault("hedge", ((0.2, 0.38, 0.12), 0.95, 0, None))


def layout():
    b = Builder(); col = []; done = []
    for name, g in gb.GARDENS.items():
        if not g.get("yard"):
            continue
        gb.use(name); houses = gb.house_rects()
        if not houses:
            continue
        X0, Z0, X1, Z1 = gb.X0, gb.Z0, gb.X1, gb.Z1
        gates = {"W": [], "E": [], "N": [], "S": []}
        # a gate on every side opposite each house: with gates only where the yard walk exits, a house whose walk side is blocked (the
        # cabin's deck overhangs the block edge) was reachable only by a long detour and go_to timed out (verse-sim reachability test)
        for hx0, hz0, hx1, hz1 in houses:
            cx, cz = (hx0 + hx1) / 2, (hz0 + hz1) / 2
            for side in "WE":
                gates[side].append(cz)
            for side in "NS":
                gates[side].append(cx)
        for side in "WENS":
            along_x = side in "NS"
            lo, hi = (X0, X1) if along_x else (Z0, Z1)
            line = {"W": X0, "E": X1, "N": Z0, "S": Z1}[side]; inward = {"W": 1, "E": -1, "N": 1, "S": -1}[side]
            h0, h1 = sorted((line + inward * 0.1, line + inward * (0.1 + HEDGE_D)))
            cuts = sorted([lo + 0.8] + [x - GATE / 2 for x in gates[side]] + [x + GATE / 2 for x in gates[side]] + [hi - 0.8])
            for s, e in zip(cuts[0::2], cuts[1::2]):
                if e - s < 0.5:
                    continue
                if along_x:
                    b.box("hedge", s, e, h0, h1, G, G + HEDGE_H, uv=2.0); col.append((s, e, h0, h1, G, G + HEDGE_H))
                else:
                    b.box("hedge", h0, h1, s, e, G, G + HEDGE_H, uv=2.0); col.append((h0, h1, s, e, G, G + HEDGE_H))
        done.append(name)
    return b, col, done


def run(world, colp, dry):
    b, col, done = layout()
    print(json.dumps({"yards": done, "hedge_boxes": len(col)}))
    if dry:
        return
    w, c = Glb(world), Glb(colp); j = w.gltf
    if j.get("extras", {}).get(MARK):
        print({"already": True}); return
    cache = {}
    def mats(k):
        if k not in cache:
            col_, r, mt, _ = MATS[k]
            j["materials"].append({"name": "BzYard_" + k, "pbrMetallicRoughness": {"baseColorFactor": [*col_[:3], 1], "metallicFactor": mt, "roughnessFactor": r}})
            cache[k] = len(j["materials"]) - 1
        return cache[k]
    emit(w, j, b, "BzYardHedges", mats)
    tex = {im.get("name"): ti for ti, t in enumerate(j.get("textures", [])) for im in [j["images"][t["source"]]] if "source" in t}
    if "leafy_grass_diff" in tex and "hedge" in cache:
        tt = {"KHR_texture_transform": {"scale": [3.0, 3.0]}}
        m = j["materials"][cache["hedge"]]
        m["pbrMetallicRoughness"].update({"baseColorTexture": {"index": tex["leafy_grass_diff"], "extensions": tt}, "baseColorFactor": [0.32, 0.62, 0.25, 1.0]})
        if "leafy_grass_nor" in tex:
            m["normalTexture"] = {"index": tex["leafy_grass_nor"], "scale": 1.0, "extensions": tt}
    col_mesh(c, col, "col_yard_hedges")
    j.setdefault("extras", {})[MARK] = True
    print("wrote", world, save_glb(world, j, w.bin), "bytes"); print("wrote", colp, save_glb(colp, c.gltf, c.bin), "bytes")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("world", nargs="?", default="apps/console/public/assets/world-city3.glb")
    ap.add_argument("collision", nargs="?", default="apps/console/public/assets/world-city3-collision.glb")
    ap.add_argument("--dry-run", action="store_true"); a = ap.parse_args()
    run(a.world, a.collision, a.dry_run)
