#!/usr/bin/env python3
"""Garden on block (4,3) after bridge_bazaar_demolish.py cleared lots 164-171 (GLB x 72..122, z -58..-12, beside the sports field).

Lawn, two crossing gravel paths and a ring path, a stone plaza with a gazebo at the centre (Sketchfab "Gazebo", CC-BY), a rose arch on each path entrance (CC-BY),
trees and benches cloned from the shipped scene (as bridge_bazaar_open_space.py). The gazebo and arches go in through bridge_citadel_townhouses.apply (nodes
`Kit_garden<N>`); colliders: gazebo posts, benches and trunks as boxes, the arches none, so the paths stay open.

  python3 tools/city3/bridge_garden_block.py [world.glb] [collision.glb] [--dry-run | --selftest]
"""
import argparse
import copy
import json
import math
import os
import random
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
import bridge_citadel_townhouses as c
from bridge_bazaar_open_space import G, MATS, Builder, emit
from bridge_landscape_kit import add_accessor, add_view

GARDENS = {"garden": dict(rect=(72.0, -58.0, 122.0, -12.0), plaza=9.0, orchard=False, seed=4311),    # lots 164-171, beside the sports field
           "orchard": dict(rect=(-122.0, -58.0, -72.0, -12.0), plaza=5.0, orchard=True, seed=6013),
           "meadow": dict(rect=(-122.0, -84.0, -72.0, -72.0), plaza=3.4, orchard=False, strip=True, seed=7717),
           "commons": dict(rect=(-122.0, 72.0, -72.0, 122.0), plaza=7.0, orchard=False, seed=8123),
           "grove": dict(rect=(72.0, -122.0, 122.0, -72.0), plaza=6.0, orchard=True, seed=9241),
           # yards: lawn around placed houses (place_house.mjs), a walk from the street to each house, spaced trees; no gazebo, arches or plaza
           "plot": dict(rect=(-58.0, 72.0, -12.0, 122.0), plaza=0.0, orchard=False, yard=True, seed=5151),
           "citadel": dict(rect=(72.5, 72.5, 122.5, 122.5), plaza=0.0, orchard=False, yard=True, seed=5150),
           "teablock": dict(rect=(-58.0, -122.0, -12.0, -89.0), plaza=0.0, orchard=False, yard=True, seed=5152),   # south of the Tea House (102)
           "westblock": dict(rect=(-122.5, 12.5, -72.5, 57.5), plaza=0.0, orchard=False, yard=True, seed=5154),   # lots 52-59
           "tea101": dict(rect=(-57.5, -84.5, -41.0, -72.5), plaza=0.0, orchard=False, yard=True, seed=5153)}     # lot 101, west of the Tea House  # lots 44-51: a square with a plaza gazebo  # lots 68-71: the 12 m strip that finishes the park block  # lots 60-67: fruit-tree grid round a small gazebo plaza
NAME = "garden"
MARK = "garden_block_pass"
X0, X1, Z0, Z1 = GARDENS[NAME]["rect"]
CX, CZ = (X0 + X1) / 2, (Z0 + Z1) / 2
PW = 2.4          # path width
PLAZA = 9.0       # plaza half-size


def use(name):
    """point the module globals at one garden of GARDENS"""
    global NAME, MARK, X0, X1, Z0, Z1, CX, CZ, PLAZA
    NAME, g = name, GARDENS[name]
    MARK = f"{name}_block_pass"
    X0, Z0, X1, Z1 = g["rect"][0], g["rect"][1], g["rect"][2], g["rect"][3]
    CX, CZ, PLAZA = (X0 + X1) / 2, (Z0 + Z1) / 2, g["plaza"]
GAZEBO_S, ARCH_S = 1.6, 1.5


def centred(slug, assets, cx, cz, yaw, s):
    """item whose footprint centre is (cx, cz): the loader's frame has the footprint at local x [0, w], z [-d, 0]"""
    a = assets[slug]
    w, d = a["W"] * s, a["D"] * s
    cy, sy = math.cos(yaw), math.sin(yaw)
    lx, lz = w / 2, -d / 2
    ox, oz = lx * cy + lz * sy, -lx * sy + lz * cy
    return {"slug": slug, "t": (cx - ox, 0.0, cz - oz), "yaw": yaw, "s": (s, s, s), "w": w, "h": a["H"] * s, "d": d}


