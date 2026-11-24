#!/usr/bin/env python3
"""Remove the low-poly cone planters (details.planter: a stone box with three green cone 'trees' and flower triangles) baked into Props.

Found by shape, not position: a connected Props piece (vertices merged by position) whose footprint is a 0.9 m or 1.4 m square (a rim adds 0.08 m)
and which stands 0.5-0.7 m tall from the walk level is a planter box; every Props triangle inside that square (+5 cm) up to 0.85 m over its rim goes
with it (soil, cones, flowers). The Tea House frontage keeps its own. Bytes stay until bridge_compact.py --drop-dead.
  python3 tools/city3/bridge_drop_planters.py [world.glb] [--dry-run]
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
from bridge_landscape_kit import add_accessor, add_view
from bridge_wave1 import Glb, save_glb

KEEP = [(-41, -88, -9, -69)]   # Tea House frontage (interiors rect + 3.5 m)
SIZES = (0.9, 0.98, 1.4, 1.48)


def components(P, I):
    q = np.round(P * 1000).astype(np.int64); _, vid = np.unique(q, axis=0, return_inverse=True); vid = vid.ravel()
    parent = np.arange(vid.max() + 1)
    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]; a = parent[a]
        return a
    T = vid[I]
    for a, b, c in T:
        ra = find(a); parent[find(b)] = ra; parent[find(c)] = ra
    roots = np.array([find(v) for v in range(len(parent))])
    pos = np.zeros((len(parent), 3)); pos[vid] = P
    comp = {}
    for v in np.unique(T.ravel()):
        comp.setdefault(roots[v], []).append(v)
    return [pos[vs] for vs in comp.values()]


def planter_rects(P, I):
    out = []
    for V in components(P, I):
        lo, hi = V.min(0), V.max(0); sx, sz, h = hi[0] - lo[0], hi[2] - lo[2], hi[1] - lo[1]
        if lo[1] < 0.45 and 0.5 <= h <= 0.7 and abs(sx - sz) < 0.02 and any(abs(sx - s) < 0.03 for s in SIZES):
            cx, cz = (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2
            if not any(k[0] < cx < k[2] and k[1] < cz < k[3] for k in KEEP):
                out.append((lo[0] - 0.05, lo[2] - 0.05, hi[0] + 0.05, hi[2] + 0.05, hi[1] + 0.85))
    # a rim and a box are separate pieces of one planter: keep one rect per planter (the larger)
    out.sort(key=lambda r: -(r[2] - r[0]))
    uniq = []
    for r in out:
        if not any(abs((r[0] + r[2]) - (u[0] + u[2])) < 0.2 and abs((r[1] + r[3]) - (u[1] + u[3])) < 0.2 for u in uniq):
            uniq.append(r)
    return uniq


def run(path, dry, col_path=None):
    g = Glb(path); j = g.gltf; rects = []
    child = {c for nd in j["nodes"] for c in nd.get("children", [])}
    for ni, n in enumerate(j["nodes"]):
        if n.get("name") != "Props" or ni in child or "mesh" not in n or any(k in n for k in ("translation", "rotation", "scale", "matrix")):
            continue
        for p in j["meshes"][n["mesh"]]["primitives"]:
            P = g.acc_raw(p["attributes"]["POSITION"]); I = g.indices_of(p).reshape(-1, 3)
            R = planter_rects(P, I); rects += R; c = P[I].mean(1); kill = np.zeros(len(I), bool)
            for x0, z0, x1, z1, ytop in R:
                kill |= (c[:, 0] > x0) & (c[:, 0] < x1) & (c[:, 2] > z0) & (c[:, 2] < z1) & (c[:, 1] < ytop)
            print(json.dumps({"planters": len(R), "tris_dropped": int(kill.sum())}))
            if not dry and kill.any():
                keep = I[~kill].astype("<u4").ravel()
                p["indices"] = add_accessor(g, add_view(g, keep.tobytes(), 34963), 5125, len(keep), "SCALAR")
    if not dry:
        print("wrote", path, save_glb(path, j, g.bin), "bytes")
    if col_path:
        cut_collision(col_path, rects, dry)


def cut_collision(path, rects, dry):
    """the plaza-rim planters had a box and a trunk cylinder in the collision GLB (collision.py): cut them with the visuals, up to 3.2 m"""
    g = Glb(path); j = g.gltf; n_cut = 0
    child = {c for nd in j["nodes"] for c in nd.get("children", [])}
    for ni, n in enumerate(j["nodes"]):
        if n.get("name") != "col_props" or ni in child or "mesh" not in n or any(k in n for k in ("translation", "rotation", "scale", "matrix")):
            continue   # only the props set: a ground quad whose centre falls in a planter square must stay
        for p in j["meshes"][n["mesh"]]["primitives"]:
            if "indices" not in p:
                continue
            P = g.acc_raw(p["attributes"]["POSITION"]); I = g.indices_of(p).reshape(-1, 3); c = P[I].mean(1); kill = np.zeros(len(I), bool)
            for x0, z0, x1, z1, _ in rects:
                kill |= (c[:, 0] > x0 - 0.25) & (c[:, 0] < x1 + 0.25) & (c[:, 2] > z0 - 0.25) & (c[:, 2] < z1 + 0.25) & (c[:, 1] < 3.2)
            n_cut += int(kill.sum())
            if not dry and kill.any():
                keep = I[~kill].astype("<u4").ravel()
                if not len(keep):
                    keep = np.zeros(3, "<u4")
                p["indices"] = add_accessor(g, add_view(g, keep.tobytes(), 34963), 5125, len(keep), "SCALAR")
    print(json.dumps({"collision_tris_cut": n_cut}))
    if not dry:
        print("wrote", path, save_glb(path, j, g.bin), "bytes")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("world", nargs="?", default="apps/console/public/assets/world-city3.glb"); ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(); run(a.world, a.dry_run, os.path.join(os.path.dirname(os.path.abspath(a.world)), "world-city3-collision.glb"))
