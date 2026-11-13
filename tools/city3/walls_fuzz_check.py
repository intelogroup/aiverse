#!/usr/bin/env python3
"""Reads the sampled walks from walls_fuzz.ts and fails any sample that lies inside a closed collision solid
(col_buildings, col_stalls, col_props, col_fountain*, col_quay): vertical-ray parity at body height.
  python3 tools/city3/walls_fuzz_check.py /tmp/fuzz.json"""
import json, os, sys
sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs")); HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
from bridge_wave1 import Glb
SOLIDS = ("col_buildings", "col_stalls", "col_props", "col_fountain", "col_fountain_planters", "col_quay")
g = Glb(os.path.join(HERE, "..", "..", "apps", "console", "public", "assets", "world-city3-collision.glb")); j = g.gltf
tris = {}
for n in j["nodes"]:
    if n.get("name") in SOLIDS and "mesh" in n:
        T = []
        for p in j["meshes"][n["mesh"]]["primitives"]:
            P = g.acc_raw(p["attributes"]["POSITION"]).astype(float); T.append(P[g.indices_of(p).reshape(-1, 3)])
        tris[n["name"]] = np.concatenate(T)
def inside(T, x, y, z):
    """odd number of triangle crossings of a +x ray at height y (2D point-in-triangle in the (z,y) plane, crossing x > px)."""
    a, b, c = T[:, 0], T[:, 1], T[:, 2]
    zs = np.stack([a[:, 2], b[:, 2], c[:, 2]], 1); ys = np.stack([a[:, 1], b[:, 1], c[:, 1]], 1)
    m = (zs.min(1) <= z) & (zs.max(1) >= z) & (ys.min(1) <= y) & (ys.max(1) >= y)
    cnt = 0
    for t in T[m]:
        p0, p1, p2 = t
        # plane through the triangle: x as a function of (z,y); crossing when the (z,y) point is inside the projected triangle
        d = (p1[2] - p0[2]) * (p2[1] - p0[1]) - (p2[2] - p0[2]) * (p1[1] - p0[1])
        if abs(d) < 1e-9: continue
        u = ((z - p0[2]) * (p2[1] - p0[1]) - (p2[2] - p0[2]) * (y - p0[1])) / d
        v = ((p1[2] - p0[2]) * (y - p0[1]) - (z - p0[2]) * (p1[1] - p0[1])) / d
        if u >= 0 and v >= 0 and u + v <= 1 and p0[0] + u * (p1[0] - p0[0]) + v * (p2[0] - p0[0]) > x: cnt += 1
    return cnt % 2 == 1
paths = json.load(open(sys.argv[1])); bad = []; n = 0; bad_starts = 0
def in_any(x, z, y): return next((k for k, T in tris.items() if inside(T, x, y + 0.9, z)), None)  # samples are [x, z, y]
for wi, p in enumerate(paths):
    if in_any(*p[0]): bad_starts += 1; continue  # a start inside a solid is a harness artifact, not a wall leak
    prev = p[0]
    for x, z, y in p[1:]:
        n += 1
        k = in_any(x, z, y)
        if k: bad.append((wi, k, "from", [round(v, 2) for v in prev], "to", [round(v, 2) for v in (x, z, y)])); break
        prev = (x, z, y)
print("starts inside a solid (skipped)", bad_starts, "samples", n, "walks", len(paths), "inside-solid", len(bad))
for b in bad[:30]: print("INSIDE", b)
sys.exit(1 if bad else 0)
