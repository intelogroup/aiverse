#!/usr/bin/env python3
"""Bazaar replace-not-repair pass, patched onto the shipped world-city3.glb (run after bridge_bazaar.py).

1. Orphan cornice slabs: the merged `Props` mesh still carries the old procedural blocks' cornice bands. Where the block
   was replaced by a lower Bones_shop building the band floats above the roof (cream slabs sticking out of the skyline).
   Each connected slab group that is not supported by any building top is deleted (triangles degenerated).
2. The 33 stalls that were still procedural (flat awning sliver, plain box counter, floating baskets) become the library
   `SK_med_stall` like the other 47; their baked counter, posts, awning, barrel and cuboid crate stacks are removed and the
   side crates are replaced by `SK_med_crate` nodes.
3. `SK_pot` ground pots (stand alone beside the stalls, goods already carry pots on the tables) are dropped.
Visual meshes only; collision GLB untouched.
  python3 tools/city3/bridge_bazaar_fixes.py [glb] [--dry-run]
"""
import argparse, copy, json, math, os, random, sys
sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
from bridge_wave1 import Glb, save_glb
import bridge_bazaar as BB

TEA_LOT = (-40.0, -10.0, -88.0, -69.0)  # x0, x1, z0, z1: Tea House lot, handled by its own bridges
SUPPORT = ("Bones_shop", "Roof_shop", "Roof", "B_Facade")


def heightfield(g, cell=1.0):
    """max building y per xz cell, from the building meshes (triangles sampled on a lattice)."""
    j = g.gltf; H = {}
    for n in j["nodes"]:
        nm = n.get("name", "")
        if "mesh" not in n or not nm.startswith(SUPPORT) or "translation" in n or "scale" in n:
            continue
        for p in j["meshes"][n["mesh"]]["primitives"]:
            if "indices" not in p:
                continue
            P = g.acc_raw(p["attributes"]["POSITION"]); T = P.astype(np.float64)[g.indices_of(p).astype(int).reshape(-1, 3)]
            for t in T:
                e = max(np.linalg.norm(t[1] - t[0]), np.linalg.norm(t[2] - t[0]), np.linalg.norm(t[2] - t[1]))
                k = int(min(40, max(2, e / (cell * .5))))
                a, b = np.meshgrid(np.linspace(0, 1, k), np.linspace(0, 1, k)); m = (a + b) <= 1
                w = np.stack([1 - a[m] - b[m], a[m], b[m]], 1); pts = w @ t
                if not np.isfinite(pts).all() or np.abs(pts).max() > 1e4: continue
                for x, y, z in pts:
                    key = (int(math.floor(x / cell)), int(math.floor(z / cell)))
                    if H.get(key, -9) < y: H[key] = y
    return H


def slab_groups(P, I, ymin=8.5):
    T = P[I]; c = T.mean(1)
    area = np.linalg.norm(np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]), axis=1)
    idx = np.where((area > 1e-6) & (c[:, 1] > ymin) & (np.abs(c[:, 0]) < 130) & (np.abs(c[:, 2]) < 130))[0]
    par = {}
    def f(a):
        while par.setdefault(a, a) != a:
            par[a] = par[par[a]]; a = par[a]
        return a
    key = lambda v: tuple(np.round(v, 2))
    for t in idx:
        ks = [key(v) for v in T[t]]
        for k in ks[1:]: par[f(ks[0])] = f(k)
    grp = {}
    for t in idx: grp.setdefault(f(key(T[t][0])), []).append(t)
    return list(grp.values())


def orphan_slabs(g, props, H, report):
    P = g.acc_raw(props["attributes"]["POSITION"]); I = g.indices_of(props).astype(np.uint32).reshape(-1, 3)
    kill = np.zeros(len(I), dtype=bool); T = P[I]; groups = 0
    for ts in slab_groups(P, I):
        S = T[ts]; mn = S.min((0, 1)); mx = S.max((0, 1))
        if mx[1] - mn[1] > 1.3 or max(mx[0] - mn[0], mx[2] - mn[2]) < 3.0:  # only long, low bands
            continue
        if TEA_LOT[0] < (mn[0] + mx[0]) / 2 < TEA_LOT[1] and TEA_LOT[2] < (mn[2] + mx[2]) / 2 < TEA_LOT[3]:
            continue
        xs = np.arange(mn[0] + .25, mx[0], 1.0) if mx[0] - mn[0] > mx[2] - mn[2] else np.full(1, (mn[0] + mx[0]) / 2)
        zs = np.arange(mn[2] + .25, mx[2], 1.0) if mx[2] - mn[2] >= mx[0] - mn[0] else np.full(1, (mn[2] + mx[2]) / 2)
        tops = []
        for x in xs:
            for z in zs:
                cx, cz = int(math.floor(x)), int(math.floor(z))
                tops.append(max(H.get((cx + a, cz + b), -9) for a in (-1, 0, 1) for b in (-1, 0, 1)))
        floating = np.mean(np.array(tops) < mx[1] - 0.3)
        # a closed box is 12 triangles: fewer means an earlier pass cut the band apart and left a split fragment
        if floating > .5 or len(ts) < 12:
            kill[ts] = True; groups += 1
    report["orphan_slab_groups"] = groups; report["orphan_slab_triangles"] = int(kill.sum())
    return P, I, kill


