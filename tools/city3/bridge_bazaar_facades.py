#!/usr/bin/env python3
"""Bazaar exterior texture pass, patched onto the shipped world-city3.glb (run after bridge_bazaar_fixes.py).

The five `B_Facade_<colour>` meshes carry every wall of the island with one cloudy painted-strip texture, so every shop
looks like the same cream plaster with brown bands. Here each wall triangle is re-bound by the hero shop class it belongs to:
  shop -> rough lime plaster, cafe -> worn painted plaster, library -> sandstone ashlar,
  workshop -> worn brick, press -> stacked brick; non-hero footprints -> rough plaster.
The old facade colour survives as the tint (baseColorFactor). The new textures ride the wall-planar second UV channel
(u along the wall, v = world height, 3.5 m per unit) through KHR_texture_transform, so tile size is set in metres.
Tea House lot is skipped. Visual meshes only; collision GLB untouched.
  python3 tools/city3/bridge_bazaar_facades.py [glb] [--dry-run]
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
from bridge_landscape_kit import add_accessor, add_view
from bridge_wave1 import Glb, save_glb

TEX = os.path.join(HERE, "assets", "bazaar-facades")
HEROES = os.path.join(HERE, "out", "heroes.json")
# class -> (texture id, tile metres, roughness)
STYLE = {"shop": ("white_stucco_02", 1.8, .9), "cafe": ("white_plaster_02", 2.0, .88), "library": ("white_sandstone_bricks_03", 2.0, .85),
         "workshop": ("worn_brick_wall", 2.0, .9), "press": ("stacked_brick_wall", 1.73, .9)}
TINT = {"sand": (1, .93, .8), "ochre": (1, .82, .55), "white": (1, .98, .94), "rose": (.95, .72, .66), "blue": (.72, .8, .92)}
# how much of the old facade colour a class keeps (brick and ashlar read as their own material)
KEEP = {"shop": 1.0, "cafe": 1.0, "library": .35, "workshop": .25, "press": .25}
INFLATE = .3


def classify(c, heroes):
    """hero class per triangle centroid (None outside every hero rect, 'tea' for the Tea House)."""
    cls = np.full(len(c), None, dtype=object); best = np.full(len(c), 1e9)
    for h in heroes:
        r = h["rect"]
        ex = np.maximum.reduce([r[0] - c[:, 0], c[:, 0] - r[2], r[1] - c[:, 2], c[:, 2] - r[3]])
        m = (ex < INFLATE) & (ex < best)
        cls[m] = h["template"]; best[m] = ex[m]
    return cls


COLORS = ["sand", "ochre", "white", "rose", "blue"]
TRIM = ("stone_block_wall", 2.1)  # floor-slab edges seen from the street: stone string course instead of brown wood


def bones_exterior(g, heroes, material, tex, dry):
    """Each Bones_shop shell is one mesh: split its outward wall faces (on the hero rect boundary, normal pointing out) and the
    floor-slab edges into new primitives with the class masonry and planar UVs; the rest (interior) is untouched."""
    j = g.gltf; rep = {"shell_faces": 0, "slab_faces": 0, "shops": 0}
    by_id = {h["id"]: h for h in heroes}
    trim_mat = {}
    def trim(color):
        if color not in trim_mat:
            c, n = tex(TRIM[0]); s = 1.0 / TRIM[1]; tr = {"KHR_texture_transform": {"scale": [s, s]}}
            j["materials"].append({"name": f"BzTrim_{color}", "pbrMetallicRoughness": {"baseColorFactor": [*[1 + (t - 1) * .3 for t in TINT[color]], 1],
                                   "metallicFactor": 0.0, "roughnessFactor": .9, "baseColorTexture": {"index": c, "extensions": dict(tr)}},
                                   "normalTexture": {"index": n, "scale": 1.0, "extensions": dict(tr)}})
            trim_mat[color] = len(j["materials"]) - 1
        return trim_mat[color]
    def acc(arr, typ, mm=False):
        a = np.ascontiguousarray(arr, "<f4")
        return add_accessor(g, add_view(g, a.tobytes(), 34962), 5126, len(a), typ, a.min(0).tolist() if mm else None, a.max(0).tolist() if mm else None)
    for node in j["nodes"]:
        nm = node.get("name", "")
        if not nm.startswith("Bones_shop") or "mesh" not in node: continue
        h = by_id.get("shop-" + nm[len("Bones_shop"):])
        if not h or h["template"] not in STYLE: continue
        rep["shops"] += 1
        r = h["rect"]; color = COLORS[int(nm[len("Bones_shop"):]) % 5]
        planes = [(0, r[0], -1.0), (0, r[2], 1.0), (2, r[1], -1.0), (2, r[3], 1.0)]  # axis, coord, outward sign
        prims = j["meshes"][node["mesh"]]["primitives"]
        for prim in list(prims):
            mname = j["materials"][prim["material"]]["name"]
            kind = "shell" if mname.startswith("ls_bones_shell") else "slab" if mname.startswith("ls_bones_slab") else None
            if not kind: continue
            P = g.acc_raw(prim["attributes"]["POSITION"]); I = g.indices_of(prim).reshape(-1, 3); T = P[I]
            e1, e2 = T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]; fn = np.cross(e1, e2); ln = np.linalg.norm(fn, axis=1); ln[ln == 0] = 1; fn /= ln[:, None]
            sel = np.zeros(len(I), bool)
            for ax, v, sg in planes:
                sel |= np.all(np.abs(T[:, :, ax] - v) < .15, axis=1) & (fn[:, ax] * sg > .9)
            if kind == "slab":  # slab edges: only the vertical rim, not the horizontal floor
                sel &= np.abs(fn[:, 1]) < .5
            if not sel.any(): continue
            rep[kind + "_faces"] += int(sel.sum())
            if dry: continue
            S = T[sel].reshape(-1, 3).astype("<f4"); SN = np.repeat(fn[sel], 3, axis=0).astype("<f4")
            alongx = np.abs(SN[:, 2]) > np.abs(SN[:, 0])
            uv = np.stack([np.where(alongx, S[:, 0], S[:, 2]), S[:, 1]], 1).astype("<f4")  # metres; TEXCOORD_0 feeds the trim (scale 1/tile)
            mat = trim(color) if kind == "slab" else material(h["template"], color)  # wall materials read TEXCOORD_1 in 3.5 m units
            keep = I[~sel].astype("<u4").ravel()
            if len(keep):
                prim["indices"] = add_accessor(g, add_view(g, keep.tobytes(), 34963), 5125, len(keep), "SCALAR")
            else: prims.remove(prim)
            prims.append({"attributes": {"POSITION": acc(S, "VEC3", True), "NORMAL": acc(SN, "VEC3"), "TEXCOORD_0": acc(uv, "VEC2"), "TEXCOORD_1": acc(uv / 3.5, "VEC2")}, "material": mat})
    return rep


def run(path, dry):
    g = Glb(path); j = g.gltf
    if j.get("extras", {}).get("bazaar_facades_pass"):
        print({"already_patched": True}); return
    heroes = json.load(open(HEROES)); meta = json.load(open(os.path.join(TEX, "sources.json")))
    cache, mats, rep = {}, {}, {"tris": {}}

    def tex(tid):
        if tid not in cache:
            idx = []
            for suf in ("c", "n"):
                v = add_view(g, open(os.path.join(TEX, f"{tid}_{suf}.jpg"), "rb").read(), None); j["bufferViews"][v].pop("target", None)
                j["images"].append({"name": f"bzf_{tid}_{suf}", "bufferView": v, "mimeType": "image/jpeg"})
                j["textures"].append({"source": len(j["images"]) - 1}); idx.append(len(j["textures"]) - 1)
            cache[tid] = idx
        return cache[tid]

    def material(cls, color):
        k = (cls, color)
        if k not in mats:
            tid, tile, rough = STYLE[cls]; c, n = tex(tid); s = 3.5 / tile
            tr = {"KHR_texture_transform": {"scale": [s, s]}}
            keep = KEEP[cls]; f = [1 + (t - 1) * keep for t in TINT[color]]
            j["materials"].append({"name": f"BzFacade_{cls}_{color}", "pbrMetallicRoughness": {"baseColorFactor": [*f, 1], "metallicFactor": 0.0,
                                   "roughnessFactor": rough, "baseColorTexture": {"index": c, "texCoord": 1, "extensions": dict(tr)}},
                                   "normalTexture": {"index": n, "texCoord": 1, "scale": 1.0, "extensions": dict(tr)}})
            mats[k] = len(j["materials"]) - 1
        return mats[k]

    for node in j["nodes"]:
        nm = node.get("name", "")
        if not nm.startswith("B_Facade_") or "mesh" not in node: continue
        color = nm.split("_")[-1]
        prims = j["meshes"][node["mesh"]]["primitives"]
        for prim in list(prims):
            P = g.acc_raw(prim["attributes"]["POSITION"]); I = g.indices_of(prim).reshape(-1, 3)
            cen = P[I].mean(1); cls = classify(cen, heroes)
            groups = {}
            for i, c in enumerate(cls):
                if c == "tea": continue  # Tea House keeps its own bridges
                groups.setdefault(c if c in STYLE else "shop", []).append(i)
            for c, ts in groups.items(): rep["tris"][c] = rep["tris"].get(c, 0) + len(ts)
            if dry: continue
            for c, ts in groups.items():
                ix = I[np.array(ts)].astype("<u4").ravel()
                acc = add_accessor(g, add_view(g, ix.tobytes(), 34963), 5125, len(ix), "SCALAR")
                prims.append({"attributes": dict(prim["attributes"]), "indices": acc, "material": material(c, color)})
            taken = {i for ts in groups.values() for i in ts}
            keep = np.array([i for i in range(len(I)) if i not in taken], dtype=int)
            if len(keep):
                ix = I[keep].astype("<u4").ravel()
                prim["indices"] = add_accessor(g, add_view(g, ix.tobytes(), 34963), 5125, len(ix), "SCALAR")
            else:
                prims.remove(prim)
    rep["bones"] = bones_exterior(g, heroes, material, tex, dry)
    if dry:
        print(json.dumps(rep)); return
    j.setdefault("extras", {})["bazaar_facades_pass"] = "v1"
    rep["materials"] = len(mats); print(json.dumps(rep)); print("wrote", path, save_glb(path, g.gltf, g.bin), "bytes")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("glb", nargs="?", default="apps/console/public/assets/world-city3.glb")
    ap.add_argument("--dry-run", action="store_true"); a = ap.parse_args(); run(a.glb, a.dry_run)
