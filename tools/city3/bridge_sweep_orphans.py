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


def inner_rects():
    """GLB [x0, z0, x1, z1] of every plan block's `inner` rect (off the sidewalks, where lamps stand); plan.json comes from plan.py"""
    p = os.path.join(HERE, "plan.json")
    if not os.path.exists(p):
        raise SystemExit("tools/city3/plan.json missing: run plan.py (check_plan_vs_glb.py does) first")
    return [(b["inner"][0], -b["inner"][3], b["inner"][2], -b["inner"][1]) for b in json.load(open(p))["blocks"]]


def in_rects(c, rects):
    k = np.zeros(len(c), bool)
    for x0, z0, x1, z1 in rects:
        k |= (c[:, 0] > x0) & (c[:, 0] < x1) & (c[:, 2] > z0) & (c[:, 2] < z1)
    return k


def floating(P, I, above=3.0, wide=1.2):
    """per triangle: True when its connected piece (vertices merged by position, 1 mm) hangs in the air - its lowest point is above `above`
    and nothing holds it up: no grounded or already-held piece has a vertex within 0.6 m sideways and 0.4 m below that lowest point
    (propagated, so a lamp cap on a lantern on a post stays). A balcony or pennant whose wall went has nothing under it and goes."""
    q = np.round(P * 1000).astype(np.int64)
    _, vid = np.unique(q, axis=0, return_inverse=True); vid = vid.ravel()
    parent = np.arange(vid.max() + 1)

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]; a = parent[a]
        return a
    T = vid[I]
    for a, b, c in T:
        ra, rb, rc = find(a), find(b), find(c)
        parent[rb] = ra; parent[rc] = ra
    roots = np.array([find(v) for v in range(len(parent))])
    used = np.unique(T.ravel())                                  # vertices of live triangles only (dropped ones keep theirs in the buffer)
    pos = np.zeros((len(parent), 3)); pos[vid] = P              # one position per merged vertex
    comps = {}
    for v in used:
        comps.setdefault(roots[v], []).append(v)
    low = {r: vs[int(np.argmin(pos[vs, 1]))] for r, vs in comps.items()}
    held = {r for r, v in low.items() if pos[v, 1] <= above}
    cell = lambda x, z: (int(np.floor(x / 0.6)), int(np.floor(z / 0.6)))
    grid = {}

    def add(r):
        for v in comps[r]:
            grid.setdefault(cell(pos[v, 0], pos[v, 2]), []).append(pos[v, 1])
    for r in held:
        add(r)
    todo = [r for r in comps if r not in held]
    for _ in range(8):
        newly = []
        for r in todo:
            x, y, z = pos[low[r]]
            cx, cz = cell(x, z)
            if any(y - 0.4 <= yy <= y + 0.05 for dx in (-1, 0, 1) for dz in (-1, 0, 1) for yy in grid.get((cx + dx, cz + dz), ())):
                newly.append(r)
        if not newly:
            break
        for r in newly:
            held.add(r); add(r)
        todo = [r for r in todo if r not in held]
    # small pieces stay whatever holds them: lamp caps and lanterns (under 1 m) sit on arms the support test can miss; balconies are 2-3 m wide
    span = {r: float(np.ptp(pos[vs][:, [0, 2]], axis=0).max()) for r, vs in comps.items()}
    drop = {r for r in comps if r not in held and span[r] >= wide}
    # a small unheld piece standing where a dropped one hung (the rails of a dropped balcony slab) goes with it
    dgrid = {}
    for r in drop:
        for v in comps[r]:
            dgrid.setdefault(cell(pos[v, 0], pos[v, 2]), []).append(pos[v, 1])
    for r in comps:
        if r in held or r in drop:
            continue
        x, y, z = pos[low[r]]; cx, cz = cell(x, z)
        if any(abs(yy - y) <= 1.5 for dx in (-1, 0, 1) for dz in (-1, 0, 1) for yy in dgrid.get((cx + dx, cz + dz), ())):
            drop.add(r)
    comp = roots[T[:, 0]]
    return np.array([c in drop for c in comp])


def keep_mask(c):
    k = np.zeros(len(c), bool)
    for x0, z0, x1, z1 in KEEP.values():
        k |= (c[:, 0] > x0) & (c[:, 0] < x1) & (c[:, 2] > z0) & (c[:, 2] < z1)
    return k


def run(path, dry):
    g = Glb(path); j = g.gltf; rep = {}; inner = inner_rects()
    # world-space meshes only: a scene root with no transform and no GPU instancing. Instanced prototypes and children of moved
    # parents (TeaHouseStructure) keep their geometry near local (0, 0) and would be cut wherever a rect covers the origin.
    child = {c for nd in j["nodes"] for c in nd.get("children", [])}
    for ni, n in enumerate(j["nodes"]):
        if ni in child or "EXT_mesh_gpu_instancing" in n.get("extensions", {}): continue
        name = n.get("name", ""); y0 = floor_for(name)
        if y0 is None or "mesh" not in n or any(k in n for k in ("translation", "rotation", "scale", "matrix")):
            continue
        for p in j["meshes"][n["mesh"]]["primitives"]:
            if "indices" not in p:
                continue
            P = g.acc_raw(p["attributes"]["POSITION"]); I = g.indices_of(p).reshape(-1, 3); c = P[I].mean(1)
            # Props over a block interior (no lamps there: they stand on the sidewalks) lose everything above 3 m: balconies of cleared buildings
            extra = ((c[:, 1] > 3.0) & in_rects(c, inner)) | floating(P, I) if name == "Props" else False
            kill = ((c[:, 1] > y0) | extra) & ~keep_mask(c)
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
    # a post from the ground, a cap resting on its top, and a slab hanging alone
    P = np.array([[0, 0, 0], [0, 6, 0], [0.2, 6, 0], [0.1, 6.0, 0.1], [0.3, 6.5, 0.1], [0.1, 6.5, 0.3], [5, 6, 5], [7, 6, 5], [5, 7, 6],
                  [9, 8, 9], [9.4, 8, 9], [9, 8.3, 9.4], [5.2, 6.1, 5.1], [5.3, 6.1, 5.1], [5.2, 7.0, 5.1]], float)
    # ... a small cap 2 m off any support stays (under 1.2 m); a thin rail on the hanging slab goes with it
    assert floating(P, np.array([[0, 1, 2], [3, 4, 5], [6, 7, 8], [9, 10, 11], [12, 13, 14]])).tolist() == [False, False, True, False, True]
    print("selftest ok")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("world", nargs="?", default="apps/console/public/assets/world-city3.glb")
    ap.add_argument("--dry-run", action="store_true"); ap.add_argument("--selftest", action="store_true"); a = ap.parse_args()
    selftest() if a.selftest else run(a.world, a.dry_run)
