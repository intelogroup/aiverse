#!/usr/bin/env python3
"""Furniture for the four Tea House levels, patched onto the shipped world-city3.glb + world-city3-collision.glb.

Why real nodes and not the instanced interior library: library furnishings are never clipped by the floor cutaway
(GlbWorld.tsx), so upper-floor pieces would float above a lower-floor cutaway. Plain scene meshes share the city
materials' clipping. Each prop's geometry is stored once (one glTF mesh); every placement is a node that references it.
Layout: tea_house/props_layout.py (validated against doors, room edges and overlaps). Collision: one axis-aligned,
noGround box per piece (blocks walking, never becomes floor) in the collision GLB.
Run after bridge_tea_floors.py / bridge_tea_surfaces.py.
  python3 tools/city3/bridge_tea_props.py [--glb ...] [--col ...] [--dry-run]
"""
import argparse, json, math, os, sys
sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, "tea_house"))
import numpy as np
from bridge_landscape_kit import add_accessor, add_view
from bridge_wave1 import Glb, save_glb
import props_layout as PL
ASSETS = os.path.join(HERE, "assets", "tea-props")
PLAN = os.path.join(HERE, "..", "..", "docs", "procedural-city", "tea-house", "plan.json")
FLOOR_Y = {"G": 0.48, "L1": 4.40, "L2": 7.90, "L3": 11.40}
ORIGIN = (-37.5, 0.0, -72.5)


def load_props(meta):
    props = {}
    for pid in meta:
        g = Glb(os.path.join(ASSETS, pid + ".glb")); j = g.gltf; prims = []; mn = np.full(3, 1e9); mx = np.full(3, -1e9)
        for m in j["meshes"]:
            for p in m["primitives"]:
                P = g.acc_raw(p["attributes"]["POSITION"]); mn = np.minimum(mn, P.min(0)); mx = np.maximum(mx, P.max(0))
                prims.append({"P": P.astype("<f4"), "N": g.acc_raw(p["attributes"]["NORMAL"]).astype("<f4"),
                              "U": g.acc_raw(p["attributes"]["TEXCOORD_0"]).astype("<f4"),
                              "I": g.indices_of(p).astype("<u4"), "mat": j["materials"][p["material"]]["name"]})
        props[pid] = {"prims": prims, "dims": (float(mx[0] - mn[0]), float(mx[1] - mn[1]), float(mx[2] - mn[2]),
                                               float((mx[0] + mn[0]) / 2), float((mx[2] + mn[2]) / 2)), "ymin": float(mn[1])}
    return props


def box_tris(x0, x1, y0, y1, z0, z1):
    v = [(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1), (x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1)]
    out = []
    for a, b, c, d in ((1, 2, 3, 0), (4, 5, 1, 0), (5, 6, 2, 1), (6, 7, 3, 2), (7, 4, 0, 3), (7, 6, 5, 4)):
        out += [v[a], v[b], v[c], v[a], v[c], v[d]]
    return np.array(out, "<f4")