def run(path, dry):
    g = Glb(path); j = g.gltf
    if j.get("extras", {}).get("bazaar_fixes_pass"):
        print({"already_patched": True}); return
    rep = {}
    props_node = next(n for n in j["nodes"] if n.get("name") == "Props")
    props = j["meshes"][props_node["mesh"]]["primitives"][0]
    H = heightfield(g)
    P, I, kill = orphan_slabs(g, props, H, rep)
    # procedural stalls: low baked props (barrel + cuboid crate stacks) and the whole stall footprint
    centers = BB.stall_layout(); proc = set(range(len(centers))) - BB.selected_stalls(0.65)
    # the first bazaar pass promoted the other 0.35..0.65 band; procedural_stalls() is the ones still baked
    todo = [(centers[i][0], -centers[i][1], centers[i][2]) for i in sorted(proc)]
    Tn = P[I]; cen = Tn.mean(1); rm = kill.copy(); side_crates = []
    for x, z, _f in todo:
        body = (np.abs(cen[:, 0] - x) < 2.35) & (np.abs(cen[:, 2] - z) < 1.95) & (cen[:, 1] >= .2) & (cen[:, 1] <= 4.2)
        rm |= body
    # every stall (also the 47 already modelled) has a baked hex barrel + cuboid crate stack beside it: replace with library crates
    done = {(x, z) for x, z, _ in todo}
    for cx, cy, _f in centers:
        x, z = cx, -cy
        side = (cen[:, 0] > x + 2.2) & (cen[:, 0] < x + 4.95) & (np.abs(cen[:, 2] - z) < 1.0) & (cen[:, 1] >= .2) & (cen[:, 1] <= 1.0)
        if side.any() and (x, z) not in done: side_crates.append((x, z))
        rm |= side
    rep["procedural_stalls_replaced"] = len(todo); rep["side_stacks_replaced"] = len(side_crates)
    rep["props_triangles_removed"] = int(rm.sum())
    awn_i = next(i for i, m in enumerate(j["meshes"]) if m.get("name") == "awning")
    awn = j["meshes"][awn_i]["primitives"][0]
    awn_pos = [(x, z) for x, z, _ in todo]
    if dry:
        print(rep); return rep
    tmpl = {}
    for n in j["nodes"]:
        if n.get("name", "").startswith("SK_med_stall"):
            tmpl["N" if n["translation"][2] > 0 else "S"] = n
    crate_t = next(n for n in j["nodes"] if n.get("name", "").startswith("SK_med_crate"))
    rnd = random.Random(7321)
    scene = j["scenes"][j.get("scene", 0)]["nodes"]
    def add(node):
        j["nodes"].append(node); scene.append(len(j["nodes"]) - 1)
    for x, z, f in todo:
        st = copy.deepcopy(tmpl["N" if f == "N" else "S"])
        st["name"] = f"SK_med_stall_BazaarFix_{int(x)}_{int(z)}"; st["translation"] = [x, st["translation"][1], z]
        if f == "N": st["rotation"] = [0, 1, 0, 0]
        else: st.pop("rotation", None)
        add(st)
        for q in range(rnd.choice([1, 1, 2])):
            c = copy.deepcopy(crate_t); c["name"] = f"SK_med_crate_BazaarFix_{int(x)}_{int(z)}_{q}"
            c["translation"] = [x + 2.9 + q * 0.95, crate_t["translation"][1], z + rnd.uniform(-.5, .5)]
            a = rnd.uniform(0, math.tau); c["rotation"] = [0, math.sin(a / 2), 0, math.cos(a / 2)]
            add(c)
    for x, z in side_crates:
        c = copy.deepcopy(crate_t); c["name"] = f"SK_med_crate_BazaarFix_{int(x)}_{int(z)}_s"
        c["translation"] = [x + 2.9, crate_t["translation"][1], z + rnd.uniform(-.4, .4)]
        a = rnd.uniform(0, math.tau); c["rotation"] = [0, math.sin(a / 2), 0, math.cos(a / 2)]
        add(c)
    I2 = I.copy(); I2[rm, 1] = I2[rm, 0]; I2[rm, 2] = I2[rm, 0]
    BB.rewrite_indices(g, props["indices"], I2.ravel(), len(P))
    rep["removed_awning_triangles"] = BB.degenerate_inside(g, awn, awn_pos, 2.65, 2.3, 2.2, 4.2)
    pots = 0
    for ni, n in enumerate(j["nodes"]):
        if n.get("name", "").startswith("SK_pot") and ni in scene:
            scene.remove(ni); pots += 1
    rep["pots_removed"] = pots
    j.setdefault("extras", {})["bazaar_fixes_pass"] = "v1"
    print(rep); print("wrote", path, save_glb(path, g.gltf, g.bin), "bytes")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("glb", nargs="?", default="apps/console/public/assets/world-city3.glb")
    ap.add_argument("--dry-run", action="store_true"); a = ap.parse_args(); run(a.glb, a.dry_run)
