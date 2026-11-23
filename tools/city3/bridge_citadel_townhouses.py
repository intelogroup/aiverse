#!/usr/bin/env python3
"""Replace the eight hollow citadel boxes (shop-148..155, block (4,1)) with rows of real townhouses, in the shipped world and collision GLBs.

The boxes are facade-only shims (check_plan_vs_glb.py). Each lot now gets a row of Lost Gecko buildings (assets/townhouses, CC-BY, credits in ASSETS.md)
packed along the lot's frontage at a uniform scale of 0.9-1.2, front on the street edge. Depth is squashed to the lot depth only where a building is
deeper than the 12 m lot, which touches the side walls and leaves the facade alone.

Per lot: group node `Kit_shop<N>` (the check script reads it as the building) with one child per building; each distinct building is one shared mesh.
The shim triangles inside the lot rects are collapsed the way bridge_edge_landscape.cut does (degenerate, bytes stay until bridge_compact.py).
The collision GLB gets the same cut plus one box per building (`col_kit_shop<N>`).

GLB frame: x, y up, z = -plan y. A building's front faces +z (plan S) in its own frame; yaw puts it on the lot's `face`.

  python3 tools/city3/bridge_citadel_townhouses.py --dry-run
  python3 tools/city3/bridge_citadel_townhouses.py [world.glb] [collision.glb]
  python3 tools/city3/bridge_citadel_townhouses.py --selftest
"""
import argparse
import json
import math
import os
import random
import struct
import sys

import numpy as np

sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

ASSET = os.path.join(HERE, "assets", "townhouses")
MARK = "citadel_townhouses_pass"
SCALE_MIN, SCALE_MAX = 0.9, 1.2
MAX_PER_LOT = 4
YAW = {"S": 0.0, "N": math.pi, "E": math.pi / 2, "W": -math.pi / 2}


# ---------------------------------------------------------------- assets
def _acc(j, bin_, ai):
    a = j["accessors"][ai]
    bv = j["bufferViews"][a["bufferView"]]
    n = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
    dt = {5126: "<f4", 5125: "<u4", 5123: "<u2", 5121: "u1"}[a["componentType"]]
    stride = bv.get("byteStride")
    off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    if stride and stride != n * np.dtype(dt).itemsize:
        raise ValueError("strided view")
    return np.frombuffer(bin_, dt, a["count"] * n, off).reshape(a["count"], n if n > 1 else 1)


def _mat(n):
    if "matrix" in n:
        return np.array(n["matrix"], float).reshape(4, 4).T
    m = np.eye(4)
    if "scale" in n:
        m = np.diag([*n["scale"], 1.0]) @ m
    if "rotation" in n:
        x, y, z, w = n["rotation"]
        r = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
        t = np.eye(4); t[:3, :3] = r; m = t @ m
    if "translation" in n:
        t = np.eye(4); t[:3, 3] = n["translation"]; m = t @ m
    return m


def weld(P, N, U, I):
    """The FBX-derived meshes give every face its own vertices, which stops meshopt's simplifier (split_lod.mjs) from collapsing anything and wastes bytes.
    Merge vertices equal in position, normal and uv."""
    key = np.round(np.hstack([P * 1e4, N * 1e3, U * 1e5])).astype(np.int64)
    _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    return P[first], N[first], U[first], inv.reshape(-1)[I].astype("<u4")


