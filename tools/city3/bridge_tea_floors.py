#!/usr/bin/env python3
"""Textured floors for the four Tea House levels, patched into the shipped world-city3.glb.

Why not tea_house/prepare.mjs: it rebuilds the city from commit 22ba63a, which predates the KTX2/meshopt world,
so re-running it would undo later main changes. This patch is append-only on the current GLB (bridge_*.py family).

Every level's walkable floor is one grey `Structure_slab` material with no UVs. For each level this takes the slab's
up-facing triangles at floor height, clips them to the plan's room rectangles (so stair/lift openings in the slab stay
exactly where they are), and re-emits them as per-room primitives with a Poly Haven CC0 colour + normal texture
(planar world-space UVs). Wet rooms, lift and shaft rooms keep the original slab faces (their own tile meshes sit there).
Geometry that anything walks on is the separate collision GLB, which this does not touch.

  python3 tools/city3/bridge_tea_floors.py [--glb apps/console/public/assets/world-city3.glb] [--dry-run]
Afterwards run bridge_compact.py (the replaced slab streams become dead bytes).
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import numpy as np
from bridge_landscape_kit import add_accessor, add_view
from bridge_wave1 import Glb, save_glb

TEX = os.path.join(HERE, "assets", "tea-floors")
PLAN = os.path.join(HERE, "..", "..", "docs", "procedural-city", "tea-house", "plan.json")
FLOOR_Y = {"G": 0.48, "L1": 4.40, "L2": 7.90, "L3": 11.40}
SKIP_KINDS = {"wet", "lift", "shaft"}
ROUGH = {"tatami_mat": 0.95, "interior_tiles": 0.45, "floor_tiles_06": 0.4, "patterned_terracotta_tiling": 0.55,
         "marble_mosaic_tiles": 0.4}


def floor_for(level, room):
    i, k = room["id"], room["kind"]
    if k == "stair":
        return "stair_planks"
    if level == "G":
        if i in ("tea-seating", "bar-guests"): return "hinoki_planks"
        if i in ("bar-counter", "bar-staff", "bar-shelves") or i.startswith("staff-entry"): return "oak_wood_planks"
        if i == "cloak": return "laminate_floor_02"
        return "interior_tiles"                      # entry, exits, lobby
    if i == "core-lobby": return "interior_tiles"
    if i == "corridor": return "oak_wood_planks"
    if level == "L1":
        return {"tasting": "tatami_mat", "salon": "herringbone_parquet", "reading": "wooden_floor_02",
                "pantry": "floor_tiles_06", "staff": "laminate_floor_02"}.get(i.split()[0], "oak_wood_planks")
    if i.endswith("-kitchen"):
        return "patterned_terracotta_tiling" if level == "L2" else "interior_tiles"
    if i.endswith("-living") or i == "rear-east":
        return "wooden_floor_02" if level == "L2" else "laminate_floor_02"
    return "laminate_floor_02"                      # rear service / rear rooms


def clip_half(poly, ax, k, keep_less):
    out = []
    for a, b in zip(poly, poly[1:] + poly[:1]):
        ia = (a[ax] <= k) if keep_less else (a[ax] >= k)
        ib = (b[ax] <= k) if keep_less else (b[ax] >= k)
        if ia: out.append(a)
        if ia != ib:
            t = (k - a[ax]) / (b[ax] - a[ax]); out.append(tuple(a[c] + t * (b[c] - a[c]) for c in range(3)))
    return out


def clip_rect(poly, r):
    x0, x1, z0, z1 = r
    for ax, k, less in ((0, x0, False), (0, x1, True), (2, z0, False), (2, z1, True)):
        if len(poly) < 3: return []
        poly = clip_half(poly, ax, k, less)
    return poly if len(poly) >= 3 else []


def outside_rect(poly, r):
    x0, x1, z0, z1 = r; res = []
    for ax, k, less, kk, kless in ((0, x0, True, None, None), (0, x1, False, None, None)):
        part = clip_half(poly, ax, k, less)
        if len(part) >= 3: res.append(part)
        poly = clip_half(poly, ax, k, not less)
        if len(poly) < 3: return res
    for ax, k, less in ((2, z0, True), (2, z1, False)):
        part = clip_half(poly, ax, k, less)
        if len(part) >= 3: res.append(part)
        poly = clip_half(poly, ax, k, not less)
        if len(poly) < 3: return res
    return res


def area(p):
    return abs(sum(a[0] * b[2] - b[0] * a[2] for a, b in zip(p, p[1:] + p[:1]))) / 2


def fan(poly):
    return [(poly[0], poly[i], poly[i + 1]) for i in range(1, len(poly) - 1)]


def run(src, dst, dry):
    g = Glb(src); j = g.gltf
    if any(m.get("name", "").startswith("TeaFloor_") for m in j["materials"]):
        sys.exit("already patched (TeaFloor_* materials exist); start from the unpatched GLB")
    plan = json.load(open(PLAN)); meta = json.load(open(os.path.join(TEX, "sources.json")))
    nodes = j["nodes"]; house = next(n for n in nodes if n.get("name") == "TeaHouseStructure")
    mats = {}

    def material(tid):
        if tid in mats: return mats[tid]
        idx = []
        for suf in ("c", "n"):
            data = open(os.path.join(TEX, f"{tid}_{suf}.jpg"), "rb").read()
            v = add_view(g, data, None); j["bufferViews"][v].pop("target", None)
            j.setdefault("images", []).append({"name": f"tea_floor_{tid}_{suf}", "bufferView": v, "mimeType": "image/jpeg"})
            j.setdefault("textures", []).append({"source": len(j["images"]) - 1}); idx.append(len(j["textures"]) - 1)
        j["materials"].append({"name": "TeaFloor_" + tid, "pbrMetallicRoughness": {
            "baseColorFactor": [1, 1, 1, 1], "baseColorTexture": {"index": idx[0]},
            "metallicFactor": 0.0, "roughnessFactor": ROUGH.get(tid, 0.8)}, "normalTexture": {"index": idx[1], "scale": 1.0}})
        mats[tid] = len(j["materials"]) - 1
        return mats[tid]

    report = {}
    for lv in plan["levels"]:
        L = lv["id"]; fy = FLOOR_Y[L]
        node = next(nodes[i] for i in house["children"] if nodes[i].get("name") == f"{L}_slab")
        prim = j["meshes"][node["mesh"]]["primitives"][0]
        P0 = g.acc_raw(prim["attributes"]["POSITION"]); N0 = g.acc_raw(prim["attributes"]["NORMAL"])
        ix = g.indices_of(prim) if "indices" in prim else np.arange(len(P0))
        pos = P0[ix].reshape(-1, 3, 3); nrm = N0[ix].reshape(-1, 3, 3)
        top = (np.abs(pos[:, :, 1] - fy) < 0.005).all(1) & (nrm[:, :, 1] > 0.9).all(1)
        rooms = []
        for r in lv["rooms"]:
            if r["kind"] in SKIP_KINDS and r["id"] != "pantry": continue
            u0, d0, u1, d1 = r["rect"]; rooms.append((r, floor_for(L, r), (u0, u1, -d1, -d0)))
        keep_p, keep_n = [pos[~top].reshape(-1, 3)], [nrm[~top].reshape(-1, 3)]
        buckets = {}; left = []
        for t in pos[top]:
            poly = [tuple(v) for v in t]; rest = [poly]
            for r, tid, rect in rooms:
                nxt = []
                for pc in rest:
                    ins = clip_rect(pc, rect)
                    if ins and area(ins) > 1e-6: buckets.setdefault(tid, []).extend(fan(ins))
                    nxt += [o for o in outside_rect(pc, rect) if area(o) > 1e-6]
                rest = nxt
            for pc in rest: left += fan(pc)
        if left:
            a = np.array([v for tri in left for v in tri], "f4"); keep_p.append(a)
            keep_n.append(np.tile(np.array([0, 1, 0], "f4"), (len(a), 1)))
        report[L] = {"top_tris": int(top.sum()), "textured": {k: len(v) for k, v in buckets.items()}, "left": len(left)}
        if dry: continue
        P = np.concatenate(keep_p).astype("<f4"); N = np.concatenate(keep_n).astype("<f4")
        vp = add_view(g, P.tobytes(), 34962); vn = add_view(g, N.tobytes(), 34962)
        prim["attributes"]["POSITION"] = add_accessor(g, vp, 5126, len(P), "VEC3", P.min(0).tolist(), P.max(0).tolist())
        prim["attributes"]["NORMAL"] = add_accessor(g, vn, 5126, len(N), "VEC3")
        prim.pop("indices", None)
        for tid, tris in buckets.items():
            pts = np.array([v for t in tris for v in t], "<f4"); tile = meta[tid]["tileMetres"]
            nn = np.tile(np.array([0, 1, 0], "<f4"), (len(pts), 1)); uv = np.stack([pts[:, 0], pts[:, 2]], 1) / tile
            a = add_accessor(g, add_view(g, pts.tobytes(), 34962), 5126, len(pts), "VEC3", pts.min(0).tolist(), pts.max(0).tolist())
            b = add_accessor(g, add_view(g, nn.tobytes(), 34962), 5126, len(pts), "VEC3")
            c = add_accessor(g, add_view(g, uv.astype("<f4").tobytes(), 34962), 5126, len(pts), "VEC2")
            j["meshes"][node["mesh"]]["primitives"].append(
                {"attributes": {"POSITION": a, "NORMAL": b, "TEXCOORD_0": c}, "material": material(tid)})
    print(json.dumps(report, indent=1))
    if not dry:
        print("wrote", dst, save_glb(dst, g.gltf, g.bin), "bytes")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--glb", default="apps/console/public/assets/world-city3.glb")
    ap.add_argument("--out"); ap.add_argument("--dry-run", action="store_true"); a = ap.parse_args()
    run(a.glb, a.out or a.glb, a.dry_run)
