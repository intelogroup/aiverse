#!/usr/bin/env python3
"""Open space on the ground the demolished Bazaar blocks left (run after bridge_bazaar_demolish.py), visual + collision:
  lido   block x 12..58, z 72..122: tiled deck, 30 x 12 m pool (coping, water, ladders), loungers, palms/trees
  sports block x 72..122, z 12..58: running track, grass pitch with line markings, two goals, benches, trees
  park   the five ring lots of the NW block (x -122..-72, z -122..-84): lawn, crossing gravel paths, trees and benches
Geometry is built here from boxes (flat quads and boxes, 5 faces); trees and benches clone the shipped scene nodes (Tree_packtree_*, SK_med_bench).
Ground is y 0.2; surfaces sit at 0.24. Collision: pool, goal frames, benches, trunks as boxes in world-city3-collision.glb.
  python3 tools/city3/bridge_bazaar_open_space.py [glb] [--dry-run]"""
import argparse, copy, json, math, os, random, sys
sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
from bridge_landscape_kit import add_accessor, add_view
from bridge_wave1 import Glb, save_glb

FLOORS = os.path.join(HERE, "assets", "tea-floors"); G = .24  # surface height (ground 0.2)
MATS = {"deck": ((1, 1, 1), .85, 0, "tile"), "stone": ((.78, .74, .68), .9, 0, None), "water": ((.1, .5, .66, .72), .04, 0, None), "grass": ((.33, .52, .2), 1.0, 0, None),
        "track": ((.62, .3, .22), .95, 0, None), "line": ((.96, .96, .93), .8, 0, None), "gravel": ((.72, .66, .55), 1.0, 0, None), "wood": ((.5, .34, .2), .8, 0, None),
        "post": ((.95, .95, .95), .5, .1, None), "lounger": ((.9, .85, .7), .8, 0, None), "tile_pool": ((.55, .78, .85), .5, 0, None)}


class Builder:
    def __init__(s): s.q = {}; s.col = []
    def box(s, mat, x0, x1, z0, z1, y0, y1, uv=2.0, bottom=False, col=False):
        P = []; N = []; U = []; X, Y, Z = (x0, x1), (y0, y1), (z0, z1)
        def face(pts, n): P.extend(pts); N.extend([n] * 4); U.extend([(a / uv, b / uv) for a, b in [(p[0] + p[2], p[1] + p[2] * 0) for p in pts]])
        face([(x0, y1, z1), (x1, y1, z1), (x1, y1, z0), (x0, y1, z0)], (0, 1, 0))
        face([(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)], (0, 0, 1)); face([(x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0)], (0, 0, -1))
        face([(x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0)], (-1, 0, 0)); face([(x1, y0, z1), (x1, y0, z0), (x1, y1, z0), (x1, y1, z1)], (1, 0, 0))
        if y1 - y0 < .05:  # flat plate: top only, planar uv in metres
            P, N = P[:4], N[:4]; U = [((p[0]) / uv, (p[2]) / uv) for p in P]
        else: U = [((p[0] + p[2]) / uv, p[1] / uv) for p in P]
        d = s.q.setdefault(mat, {"P": [], "N": [], "U": []}); d["P"] += P; d["N"] += N; d["U"] += U
        if col: s.col.append((x0, x1, z0, z1, y0, y1))


def emit(g, j, b, name, mats):
    prims = []
    for m, d in b.q.items():
        P = np.array(d["P"], "<f4"); N = np.array(d["N"], "<f4"); U = np.array(d["U"], "<f4"); n = len(P) // 4
        I = np.array([[4 * k, 4 * k + 1, 4 * k + 2, 4 * k, 4 * k + 2, 4 * k + 3] for k in range(n)], "<u4").ravel()
        acc = lambda a, t, mm=False: add_accessor(g, add_view(g, a.tobytes(), 34962), 5126, len(a), t, a.min(0).tolist() if mm else None, a.max(0).tolist() if mm else None)
        prims.append({"attributes": {"POSITION": acc(P, "VEC3", True), "NORMAL": acc(N, "VEC3"), "TEXCOORD_0": acc(U, "VEC2")}, "indices": add_accessor(g, add_view(g, I.tobytes(), 34963), 5125, len(I), "SCALAR"), "material": mats(m)})
    j["meshes"].append({"name": name, "primitives": prims}); j["nodes"].append({"name": name, "mesh": len(j["meshes"]) - 1}); j["scenes"][j.get("scene", 0)]["nodes"].append(len(j["nodes"]) - 1)