def kit_plan(assets):
    g = centred("park_gazebo", assets, CX, CZ, 0.0, GAZEBO_S)
    fx0, fz0, fx1, fz1 = c.footprint(g)
    p = 0.5      # corner posts
    g["boxes"] = [(x, z, x + p, z + p, g["h"] * 0.8) for x in (fx0, fx1 - p) for z in (fz0, fz1 - p)]
    plan = {0: {"lot": {"plan_rect": [fx0, -fz1, fx1, -fz0], "rect": [fx0, fz0, fx1, fz1], "face": "S"}, "items": [g]}}
    arches = [(CX, Z0 + 5.5, 0.0), (CX, Z1 - 5.5, math.pi), (X0 + 5.5, CZ, math.pi / 2), (X1 - 5.5, CZ, -math.pi / 2)]
    if GARDENS[NAME].get("strip"):
        arches = arches[2:]      # a 12 m strip: arches only where the path enters, not across the gazebo
    for n, (x, z, yaw) in enumerate(arches, 1):
        it = centred("rose_arch", assets, x, z, yaw, ARCH_S)
        it["boxes"] = []
        r = c.footprint(it)
        plan[n] = {"lot": {"plan_rect": [r[0], -r[3], r[2], -r[1]], "rect": list(r), "face": "S"}, "items": [it]}
    return plan


def on_path(x, z, pad=0.0):
    h = PW / 2 + pad
    if abs(x - CX) < h or abs(z - CZ) < h:
        return True
    return min(x - X0, X1 - x, z - Z0, Z1 - z) < 3.0 + 0.8 + pad and min(x - X0, X1 - x, z - Z0, Z1 - z) > 3.0 - 0.8 - pad


def strip_scenery(rnd):
    """a long thin lot (the 12 m row that finishes a block): one gravel path down the middle, the gazebo's stone pad, benches by the path, a tree row each side"""
    b = Builder()
    b.box("grass", X0, X1, Z0, Z1, G - .02, G + .03, uv=4.0)
    b.box("gravel", X0, X1, CZ - PW / 2, CZ + PW / 2, G + .03, G + .06, uv=1.5)
    b.box("stone", CX - PLAZA - 1.5, CX + PLAZA + 1.5, CZ - PLAZA, CZ + PLAZA, G + .03, G + .1, uv=1.5)
    trees = [(x + rnd.uniform(-.8, .8), zz + rnd.uniform(-.5, .5), rnd.choice(("Tree_packtree_a", "Tree_packtree_b", "Tree_packtree_c")))
             for zz in (Z0 + 2.5, Z1 - 2.5) for x in np.arange(X0 + 3.0, X1 - 2.0, 5.5) if abs(x - CX) > PLAZA + 4.5]
    benches = [(x, CZ - PW / 2 - .8, 0.0) if k % 2 else (x, CZ + PW / 2 + .8, math.pi) for k, x in enumerate(np.arange(X0 + 8.0, X1 - 6.0, 9.0)) if abs(x - CX) > PLAZA + 4.5]
    return b, trees, benches


def house_rects():
    """world-frame footprints [x0, z0, x1, z1] of the placed houses whose centre lies in this block"""
    return [r for (cx, cz), r in house_footprints().values() if X0 <= cx <= X1 and Z0 <= cz <= Z1]


