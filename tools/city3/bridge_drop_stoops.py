#!/usr/bin/env python3
"""Drop the stoops and frontage ledges left in front of demolished shops (low stone boxes on the sidewalk, seen live 2026-11-24).

Props triangles lying wholly between 0.15 and 0.85 m (lamp posts reach higher), centred within 2.5 m outside a plan building's footprint, are
grouped by touching bounding boxes (flat-shaded box faces share no vertices); a group 1.5-7 m long, 0.3-1.5 m deep and >= 0.3 m tall goes
(bins, 0.6 m across, stay). Buildings still standing (Tea House, Troyes hall) and the
plaza keep theirs. Bytes stay until bridge_compact.py --drop-dead.
  python3 tools/city3/bridge_drop_stoops.py [world.glb] [--dry-run]
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
from bridge_drop_planters import components
from bridge_landscape_kit import add_accessor, add_view
from bridge_sweep_orphans import KEEP
from bridge_wave1 import Glb, save_glb


def building_rects():
    p = json.load(open(os.path.join(HERE, "plan.json")))
    return [(b["rect"][0], -b["rect"][3], b["rect"][2], -b["rect"][1]) for b in p["buildings"]]


def stoop(lo, hi, rects):
    sx, sz, h = hi[0] - lo[0], hi[2] - lo[2], hi[1] - lo[1]
    if not (lo[1] < 0.3 and 0.3 <= h <= 0.75 and 1.5 <= max(sx, sz) <= 7.0 and 0.3 <= min(sx, sz) <= 1.5):
        return False
    cx, cz = (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2
    if any(k[0] < cx < k[2] and k[1] < cz < k[3] for k in KEEP.values()):
        return False
    near = lambda r, m: r[0] - m < cx < r[2] + m and r[1] - m < cz < r[3] + m
    return any(near(r, 2.5) and not near(r, -0.2) for r in rects)   # in the 2.5 m band outside a footprint


def in_band(cx, cz, rects):
    if any(k[0] < cx < k[2] and k[1] < cz < k[3] for k in KEEP.values()):
        return False
    near = lambda r, m: r[0] - m < cx < r[2] + m and r[1] - m < cz < r[3] + m
    return any(near(r, 2.5) and not near(r, -0.2) for r in rects)


def clusters(T, cell=0.3):
    """group triangles (n,3,3) whose bounding boxes touch on a 0.3 m grid; faces of one flat-shaded box share no vertices"""
    owner = {}; parent = list(range(len(T)))
    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]; a = parent[a]
        return a
    for t, tri in enumerate(T):
        lo, hi = np.floor(tri.min(0)[[0, 2]] / cell).astype(int), np.floor(tri.max(0)[[0, 2]] / cell).astype(int)
        for ix in range(lo[0], hi[0] + 1):
            for iz in range(lo[1], hi[1] + 1):
                o = owner.setdefault((ix, iz), t)
                parent[find(t)] = find(o)
    groups = {}
    for t in range(len(T)):
        groups.setdefault(find(t), []).append(t)
    return list(groups.values())


def run(path, dry):
    rects = building_rects(); g = Glb(path); j = g.gltf
    child = {c for nd in j["nodes"] for c in nd.get("children", [])}
    for ni, n in enumerate(j["nodes"]):
        if n.get("name") != "Props" or ni in child or "mesh" not in n:
            continue
        for p in j["meshes"][n["mesh"]]["primitives"]:
            P = g.acc_raw(p["attributes"]["POSITION"]); I = g.indices_of(p).reshape(-1, 3); T = P[I]
            ymin, ymax, c = T[:, :, 1].min(1), T[:, :, 1].max(1), T.mean(1)
            cand = np.where((ymin >= 0.15) & (ymax <= 0.85))[0]
            cand = np.array([t for t in cand if in_band(c[t, 0], c[t, 2], rects)], int)
            kill = np.zeros(len(I), bool); found = 0
            for grp in clusters(T[cand]) if len(cand) else []:
                idx = cand[grp]; V = T[idx].reshape(-1, 3); lo, hi = V.min(0), V.max(0); sx, sz = hi[0] - lo[0], hi[2] - lo[2]
                if 1.5 <= max(sx, sz) <= 7.0 and 0.3 <= min(sx, sz) <= 1.5 and hi[1] - lo[1] >= 0.3:
                    kill[idx] = True; found += 1
            print(json.dumps({"stoops": found, "tris_dropped": int(kill.sum())}))
            if not dry and kill.any():
                keep = I[~kill].astype("<u4").ravel()
                p["indices"] = add_accessor(g, add_view(g, keep.tobytes(), 34963), 5125, len(keep), "SCALAR")
    if not dry:
        print("wrote", path, save_glb(path, j, g.bin), "bytes")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("world", nargs="?", default="apps/console/public/assets/world-city3.glb"); ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(); run(a.world, a.dry_run)