def plan(rnd):
    b = Builder(); trees = []; benches = []
    # ---- lido: deck over the whole block, pool, loungers
    b.box("deck", 12, 58, 72, 122, G - .02, G + .04, uv=1.6)
    px0, px1, pz0, pz1 = 20, 50, 90, 104
    for x0, x1, z0, z1 in ((px0 - .5, px1 + .5, pz0 - .5, pz0), (px0 - .5, px1 + .5, pz1, pz1 + .5), (px0 - .5, px0, pz0, pz1), (px1, px1 + .5, pz0, pz1)): b.box("stone", x0, x1, z0, z1, G, G + .24, uv=1.0)  # coping ring
    b.box("tile_pool", px0, px1, pz0, pz1, G + .02, G + .03, uv=1.0); b.box("water", px0, px1, pz0, pz1, G + .14, G + .15, uv=3.0)
    b.col.append((px0 - .5, px1 + .5, pz0 - .5, pz1 + .5, G, G + .9))
    for x in range(22, 50, 5):
        for side, z in ((0, 86.8), (1, 107.2)):
            b.box("lounger", x, x + 1.9 if False else x + .8, z - .9 if side else z, z if side else z + .9, G + .04, G + .42, uv=1.0)
    for x, z in ((15, 76), (55, 76), (15, 118), (55, 118), (34, 77), (26, 118), (42, 118)): trees.append((x, z, "Tree_packtree_a"))
    # ---- sports: track ring, pitch, lines, goals
    cx, cz = 97, 35
    b.box("track", 74, 120, 14, 56, G - .02, G + .03, uv=3.0); b.box("grass", 78, 116, 18, 52, G + .03, G + .05, uv=4.0)
    for x0, x1, z0, z1 in ((80, 114, 49.8, 50.2), (80, 114, 19.8, 20.2), (80, 80.4, 20, 50), (113.6, 114, 20, 50), (96.8, 97.2, 20, 50)):
        b.box("line", x0, x1, z0, z1, G + .05, G + .06, uv=1.0)
    for gx, d in ((80, 1), (114, -1)):
        for dz in (-3.66, 3.66): b.box("post", gx - .06 * d - .06, gx - .06 * d + .06, cz + dz - .06, cz + dz + .06, G + .05, G + 2.44, uv=1.0, col=True)
        b.box("post", gx - .06 * d - .06, gx - .06 * d + .06, cz - 3.72, cz + 3.72, G + 2.38, G + 2.5, uv=1.0)
    for x in (84, 92, 102, 110): benches.append((x, 54.5, math.pi)); benches.append((x, 15.5, 0))
    for x, z in ((74, 57), (121, 57), (74, 13), (121, 13), (97, 58), (97, 11)): trees.append((x, z, "Tree_packtree_b"))
    # ---- park: the whole NW block (ring lots + courtyard) becomes lawn with a ring path, a cross path and a pond
    b.box("grass", -122, -72, -122, -84, G - .02, G + .03, uv=4.0)
    for x0, x1, z0, z1 in ((-120, -74, -120, -119), (-120, -74, -87, -86), (-120, -119, -120, -86), (-75, -74, -120, -86), (-98, -96, -120, -86), (-120, -74, -103, -101)): b.box("gravel", x0, x1, z0, z1, G + .03, G + .06, uv=1.5)
    qx0, qx1, qz0, qz1 = -92, -80, -112, -106
    b.box("stone", qx0 - .4, qx1 + .4, qz0 - .4, qz0, G + .03, G + .3, uv=1.0); b.box("stone", qx0 - .4, qx1 + .4, qz1, qz1 + .4, G + .03, G + .3, uv=1.0)
    b.box("stone", qx0 - .4, qx0, qz0, qz1, G + .03, G + .3, uv=1.0); b.box("stone", qx1, qx1 + .4, qz0, qz1, G + .03, G + .3, uv=1.0); b.box("water", qx0, qx1, qz0, qz1, G + .16, G + .17, uv=3.0)
    b.col.append((qx0 - .4, qx1 + .4, qz0 - .4, qz1 + .4, G, G + .9))
    for _ in range(26):
        for _try in range(40):
            x, z = rnd.uniform(-119, -75), rnd.uniform(-119, -87)
            if abs(x + 97) < 1.8 or abs(z + 102) < 1.8 or abs(z + 119.5) < 1.2 or abs(z + 86.5) < 1.2 or abs(x + 119.5) < 1.2 or abs(x + 74.5) < 1.2 or (qx0 - 2 < x < qx1 + 2 and qz0 - 2 < z < qz1 + 2): continue
            trees.append((x, z, rnd.choice(("Tree_packtree_a", "Tree_packtree_b", "Tree_packtree_c")))); break
    for x, z, y in ((-108, -102.8, 0), (-86, -102.8, math.pi), (-97.8, -112, math.pi / 2), (-96.2, -94, -math.pi / 2), (-108, -119, math.pi), (-86, -87.2, 0)): benches.append((x, z, y))
    return b, trees, benches