def house_footprints():
    """{district id: ((centre x, z), world-frame footprint [x0, z0, x1, z1])} of every placed house (districts.json `house-*`), from its GLB bounds"""
    from bridge_wave1 import Glb
    A = os.path.join(HERE, "..", "..", "apps", "console", "public", "assets")
    out = {}
    for d in json.load(open(os.path.join(A, "districts.json")))["districts"]:
        if not d["id"].startswith("house-"):
            continue
        j = Glb(os.path.join(A, d["url"][len("/assets/"):])).gltf
        lo, hi = np.full(3, 1e9), np.full(3, -1e9)

        def walk(i, M):
            n = j["nodes"][i]
            T = np.eye(4); T[:3, 3] = n.get("translation", [0, 0, 0])
            x, y, z, w = n.get("rotation", [0, 0, 0, 1])
            R = np.eye(4); R[:3, :3] = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
            M = M @ (np.array(n["matrix"]).reshape(4, 4).T if "matrix" in n else T @ R @ np.diag(n.get("scale", [1, 1, 1]) + [1]))
            for p in j["meshes"][n["mesh"]]["primitives"] if "mesh" in n else ():
                a = j["accessors"][p["attributes"]["POSITION"]]
                for c in ([u, v, w_, 1] for u in (a["min"][0], a["max"][0]) for v in (a["min"][1], a["max"][1]) for w_ in (a["min"][2], a["max"][2])):
                    q = (M @ c)[:3]; lo[:] = np.minimum(lo, q); hi[:] = np.maximum(hi, q)
            for ch in n.get("children", []):
                walk(ch, M)
        for r in j["scenes"][j.get("scene", 0)]["nodes"]:
            walk(r, np.eye(4))
        ox, oz = d.get("origin", [0, 0])   # shared house GLBs are authored at (0, 0) and moved by the district origin
        out[d["id"]] = (tuple(d["center"]), (float(lo[0]) + ox, float(lo[2]) + oz, float(hi[0]) + ox, float(hi[2]) + oz))
    return out


def minus(rect, holes):
    """axis-aligned rect minus holes, as disjoint rects (x strips cut at every hole edge)"""
    x0, z0, x1, z1 = rect
    xs = sorted({x0, x1, *(min(max(h[i], x0), x1) for h in holes for i in (0, 2))})
    out = []
    for a, b in zip(xs, xs[1:]):
        if b - a < 1e-6:
            continue
        cuts = sorted((h[1], h[3]) for h in holes if h[0] < b - 1e-6 and h[2] > a + 1e-6)
        z = z0
        for c0, c1 in cuts:
            if c0 > z:
                out.append((a, z, b, min(c0, z1)))
            z = max(z, c1)
        if z < z1:
            out.append((a, z, b, z1))
    return [r for r in out if r[2] - r[0] > 1e-3 and r[3] - r[1] > 1e-3]


def yard_scenery(rnd, houses):
    """lawn everywhere but under the houses, a 1.6 m gravel walk from the nearest block edge to each house, trees >= 3 m from houses and 4.5 m apart"""
    b = Builder()
    walks = []
    for hx0, hz0, hx1, hz1 in houses:
        cx, cz = (hx0 + hx1) / 2, (hz0 + hz1) / 2
        d = {"W": hx0 - X0, "E": X1 - hx1, "N": hz0 - Z0, "S": Z1 - hz1}; side = min(d, key=d.get)
        walks.append({"W": (X0, cz - .8, hx0, cz + .8), "E": (hx1, cz - .8, X1, cz + .8), "N": (cx - .8, Z0, cx + .8, hz0), "S": (cx - .8, hz1, cx + .8, Z1)}[side])
    for r in minus((X0, Z0, X1, Z1), houses):
        b.box("grass", r[0], r[2], r[1], r[3], G - .02, G + .03, uv=4.0)
    for r in walks:
        b.box("gravel", r[0], r[2], r[1], r[3], G + .03, G + .06, uv=1.5)
    near = lambda x, z, rs, pad: any(r[0] - pad < x < r[2] + pad and r[1] - pad < z < r[3] + pad for r in rs)
    trees = []
    for _ in range(600):
        x, z = rnd.uniform(X0 + 1.5, X1 - 1.5), rnd.uniform(Z0 + 1.5, Z1 - 1.5)
        if len(trees) >= 18:
            break
        if near(x, z, houses, 3.0) or near(x, z, walks, 1.5) or any((x - t[0]) ** 2 + (z - t[1]) ** 2 < 4.5 ** 2 for t in trees):
            continue
        trees.append((x, z, rnd.choice(("Tree_packtree_a", "Tree_packtree_b", "Tree_packtree_c"))))
    return b, trees, []