def load_asset(slug):
    """-> dict(P, N, U, I, W, H, D, tex, alpha_cutoff): metres, left edge x=0, ground y=0, front plane z=0 (body toward -z), front faces +z."""
    d = os.path.join(ASSET, slug)
    j = json.load(open(os.path.join(d, "scene.gltf")))
    bin_ = open(os.path.join(d, "scene.bin"), "rb").read()
    # Sketchfab bakes the cm->m scale into a node matrix for some models and not others: a chain that does not shrink means the data is still cm
    Ps, Ns, Us, Is, base = [], [], [], [], 0

    def walk(i, parent):
        nonlocal base
        n = j["nodes"][i]
        m = parent @ _mat(n)
        if "mesh" in n:
            for p in j["meshes"][n["mesh"]]["primitives"]:
                P = _acc(j, bin_, p["attributes"]["POSITION"]).astype(float)
                N = _acc(j, bin_, p["attributes"]["NORMAL"]).astype(float)
                U = _acc(j, bin_, p["attributes"]["TEXCOORD_0"]).astype("<f4")
                I = _acc(j, bin_, p["indices"]).reshape(-1).astype("<u4")
                Ps.append((P @ m[:3, :3].T + m[:3, 3]) * (0.01 if np.linalg.norm(m[:3, 0]) > 0.5 else 1.0))
                nm = N @ np.linalg.inv(m[:3, :3])  # inverse transpose, row-vector form
                Ns.append(nm / np.linalg.norm(nm, axis=1, keepdims=True))
                Us.append(U); Is.append(I + base); base += len(P)
        for c in n.get("children", []):
            walk(c, m)

    for r in j["scenes"][j.get("scene", 0)]["nodes"]:
        walk(r, np.eye(4))
    P = np.concatenate(Ps)
    lo, hi = P.min(0), P.max(0)
    P = P - np.array([lo[0], lo[1], hi[2]])
    man = next(e for e in json.load(open(os.path.join(ASSET, "manifest.json"))) if e["slug"] == slug)
    P, N, U, I = weld(P.astype("<f4"), np.concatenate(Ns).astype("<f4"), np.concatenate(Us), np.concatenate(Is).astype("<u4"))
    return {"slug": slug, "P": P, "N": N, "U": U, "I": I, "W": float(hi[0] - lo[0]), "H": float(hi[1] - lo[1]), "D": float(hi[2] - lo[2]),
            "tex": os.path.join(d, man["texture"]), "alpha_cutoff": man["alpha_cutoff"], "far_color": man["far_color"]}


def pool_widths():
    out = {}
    for e in json.load(open(os.path.join(ASSET, "manifest.json"))):
        a = load_asset(e["slug"])
        out[e["slug"]] = (a["W"], a["H"], a["D"])
    return out


# ---------------------------------------------------------------- packing
def pack(L, pool, rng, used, max_items=MAX_PER_LOT):
    """Pick distinct buildings (slug list) whose summed width fits L at a uniform scale in [SCALE_MIN, SCALE_MAX]. Prefer scale near 1 and the least used."""
    slugs = sorted(pool)
    best = []

    def dfs(chosen, w):
        if chosen and SCALE_MIN <= L / w <= SCALE_MAX:
            best.append((abs(math.log(L / w)) + 0.15 * sum(used.get(s, 0) for s in chosen) + rng.random() * 0.05, list(chosen)))
        if len(chosen) >= max_items or w * SCALE_MIN > L:
            return
        for s in slugs:
            if s not in chosen:
                chosen.append(s); dfs(chosen, w + pool[s][0]); chosen.pop()

    dfs([], 0.0)
    if not best:
        raise ValueError(f"no packing for a {L} m frontage")
    best.sort(key=lambda t: t[0])
    pick = best[0][1]
    rng.shuffle(pick)
    return pick


def lots_from_plan():
    """-> [{id, face, rect (GLB x0,z0,x1,z1), plan_rect}] for the citadel block."""
    import check_plan_vs_glb as c
    ns = c.load_plan()
    kinds = {(b["i"], b["j"]): b["kind"] for b in ns["blocks"]}
    out = []
    for n, bd in enumerate(ns["buildings"]):
        if kinds[tuple(bd["block"])] == "citadel":
            out.append({"id": n, "face": bd["face"], "rect": c.glb_rect(bd["rect"]), "plan_rect": bd["rect"]})
    return out


def place_lot(lot, assets, rng, used):
    X0, Z0, X1, Z1 = lot["rect"]
    f = lot["face"]
    along_x = f in ("S", "N")
    L = (X1 - X0) if along_x else (Z1 - Z0)
    depth = (Z1 - Z0) if along_x else (X1 - X0)
    pool = {k: (a["W"], a["H"], a["D"]) for k, a in assets.items()}
    seq = pack(L, pool, rng, used)
    s = L / sum(pool[k][0] for k in seq)
    items, u = [], 0.0
    for k in seq:
        W, H, D = pool[k]
        sz = min(s, depth / D)          # squash depth only where the building is deeper than the lot
        w = W * s
        if f == "S":   t = (X0 + u, 0.0, Z1)
        elif f == "N": t = (X0 + u + w, 0.0, Z0)
        elif f == "E": t = (X1, 0.0, Z1 - u)
        else:          t = (X0, 0.0, Z0 + u)
        items.append({"slug": k, "t": t, "yaw": YAW[f], "s": (s, s, sz), "w": w, "h": H * s, "d": D * sz})
        used[k] = used.get(k, 0) + 1
        u += w
    return items


