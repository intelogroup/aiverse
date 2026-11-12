#!/usr/bin/env python3
"""Tea House walls and stairs, patched onto the shipped world-city3.glb (run after bridge_tea_floors.py).

1. Swaps the generated 7-16 KB `plaster` / `wood` images used by the Tea House materials (G_*, L1_*, L2_*, L3_*)
   for Poly Haven CC0 white_stucco / dark_wood and adds a normal map to each. Tints (baseColorFactor) are kept.
2. Ground-floor partitions, stair walls and the inner shell faces had no finish at all (flat colour, no UVs):
   re-emitted with planar UVs and the stucco texture, warm cream tint.
3. Stair treads/risers (`{G,L1,L2,L3}_stair`, flat terracotta, no UVs): planar UVs + stair_planks.
Visual meshes only; collision GLB untouched.
  python3 tools/city3/bridge_tea_surfaces.py [--glb ...] [--out ...] [--dry-run]
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
from bridge_landscape_kit import add_accessor, add_view
from bridge_wave1 import Glb, save_glb
TEX = os.path.join(HERE, "assets", "tea-floors")
INNER = [(0, .3), (0, 24.7), (2, -.3), (2, -11.7)]


def run(src, dst, dry):
    g = Glb(src); j = g.gltf
    if any(m.get("name") == "TeaStair" for m in j["materials"]):
        sys.exit("already patched")
    meta = json.load(open(os.path.join(TEX, "sources.json")))
    nodes = j["nodes"]; house = next(n for n in nodes if n.get("name") == "TeaHouseStructure")
    cache = {}

    def tex(tid):
        if tid not in cache:
            idx = []
            for suf in ("c", "n"):
                v = add_view(g, open(os.path.join(TEX, f"{tid}_{suf}.jpg"), "rb").read(), None); j["bufferViews"][v].pop("target", None)
                j["images"].append({"name": f"tea_{tid}_{suf}", "bufferView": v, "mimeType": "image/jpeg"})
                j["textures"].append({"source": len(j["images"]) - 1}); idx.append(len(j["textures"]) - 1)
            cache[tid] = idx
        return cache[tid]

    def image_name(m):
        t = j["textures"][m["pbrMetallicRoughness"]["baseColorTexture"]["index"]]
        s = t.get("source", t.get("extensions", {}).get("KHR_texture_basisu", {}).get("source"))
        return j["images"][s].get("name")

    swapped = {}
    for m in j["materials"]:
        if not m.get("name", "")[:2] in ("G_", "L1", "L2", "L3") or "baseColorTexture" not in m.get("pbrMetallicRoughness", {}): continue
        nm = image_name(m); tid = {"plaster": "white_stucco", "wood": "dark_wood"}.get(nm)
        if not tid: continue
        c, n = tex(tid); m["pbrMetallicRoughness"]["baseColorTexture"] = {"index": c}; m["normalTexture"] = {"index": n, "scale": 1.0}
        swapped[tid] = swapped.get(tid, 0) + 1

    def material(name, tid, factor, rough):
        c, n = tex(tid)
        j["materials"].append({"name": name, "pbrMetallicRoughness": {"baseColorFactor": [*factor, 1], "baseColorTexture": {"index": c},
                               "metallicFactor": 0.0, "roughnessFactor": rough}, "normalTexture": {"index": n, "scale": 1.0}})
        return len(j["materials"]) - 1

    def retexture(nodename, select, mat, tile):
        node = next((nodes[i] for i in house["children"] if nodes[i].get("name") == nodename), None)
        if node is None: return 0
        done = 0
        prims = j["meshes"][node["mesh"]]["primitives"]
        for prim in list(prims):
            P = g.acc_raw(prim["attributes"]["POSITION"]); N = g.acc_raw(prim["attributes"]["NORMAL"])
            ix = g.indices_of(prim) if "indices" in prim else np.arange(len(P))
            pos = P[ix].reshape(-1, 3, 3); nrm = N[ix].reshape(-1, 3, 3)
            sel = np.array([select(t) for t in pos])
            if not sel.any(): continue
            done += int(sel.sum())
            if dry: continue
            keepP, keepN = pos[~sel].reshape(-1, 3), nrm[~sel].reshape(-1, 3)
            sp, sn = pos[sel].reshape(-1, 3).astype("<f4"), nrm[sel].reshape(-1, 3).astype("<f4")
            horiz = np.abs(sn[:, 1]) > np.maximum(np.abs(sn[:, 0]), np.abs(sn[:, 2]))
            u = np.where(horiz, sp[:, 0], np.where(np.abs(sn[:, 0]) > np.abs(sn[:, 2]), sp[:, 2], sp[:, 0]))
            v = np.where(horiz, sp[:, 2], sp[:, 1])
            uv = (np.stack([u, v], 1) / tile).astype("<f4")
            def acc(arr, typ, mm=False):
                a = np.ascontiguousarray(arr, "<f4")
                return add_accessor(g, add_view(g, a.tobytes(), 34962), 5126, len(a), typ,
                                    a.min(0).tolist() if mm else None, a.max(0).tolist() if mm else None)
            if len(keepP):
                prim["attributes"] = {"POSITION": acc(keepP, "VEC3", True), "NORMAL": acc(keepN, "VEC3")}; prim.pop("indices", None)
            else:
                prims.remove(prim)
            prims.append({"attributes": {"POSITION": acc(sp, "VEC3", True), "NORMAL": acc(sn, "VEC3"), "TEXCOORD_0": acc(uv, "VEC2")}, "material": mat})
        return done

    inner = lambda t: any(all(abs(p[a] - v) < .001 for p in t) for a, v in INNER)
    allf = lambda t: True
    wall = material("TeaWall_G", "white_stucco", (0.95, 0.88, 0.74), 0.85)
    stair = material("TeaStair", "stair_planks", (1, 1, 1), 0.75)
    rep = {"swapped_materials": swapped}
    for nn, sel in (("G_partition", allf), ("G_stairwall", allf), ("G_shell", inner)): rep[nn] = retexture(nn, sel, wall, 1.6)
    for L in ("G", "L1", "L2", "L3"): rep[L + "_stair"] = retexture(L + "_stair", allf, stair, 1.2)
    print(json.dumps(rep))
    if not dry: print("wrote", dst, save_glb(dst, g.gltf, g.bin), "bytes")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--glb", default="apps/console/public/assets/world-city3.glb")
    ap.add_argument("--out"); ap.add_argument("--dry-run", action="store_true"); a = ap.parse_args()
    run(a.glb, a.out or a.glb, a.dry_run)