def scenery(rnd):
    if GARDENS[NAME].get("yard"):
        return yard_scenery(rnd, house_rects())
    if GARDENS[NAME].get("strip"):
        return strip_scenery(rnd)
    b = Builder()
    trees, benches = [], []
    b.box("grass", X0, X1, Z0, Z1, G - .02, G + .03, uv=4.0)
    for x0, x1, z0, z1 in ((X0 + 2.2, X1 - 2.2, Z0 + 2.2, Z0 + 3.8), (X0 + 2.2, X1 - 2.2, Z1 - 3.8, Z1 - 2.2), (X0 + 2.2, X0 + 3.8, Z0 + 2.2, Z1 - 2.2), (X1 - 3.8, X1 - 2.2, Z0 + 2.2, Z1 - 2.2),
                           (CX - PW / 2, CX + PW / 2, Z0, Z1), (X0, X1, CZ - PW / 2, CZ + PW / 2)):
        b.box("gravel", x0, x1, z0, z1, G + .03, G + .06, uv=1.5)
    b.box("stone", CX - PLAZA, CX + PLAZA, CZ - PLAZA, CZ + PLAZA, G + .03, G + .1, uv=1.5)
    cand = ([(X0 + 7.5 + 6.0 * i + rnd.uniform(-.5, .5), Z0 + 7.5 + 6.0 * k + rnd.uniform(-.5, .5)) for i in range(int((X1 - X0 - 15) / 6.0) + 1) for k in range(int((Z1 - Z0 - 15) / 6.0) + 1)]
            if GARDENS[NAME]["orchard"] else [(rnd.uniform(X0 + 1, X1 - 1), rnd.uniform(Z0 + 1, Z1 - 1)) for _ in range(240)])
    for x, z in cand:
        if len(trees) >= (80 if GARDENS[NAME]["orchard"] else 34):
            break
        if on_path(x, z, 1.2) or abs(x - CX) < PLAZA + 2.5 and abs(z - CZ) < PLAZA + 2.5:
            continue
        trees.append((x, z, rnd.choice(("Tree_packtree_a", "Tree_packtree_b", "Tree_packtree_c"))))
    o = PLAZA / 2
    for dx in (-o, o):
        benches += [(CX + dx, CZ - PLAZA + .8, 0.0), (CX + dx, CZ + PLAZA - .8, math.pi)]
    for dz in (-o, o):
        benches += [(CX - PLAZA + .8, CZ + dz, math.pi / 2), (CX + PLAZA - .8, CZ + dz, -math.pi / 2)]
    return b, trees, benches


def col_mesh(gc, boxes, name):
    P, I = [], []
    for x0, x1, z0, z1, y0, y1 in boxes:
        base = len(P)
        P += [(x, y, z) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]
        for q in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
            I += [base + q[0], base + q[1], base + q[2], base + q[0], base + q[2], base + q[3]]
    Pa = np.array(P, "<f4"); Na = np.zeros_like(Pa); Na[:, 1] = 1; Ia = np.array(I, "<u4"); j = gc.gltf
    pa = add_accessor(gc, add_view(gc, Pa.tobytes(), 34962), 5126, len(Pa), "VEC3", Pa.min(0).tolist(), Pa.max(0).tolist())
    na = add_accessor(gc, add_view(gc, Na.tobytes(), 34962), 5126, len(Na), "VEC3")
    ia = add_accessor(gc, add_view(gc, Ia.tobytes(), 34963), 5125, len(Ia), "SCALAR")
    j["meshes"].append({"name": name, "primitives": [{"attributes": {"POSITION": pa, "NORMAL": na}, "indices": ia, "material": j["meshes"][0]["primitives"][0]["material"]}]})
    j["nodes"].append({"name": name, "mesh": len(j["meshes"]) - 1})
    j["scenes"][0]["nodes"].append(len(j["nodes"]) - 1)