def build_plan(seed=148):
    lots = lots_from_plan()
    assets = {e["slug"]: load_asset(e["slug"]) for e in json.load(open(os.path.join(ASSET, "manifest.json")))}
    rng, used, plan = random.Random(seed), {}, {}
    for lot in lots:
        plan[lot["id"]] = {"lot": lot, "items": place_lot(lot, assets, rng, used)}
    return plan, assets


# ---------------------------------------------------------------- GLB
def _quat_y(a):
    return [0.0, math.sin(a / 2), 0.0, math.cos(a / 2)]


def footprint(it):
    """GLB-frame (x0, z0, x1, z1) of an item, from its transform: local x in [0,w], z in [-d,0]."""
    c, s = math.cos(it["yaw"]), math.sin(it["yaw"])
    pts = [(lx, lz) for lx in (0.0, it["w"]) for lz in (0.0, -it["d"])]
    xs = [it["t"][0] + lx * c + lz * s for lx, lz in pts]
    zs = [it["t"][2] - lx * s + lz * c for lx, lz in pts]
    return min(xs), min(zs), max(xs), max(zs)


def box_mesh(x0, z0, x1, z1, h):
    P = np.array([[x, y, z] for y in (0.0, h) for z in (z0, z1) for x in (x0, x1)], "<f4")
    I = np.array([0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3], "<u2")
    return P, I


def apply(world, col, plan, assets, dry):
    from bridge_edge_landscape import cut
    from bridge_landscape_kit import add_accessor, add_view
    rects = [p["lot"]["plan_rect"] for p in plan.values()]
    rep = {"visual_cut": cut(world, rects, False, dry), "collision_cut": cut(col, rects, True, dry)}
    if dry:
        return rep
    g = world.gltf
    scene = g["scenes"][g.get("scene", 0)]["nodes"]

    def acc(a, typ, mm=False):
        a = np.ascontiguousarray(a)
        ct = {"<f4": 5126, "<u4": 5125, "<u2": 5123}[a.dtype.str]
        return add_accessor(world, add_view(world, a.tobytes(), 34962), ct, len(a), typ, a.min(0).tolist() if mm else None, a.max(0).tolist() if mm else None)

    meshes = {}
    for slug in sorted({it["slug"] for p in plan.values() for it in p["items"]}):
        a = assets[slug]
        v = add_view(world, open(a["tex"], "rb").read(), None)
        g["bufferViews"][v].pop("target", None)
        g.setdefault("images", []).append({"name": "townhouse_" + slug, "bufferView": v, "mimeType": "image/png" if a["tex"].endswith(".png") else "image/jpeg"})
        g.setdefault("textures", []).append({"source": len(g["images"]) - 1})
        mat = {"name": "Townhouse_" + slug, "doubleSided": True, "pbrMetallicRoughness": {"baseColorTexture": {"index": len(g["textures"]) - 1}, "metallicFactor": 0.0, "roughnessFactor": 0.9}}
        mat["extras"] = {"far_color": a["far_color"]}   # split_lod.mjs: a flat colour stands in for the texture in the far view (5 MB budget)
        if a["alpha_cutoff"] is not None:
            mat["alphaMode"], mat["alphaCutoff"] = "MASK", a["alpha_cutoff"]
        g["materials"].append(mat)
        prim = {"attributes": {"POSITION": acc(a["P"], "VEC3", True), "NORMAL": acc(a["N"], "VEC3"), "TEXCOORD_0": acc(a["U"], "VEC2")},
                "indices": add_accessor(world, add_view(world, a["I"].tobytes(), 34963), 5125, len(a["I"]), "SCALAR"), "material": len(g["materials"]) - 1}
        g["meshes"].append({"name": "Townhouse_" + slug, "primitives": [prim]})
        meshes[slug] = len(g["meshes"]) - 1

    cg = col.gltf
    cscene = cg["scenes"][cg.get("scene", 0)]["nodes"]
    for lid, p in sorted(plan.items()):
        kids, bx = [], []
        for it in p["items"]:
            g["nodes"].append({"name": f"Kit_shop{lid}_{it['slug']}", "mesh": meshes[it["slug"]], "translation": list(it["t"]), "rotation": _quat_y(it["yaw"]), "scale": list(it["s"])})
            kids.append(len(g["nodes"]) - 1)
            bx.append((*footprint(it), it["h"]))
        g["nodes"].append({"name": f"Kit_shop{lid}", "children": kids})
        scene.append(len(g["nodes"]) - 1)
        Ps, Is, base = [], [], 0
        for x0, z0, x1, z1, h in bx:
            P, I = box_mesh(x0, z0, x1, z1, h)
            Ps.append(P); Is.append(I + base); base += len(P)
        P, I = np.concatenate(Ps), np.concatenate(Is).astype("<u2")
        prim = {"attributes": {"POSITION": add_accessor(col, add_view(col, P.tobytes(), 34962), 5126, len(P), "VEC3", P.min(0).tolist(), P.max(0).tolist())},
                "indices": add_accessor(col, add_view(col, I.tobytes(), 34963), 5123, len(I), "SCALAR"), "material": 0}
        cg["meshes"].append({"name": f"col_kit_shop{lid}", "primitives": [prim]})
        cg["nodes"].append({"name": f"col_kit_shop{lid}", "mesh": len(cg["meshes"]) - 1})
        cscene.append(len(cg["nodes"]) - 1)
    for gl in (g, cg):
        gl.setdefault("extras", {})[MARK] = "v1"
    return rep