def run(path, colpath, dry):
    g = Glb(path); j = g.gltf
    if j.get("extras", {}).get("bazaar_open_space_pass"): print({"already": True}); return
    rnd = random.Random(4417); b, trees, benches = plan(rnd); rep = {"quads": sum(len(d["P"]) // 4 for d in b.q.values()), "trees": len(trees), "benches": len(benches), "collision_boxes": len(b.col)}; print(json.dumps(rep))
    if dry: return
    cache = {}
    def tex(fn, name):
        v = add_view(g, open(fn, "rb").read(), None); j["bufferViews"][v].pop("target", None); j["images"].append({"name": name, "bufferView": v, "mimeType": "image/jpeg"}); j["textures"].append({"source": len(j["images"]) - 1}); return len(j["textures"]) - 1
    def mats(k):
        if k in cache: return cache[k]
        c, r, mt, t = MATS[k]; m = {"name": "BzOpen_" + k, "pbrMetallicRoughness": {"baseColorFactor": [*c, 1][:4] if len(c) == 4 else [*c, 1], "metallicFactor": mt, "roughnessFactor": r}}
        if k == "water": m["alphaMode"] = "BLEND"
        if t: m["pbrMetallicRoughness"]["baseColorTexture"] = {"index": tex(os.path.join(FLOORS, "floor_tiles_06_c.jpg"), "bzo_deck")}; m["normalTexture"] = {"index": tex(os.path.join(FLOORS, "floor_tiles_06_n.jpg"), "bzo_deck_n")}
        j["materials"].append(m); cache[k] = len(j["materials"]) - 1; return cache[k]
    emit(g, j, b, "BzOpenSpace", mats)
    scene = j["scenes"][j.get("scene", 0)]["nodes"]; tmpl = {n["name"]: n for n in j["nodes"] if n.get("name", "").startswith("Tree_packtree_")}; bench = next(n for n in j["nodes"] if n.get("name", "").startswith("SK_med_bench"))
    for i, (x, z, nm) in enumerate(trees):
        n = copy.deepcopy(tmpl.get(nm) or next(iter(tmpl.values()))); n["name"] = f"{nm}.open{i}"; n["translation"] = [x, G, z]; n["rotation"] = [0, math.sin(i), 0, math.cos(i)]; j["nodes"].append(n); scene.append(len(j["nodes"]) - 1)
        b.col.append((x - .25, x + .25, z - .25, z + .25, G, G + 3))
    for i, (x, z, yaw) in enumerate(benches):
        n = copy.deepcopy(bench); n["name"] = f"SK_med_bench.open{i}"; n["translation"] = [x, G, z]; n["rotation"] = [0, math.sin(yaw / 2), 0, math.cos(yaw / 2)]; j["nodes"].append(n); scene.append(len(j["nodes"]) - 1)
        b.col.append((x - .9, x + .9, z - .3, z + .3, G, G + .5))
    j.setdefault("extras", {})["bazaar_open_space_pass"] = "v1"; print("wrote", path, save_glb(path, g.gltf, g.bin), "bytes")
    gc = Glb(colpath); jc = gc.gltf; cb = Builder()
    for x0, x1, z0, z1, y0, y1 in b.col: cb.box("c", x0, x1, z0, z1, y0, y1)
    emit_col = lambda: None
    prims = []; P = []; I = []
    for x0, x1, z0, z1, y0, y1 in b.col:
        base = len(P); P += [(x, y, z) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]
        for q in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)): I += [base + q[0], base + q[1], base + q[2], base + q[0], base + q[2], base + q[3]]
    Pa = np.array(P, "<f4"); Na = np.zeros_like(Pa); Na[:, 1] = 1; Ia = np.array(I, "<u4")
    pa = add_accessor(gc, add_view(gc, Pa.tobytes(), 34962), 5126, len(Pa), "VEC3", Pa.min(0).tolist(), Pa.max(0).tolist()); na = add_accessor(gc, add_view(gc, Na.tobytes(), 34962), 5126, len(Na), "VEC3")
    ia = add_accessor(gc, add_view(gc, Ia.tobytes(), 34963), 5125, len(Ia), "SCALAR"); mat = jc["meshes"][0]["primitives"][0]["material"]
    jc["meshes"].append({"name": "col_bazaar_open", "primitives": [{"attributes": {"POSITION": pa, "NORMAL": na}, "indices": ia, "material": mat}]}); jc["nodes"].append({"name": "col_bazaar_open", "mesh": len(jc["meshes"]) - 1}); jc["scenes"][0]["nodes"].append(len(jc["nodes"]) - 1)
    jc.setdefault("extras", {})["bazaar_open_space_pass"] = "v1"; print("wrote", colpath, save_glb(colpath, gc.gltf, gc.bin), "bytes")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("glb", nargs="?", default="apps/console/public/assets/world-city3.glb"); ap.add_argument("--dry-run", action="store_true"); a = ap.parse_args()
    run(a.glb, os.path.join(os.path.dirname(os.path.abspath(a.glb)), "world-city3-collision.glb"), a.dry_run)