def selftest():
    assets = {"park_gazebo": {"W": 4.2, "H": 3.2, "D": 4.2}, "rose_arch": {"W": 1.39, "H": 2.4, "D": 0.38}}
    for yaw in (0.0, math.pi / 2, math.pi, -math.pi / 2):
        it = centred("rose_arch", assets, 97.0, -35.0, yaw, 1.5)
        x0, z0, x1, z1 = c.footprint(it)
        assert abs((x0 + x1) / 2 - 97.0) < 1e-6 and abs((z0 + z1) / 2 + 35.0) < 1e-6, (yaw, x0, z0, x1, z1)
    plan = kit_plan(assets)
    assert len(plan) == 5 and plan[0]["items"][0]["boxes"] and plan[1]["items"][0]["boxes"] == []
    b, trees, benches = scenery(random.Random(1))
    assert len(trees) == 34 and len(benches) == 8 and all(not on_path(x, z, 1.0) for x, z, _ in trees)
    use("orchard")
    b, trees, benches = scenery(random.Random(1))
    assert 20 <= len(trees) <= 80 and all(X0 < x < X1 and Z0 < z < Z1 and not on_path(x, z, 1.0) for x, z, _ in trees) and len(plan := kit_plan(assets)) == 5
    r = minus((0, 0, 10, 10), [(2, 2, 4, 4), (6, 5, 8, 12)])
    area = sum((q[2] - q[0]) * (q[3] - q[1]) for q in r)
    assert abs(area - (100 - 4 - 10)) < 1e-6 and not any(q[0] < 3 < q[2] and q[1] < 3 < q[3] for q in r), r
    use("garden")
    print("selftest ok")


def run(world_path, col_path, dry, name="garden"):
    use(name)
    from bridge_wave1 import Glb, save_glb
    world, col = Glb(world_path), Glb(col_path)
    j = world.gltf
    if j.get("extras", {}).get(MARK):
        print({"already_patched": True}); return
    rnd = random.Random(GARDENS[NAME]["seed"])
    b, trees, benches = scenery(rnd)
    print(json.dumps({"quads": sum(len(d["P"]) // 4 for d in b.q.values()), "trees": len(trees), "benches": len(benches)}))
    if not GARDENS[NAME].get("yard"):   # yards carry no gazebo or arches
        assets = {s: c.load_asset(s) for s in ("park_gazebo", "rose_arch")}
        rep = c.apply(world, col, kit_plan(assets), assets, dry, mark=MARK, prefix="Kit_" + NAME)
        print(json.dumps(rep))
    if dry:
        return
    j.setdefault("extras", {})[MARK] = True
    cache = {}

    def mats(k):
        if k not in cache:
            col_, r, mt, _ = MATS[k]
            j["materials"].append({"name": f"Bz{NAME.title()}_" + k, "pbrMetallicRoughness": {"baseColorFactor": [*col_[:3], 1], "metallicFactor": mt, "roughnessFactor": r}})
            cache[k] = len(j["materials"]) - 1
        return cache[k]

    emit(world, j, b, "Bz" + NAME.title(), mats)
    scene = j["scenes"][j.get("scene", 0)]["nodes"]
    tmpl = {n["name"]: n for n in j["nodes"] if n.get("name", "").startswith("Tree_packtree_")}
    bench = next(n for n in j["nodes"] if n.get("name", "").startswith("SK_med_bench"))
    boxes = []
    for i, (x, z, nm) in enumerate(trees):
        n = copy.deepcopy(tmpl.get(nm) or next(iter(tmpl.values())))
        n["name"] = f"{nm}.{NAME}{i}"; n["translation"] = [x, G, z]; n["rotation"] = [0, math.sin(i), 0, math.cos(i)]
        j["nodes"].append(n); scene.append(len(j["nodes"]) - 1)
        boxes.append((x - .25, x + .25, z - .25, z + .25, G, G + 3))
    for i, (x, z, yaw) in enumerate(benches):
        n = copy.deepcopy(bench)
        n["name"] = f"SK_med_bench.{NAME}{i}"; n["translation"] = [x, G, z]; n["rotation"] = [0, math.sin(yaw / 2), 0, math.cos(yaw / 2)]
        j["nodes"].append(n); scene.append(len(j["nodes"]) - 1)
        boxes.append((x - .9, x + .9, z - .3, z + .3, G, G + .5))
    col_mesh(col, boxes, "col_" + NAME)
    print("wrote", world_path, save_glb(world_path, world.gltf, world.bin), "bytes")
    print("wrote", col_path, save_glb(col_path, col.gltf, col.bin), "bytes")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("world", nargs="?", default="apps/console/public/assets/world-city3.glb")
    ap.add_argument("collision", nargs="?", default="apps/console/public/assets/world-city3-collision.glb")
    ap.add_argument("--block", default="garden", choices=sorted(GARDENS))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        selftest(); sys.exit(0)
    run(a.world, a.collision, a.dry_run, a.block)