def describe(plan):
    for lid, p in sorted(plan.items()):
        L = p["lot"]["rect"]
        print(f"shop-{lid} {p['lot']['face']} rect {np.round(L, 1).tolist()}: " + ", ".join(f"{it['slug']}(x{it['s'][0]:.2f}, d{it['d']:.1f}, h{it['h']:.1f})" for it in p["items"]))


def selftest():
    rng = random.Random(1)
    pool = {"a": (10, 15, 15), "b": (7.7, 18, 11), "c": (25.8, 14, 15), "d": (12.1, 12, 16)}
    for L in (10, 12, 18, 20, 26):
        seq = pack(L, pool, rng, {})
        s = L / sum(pool[k][0] for k in seq)
        assert SCALE_MIN <= s <= SCALE_MAX and len(set(seq)) == len(seq), (L, seq, s)
    try:
        pack(1.0, pool, rng, {}); raise SystemExit("expected a packing error")
    except ValueError:
        pass
    it = {"t": (10.0, 0.0, 5.0), "yaw": YAW["E"], "w": 8.0, "d": 12.0}   # faces +x: body toward -x, row toward -z
    x0, z0, x1, z1 = footprint(it)
    assert (round(x0, 6), round(x1, 6)) == (-2.0, 10.0) and (round(z0, 6), round(z1, 6)) == (-3.0, 5.0), (x0, z0, x1, z1)
    print("selftest ok")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("world", nargs="?", default="apps/console/public/assets/world-city3.glb")
    ap.add_argument("collision", nargs="?", default="apps/console/public/assets/world-city3-collision.glb")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        selftest(); sys.exit(0)
    from bridge_wave1 import Glb, save_glb
    plan, assets = build_plan()
    describe(plan)
    world, col = Glb(a.world), Glb(a.collision)
    if world.gltf.get("extras", {}).get(MARK):
        print({"already_patched": True}); sys.exit(0)
    rep = apply(world, col, plan, assets, a.dry_run)
    print(json.dumps(rep))
    if not a.dry_run:
        print("wrote", a.world, save_glb(a.world, world.gltf, world.bin), "bytes")
        print("wrote", a.collision, save_glb(a.collision, col.gltf, col.bin), "bytes")