def run(glb_path, col_path, dry):
    meta = json.load(open(os.path.join(ASSETS, "meta.json"))); plan = json.load(open(PLAN))
    props = load_props(meta)
    placed, errs = PL.build(plan, {k: v["dims"] for k, v in props.items()}, strict=not dry)
    if dry:
        for e in errs: print("ERR", e)
        print({L: len(v) for L, v in placed.items()}, "errors", len(errs)); return
    g = Glb(glb_path); j = g.gltf; c = Glb(col_path); cj = c.gltf
    if any(m.get("name", "").startswith("TeaProp_") for m in j["materials"]): sys.exit("already patched")
    house = next(n for n in j["nodes"] if n.get("name") == "TeaHouseStructure")
    mesh_of = {}; tcache = {}

    def tex(fn, normal):
        if fn not in tcache:
            v = add_view(g, open(os.path.join(ASSETS, fn), "rb").read(), None); j["bufferViews"][v].pop("target", None)
            j["images"].append({"name": "tea_prop_" + fn[:-4], "bufferView": v, "mimeType": "image/jpeg"})
            j["textures"].append({"source": len(j["images"]) - 1}); tcache[fn] = len(j["textures"]) - 1
        return tcache[fn]

    def acc(arr, typ, target=34962, mm=False, ctype=5126):
        a = np.ascontiguousarray(arr)
        return add_accessor(g, add_view(g, a.tobytes(), target), ctype, len(a), typ, a.min(0).tolist() if mm else None, a.max(0).tolist() if mm else None)

    def mesh_for(pid):
        if pid in mesh_of: return mesh_of[pid]
        prims = []
        for p in props[pid]["prims"]:
            if p["mat"].endswith(("_glass", "_flame")): continue  # BLEND materials would render as opaque colour cards
            e = meta[pid]["materials"][p["mat"]]
            mat = {"name": f"TeaProp_{pid}_{p['mat']}", "doubleSided": e["doubleSided"], "pbrMetallicRoughness": {
                "baseColorFactor": [1, 1, 1, 1], "baseColorTexture": {"index": tex(e["color"], False)}, "metallicFactor": 0.0, "roughnessFactor": 0.8}}
            if e["normal"]: mat["normalTexture"] = {"index": tex(e["normal"], True), "scale": 1.0}
            j["materials"].append(mat)
            prims.append({"attributes": {"POSITION": acc(p["P"], "VEC3", mm=True), "NORMAL": acc(p["N"], "VEC3"), "TEXCOORD_0": acc(p["U"], "VEC2")},
                          "indices": acc(p["I"].reshape(-1, 1), "SCALAR", target=34963, ctype=5125), "material": len(j["materials"]) - 1})
        j["meshes"].append({"name": "TeaProp_" + pid, "primitives": prims}); mesh_of[pid] = len(j["meshes"]) - 1
        return mesh_of[pid]

    n_nodes = n_col = 0
    for L, items in placed.items():
        fy = FLOOR_Y[L]
        for k, it in enumerate(items):
            pr = props[it["prop"]]; y = fy - pr["ymin"]; yaw = it["yaw"]
            j["nodes"].append({"name": f"{L}_prop_{k:02d}_{it['prop']}", "mesh": mesh_for(it["prop"]), "translation": [it["u"], y, -it["d"]],
                               "rotation": [0, math.sin(yaw / 2), 0, math.cos(yaw / 2)], "extras": {"level": L, "category": "furniture", "building": "tea"}})
            house["children"].append(len(j["nodes"]) - 1); n_nodes += 1
            u0, u1, d0, d1 = it["rect"]; h = it["h"]
            tri = box_tris(u0 + ORIGIN[0], u1 + ORIGIN[0], fy, fy + h, -d1 + ORIGIN[2], -d0 + ORIGIN[2])
            a = add_accessor(c, add_view(c, tri.tobytes(), 34962), 5126, len(tri), "VEC3", tri.min(0).tolist(), tri.max(0).tolist())
            cj["meshes"].append({"name": f"col_tea_prop_{L}_{k}", "primitives": [{"attributes": {"POSITION": a}, "material": 0}]})
            cj["nodes"].append({"name": f"col_tea_prop_{L}_{k:02d}_{it['prop']}", "mesh": len(cj["meshes"]) - 1, "extras": {"noGround": True}})
            cj["scenes"][cj.get("scene", 0)]["nodes"].append(len(cj["nodes"]) - 1); n_col += 1
    print("visual nodes", n_nodes, "collision boxes", n_col, "meshes", len(mesh_of))
    print("wrote", glb_path, save_glb(glb_path, g.gltf, g.bin)); print("wrote", col_path, save_glb(col_path, c.gltf, c.bin))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--glb", default="apps/console/public/assets/world-city3.glb")
    ap.add_argument("--col", default="apps/console/public/assets/world-city3-collision.glb"); ap.add_argument("--dry-run", action="store_true"); a = ap.parse_args()
    run(a.glb, a.col, a.dry_run)
