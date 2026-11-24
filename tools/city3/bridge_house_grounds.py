#!/usr/bin/env python3
"""House grounds: not every yard is lawn. Each placed house gets a flagstone patio on its back side and planting beds along its front
(wood-chip mulch, Poly Haven CC0 shrubs and gazania flower patches), split by the house's walk.

Front side: yard blocks (bridge_garden_block.GARDENS yard=True) face the nearest block edge (the yard walk rule); ring houses face the
street side of their block (bridge_ring_frontage.py). Patios are skipped where they would leave the block, touch another house or walk,
or cover a tree. Plants are EXT_mesh_gpu_instancing nodes named ls_bush_* / ls_flower_* (split_lod.mjs drops those from the far view).
No collision (walkers pass through plants; pads are 4-8 cm), so the navmesh is unchanged. Idempotent (extras mark).
Afterwards: bridge_texture_swap.py BzGround_bed wood_chips --res 1k; BzGround_patio stone_tiles_02 --res 1k.
  python3 tools/city3/bridge_house_grounds.py [world.glb] [--dry-run]
  python3 tools/city3/bridge_house_grounds.py --selftest
"""
import argparse
import io
import json
import math
import os
import random
import sys
import urllib.request

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
import bridge_garden_block as gb
from bridge_bazaar_open_space import G, MATS, Builder, emit
from bridge_ring_frontage import plan_blocks
from bridge_wave1 import Glb, save_glb

MARK = "house_grounds_pass"
BED_D, WALK_GAP, PATIO_D, PATIO_W = 1.2, 2.4, 3.6, 8.0
SKIP = ("clock-tower", "zen-pavilion", "villa-pool", "villa-c", "cabin")   # own decks, slabs or not a house
MATS.setdefault("bed", ((0.33, 0.24, 0.16), 0.95, 0, None))
MATS.setdefault("patio", ((0.62, 0.6, 0.56), 0.9, 0, None))
MODELS = os.path.expanduser("~/Developer/city3-downloads/polyhaven-models")
UA = {"User-Agent": "aiverse-city3-builder/1.0"}
# (source, mesh index, scale). Poly Haven's shrubs are wild, sparse species (shrub_02 rendered as a bare sprig, shrub_04 is 22 cm ground
# cover), so the bushes are clipped boxwood balls in the hedges' leafy texture (diameter = scale); the flowers are Poly Haven gazania patches.
PLANTS = {"ls_bush_a": ("ball", 0, 0.85), "ls_bush_b": ("ball", 0, 0.6), "ls_flower_a": ("flower_gazania", 0, 0.4), "ls_flower_b": ("flower_gazania", 1, 0.35)}


def houses():
    """[(id, rect, front, block)]: front in -x/+x/-z/+z, block = the rect the house's lot lives in"""
    fp, out = gb.house_footprints(), []
    defs = {d["id"]: d for d in json.load(open(os.path.join(HERE, "..", "..", "apps", "console", "public", "assets", "districts.json")))["districts"]}
    blocks = plan_blocks()
    for hid, ((cx, cz), r) in sorted(fp.items()):
        if any(s in defs[hid]["url"] for s in SKIP):
            continue
        if hid.startswith("house-ring-"):
            ij = hid.split("-")[2]; i, j = int(ij[0]), int(ij[1])
            side = "W" if i == 0 else "E" if i == 5 else "N" if j == 0 else "S"
            out.append((hid, r, {"W": "+x", "E": "-x", "N": "-z", "S": "+z"}[side], blocks[(i, j)]))
            continue
        for name, g in gb.GARDENS.items():
            X0, Z0, X1, Z1 = g["rect"]
            if g.get("yard") and X0 <= cx <= X1 and Z0 <= cz <= Z1:
                d = {"-x": r[0] - X0, "+x": X1 - r[2], "-z": r[1] - Z0, "+z": Z1 - r[3]}
                out.append((hid, r, min(d, key=d.get), (X0, Z0, X1, Z1)))
                break
    return out


def walk_rect(r, front, block):
    cx, cz = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    return {"-x": (block[0], cz - .8, r[0], cz + .8), "+x": (r[2], cz - .8, block[2], cz + .8),
            "-z": (cx - .8, block[1], cx + .8, r[1]), "+z": (cx - .8, r[3], cx + .8, block[3])}[front]


def overlaps(a, b, pad=0.0):
    return a[0] - pad < b[2] and b[0] - pad < a[2] and a[1] - pad < b[3] and b[1] - pad < a[3]


def layout(trees, seed=9091):
    rnd = random.Random(seed); hs = houses(); walks = [walk_rect(r, f, b) for _, r, f, b in hs]
    beds, patios, plants = [], [], {k: [] for k in PLANTS}
    for k, (hid, r, front, block) in enumerate(hs):
        cx, cz = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
        along_x = front in ("-z", "+z")
        lo, hi = (r[0] + .3, r[2] - .3) if along_x else (r[1] + .3, r[3] - .3)
        c = cx if along_x else cz
        face = {"-x": r[0], "+x": r[2], "-z": r[1], "+z": r[3]}[front]; out = 1 if front[0] == "+" else -1
        d0, d1 = sorted((face, face + out * BED_D))
        for s, e in ((lo, c - WALK_GAP / 2), (c + WALK_GAP / 2, hi)):       # two beds, the walk between them
            if e - s < 1.0:
                continue
            rect = (s, d0, e, d1) if along_x else (d0, s, d1, e)
            if any(overlaps(rect, w) for i, w in enumerate(walks) if i != k) or any(overlaps(rect, t, .3) for t in trees):
                continue
            beds.append(rect)
            a, n = s + .55, 0
            while a <= e - .45:
                kind = ("ls_bush_a", "ls_bush_b")[n % 4 // 2] if n % 2 == 0 else ("ls_flower_a", "ls_flower_b")[n % 4 // 2]
                p = (a, (d0 + d1) / 2) if along_x else ((d0 + d1) / 2, a)
                for _ in range(1 if "bush" in kind else 3):   # flowers in drifts of three
                    jit = 0.1 if "bush" in kind else 0.3
                    plants[kind].append((p[0] + rnd.uniform(-jit, jit), p[1] + rnd.uniform(-jit, jit), rnd.uniform(0, 2 * math.pi), rnd.uniform(.9, 1.1)))
                a += 1.0 if n % 2 == 0 else 0.9; n += 1
        back = {"-x": r[2], "+x": r[0], "-z": r[3], "+z": r[1]}[front]; bo = -out
        w = min(PATIO_W, (hi - lo) * .8)
        p0, p1 = sorted((back + bo * .2, back + bo * (.2 + PATIO_D)))
        rect = (c - w / 2, p0, c + w / 2, p1) if along_x else (p0, c - w / 2, p1, c + w / 2)
        inside = block[0] + 1.0 <= rect[0] and rect[2] <= block[2] - 1.0 and block[1] + 1.0 <= rect[1] and rect[3] <= block[3] - 1.0
        clash = any(overlaps(rect, o[1], .5) for o in hs if o[0] != hid) or any(overlaps(rect, w_) for w_ in walks) or any(overlaps(rect, t, .6) for t in trees)
        if inside and not clash:
            patios.append(rect)
    return beds, patios, plants


def tree_rects(j):
    sc = set(j["scenes"][j.get("scene", 0)]["nodes"])
    return [(t[0] - .3, t[2] - .3, t[0] + .3, t[2] + .3) for i in sc for n in [j["nodes"][i]] if n.get("name", "").startswith("Tree_packtree") for t in [n.get("translation", [0, 0, 0])]]


def fetch(url, path):
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, "wb").write(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120).read())
    return path


def plant_texture(pid):
    """RGBA PNG (512 px): Poly Haven's glTF ships the diffuse as JPEG and the alpha as its own map"""
    from PIL import Image
    files = json.load(urllib.request.urlopen(urllib.request.Request(f"https://api.polyhaven.com/files/{pid}", headers=UA), timeout=60))
    d = os.path.join(MODELS, pid, "textures")
    rgb = Image.open(fetch(files["Diffuse"]["1k"]["jpg"]["url"], os.path.join(d, f"{pid}_diff_1k.jpg"))).convert("RGB")
    a = Image.open(fetch(files["Alpha"]["1k"]["png"]["url"], os.path.join(d, f"{pid}_alpha_1k.png"))).convert("L")
    im = Image.merge("RGBA", (*rgb.split(), a.resize(rgb.size))).resize((512, 512), Image.LANCZOS)
    b = io.BytesIO(); im.save(b, "PNG", optimize=True); return b.getvalue()


def load_plant(pid, mi):
    """one variant mesh: footprint centred on (0, 0), base at y 0"""
    from bridge_citadel_townhouses import _acc
    j = json.load(open(os.path.join(MODELS, pid, f"{pid}.gltf"))); bin_ = open(os.path.join(MODELS, pid, j["buffers"][0]["uri"]), "rb").read()
    p = j["meshes"][mi]["primitives"][0]
    P = _acc(j, bin_, p["attributes"]["POSITION"]).astype("<f4").copy(); N = _acc(j, bin_, p["attributes"]["NORMAL"]).astype("<f4")
    U = _acc(j, bin_, p["attributes"]["TEXCOORD_0"]).astype("<f4"); I = _acc(j, bin_, p["indices"]).reshape(-1).astype("<u4")
    lo, hi = P.min(0), P.max(0); P -= np.array([(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2], "<f4")
    return P, N, U, I


def ball(sub=2):
    """unit-diameter icosphere, slightly squashed, base at y 0: P, N, U (spherical, 2 repeats), I"""
    t = (1 + 5 ** .5) / 2
    V = [(-1, t, 0), (1, t, 0), (-1, -t, 0), (1, -t, 0), (0, -1, t), (0, 1, t), (0, -1, -t), (0, 1, -t), (t, 0, -1), (t, 0, 1), (-t, 0, -1), (-t, 0, 1)]
    V = [np.array(v, float) / np.linalg.norm(v) for v in V]
    F = [(0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11), (1, 5, 9), (5, 11, 4), (11, 10, 2), (10, 7, 6), (7, 1, 8),
         (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9), (4, 9, 5), (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1)]
    for _ in range(sub):
        mid = {}
        def m(a, b):
            k = (min(a, b), max(a, b))
            if k not in mid:
                v = V[a] + V[b]; V.append(v / np.linalg.norm(v)); mid[k] = len(V) - 1
            return mid[k]
        F = [f for a, b, c in F for f in ((a, m(a, b), m(a, c)), (b, m(b, c), m(a, b)), (c, m(a, c), m(b, c)), (m(a, b), m(b, c), m(a, c)))]
    N = np.array(V, "<f4"); P = (N * np.array([.5, .42, .5]) + np.array([0, .4, 0])).astype("<f4")   # sunk 2 cm into the bed
    U = np.stack([np.arctan2(N[:, 0], N[:, 2]) / math.pi + 1, np.arcsin(np.clip(N[:, 1], -1, 1)) / math.pi * 2 + 1], 1).astype("<f4")
    return P, N, U, np.array(F, "<u4").reshape(-1)


def add_plants(w, plants):
    from bridge_landscape_kit import add_accessor, add_view
    j = w.gltf; scene = j["scenes"][j.get("scene", 0)]["nodes"]; tex = {}

    def acc(a, typ, target=34962, mm=False):
        a = np.ascontiguousarray(a); ct = {"<f4": 5126, "<u4": 5125}[a.dtype.str]
        v = add_view(w, a.tobytes(), target)
        if target is None:
            j["bufferViews"][v].pop("target", None)
        return add_accessor(w, v, ct, len(a), typ, a.min(0).tolist() if mm else None, a.max(0).tolist() if mm else None)
    for name, (pid, mi, s) in PLANTS.items():
        if not plants[name]:
            continue
        if pid == "ball" and pid not in tex:   # boxwood: the lawn's Leafy Grass maps, dark (as the hedges)
            t = {im.get("name"): ti for ti, tx in enumerate(j.get("textures", [])) for im in [j["images"][tx["source"]]] if "source" in tx}
            j["materials"].append({"name": "Plant_boxwood", "pbrMetallicRoughness": {"baseColorTexture": {"index": t["leafy_grass_diff"]}, "baseColorFactor": [0.26, 0.5, 0.2, 1],
                                   "metallicFactor": 0.0, "roughnessFactor": 0.95}, "normalTexture": {"index": t["leafy_grass_nor"], "scale": 1.5}})
            tex[pid] = len(j["materials"]) - 1
        if pid not in tex:
            v = add_view(w, plant_texture(pid), None); j["bufferViews"][v].pop("target", None)
            j.setdefault("images", []).append({"name": f"{pid}_rgba", "bufferView": v, "mimeType": "image/png"})
            j.setdefault("textures", []).append({"source": len(j["images"]) - 1})
            j["materials"].append({"name": f"Plant_{pid}", "doubleSided": True, "alphaMode": "MASK", "alphaCutoff": 0.5,
                                   "pbrMetallicRoughness": {"baseColorTexture": {"index": len(j["textures"]) - 1}, "metallicFactor": 0.0, "roughnessFactor": 0.85}})
            tex[pid] = len(j["materials"]) - 1
        P, N, U, I = ball() if pid == "ball" else load_plant(pid, mi)
        prim = {"attributes": {"POSITION": acc(P, "VEC3", mm=True), "NORMAL": acc(N, "VEC3"), "TEXCOORD_0": acc(U, "VEC2")},
                "indices": acc(I, "SCALAR", 34963), "material": tex[pid]}
        j["meshes"].append({"name": name, "primitives": [prim]})
        pts = plants[name]
        T = np.array([[x, G + .03, z] for x, z, _, _ in pts], "<f4")
        R = np.array([[0, math.sin(a / 2), 0, math.cos(a / 2)] for _, _, a, _ in pts], "<f4")
        S = np.array([[s * k] * 3 for _, _, _, k in pts], "<f4")
        j["nodes"].append({"name": name, "mesh": len(j["meshes"]) - 1, "extensions": {"EXT_mesh_gpu_instancing": {"attributes": {
            "TRANSLATION": acc(T, "VEC3", None), "ROTATION": acc(R, "VEC4", None), "SCALE": acc(S, "VEC3", None)}}}})
        scene.append(len(j["nodes"]) - 1)
    if "EXT_mesh_gpu_instancing" not in j.setdefault("extensionsUsed", []):
        j["extensionsUsed"].append("EXT_mesh_gpu_instancing")


def run(world, dry):
    w = Glb(world); j = w.gltf
    beds, patios, plants = layout(tree_rects(j))
    print(json.dumps({"beds": len(beds), "patios": len(patios), **{k: len(v) for k, v in plants.items()}}))
    if dry:
        return
    if j.get("extras", {}).get(MARK):
        print({"already": True}); return
    b = Builder()
    for r in beds:
        b.box("bed", r[0], r[2], r[1], r[3], G + .03, G + .08, uv=1.5)
    for r in patios:
        b.box("patio", r[0], r[2], r[1], r[3], G + .03, G + .075, uv=1.5)
    cache = {}
    def mats(k):
        if k not in cache:
            col, rgh, mt, _ = MATS[k]
            j["materials"].append({"name": "BzGround_" + k, "pbrMetallicRoughness": {"baseColorFactor": [*col[:3], 1], "metallicFactor": mt, "roughnessFactor": rgh}})
            cache[k] = len(j["materials"]) - 1
        return cache[k]
    emit(w, j, b, "BzHouseGrounds", mats)
    add_plants(w, plants)
    j.setdefault("extras", {})[MARK] = True
    print("wrote", world, save_glb(world, j, w.bin), "bytes")


def selftest():
    hs = houses(); assert len(hs) > 20, len(hs)
    beds, patios, plants = layout([])
    walks = [walk_rect(r, f, b) for _, r, f, b in hs]
    assert beds and patios and all(plants.values())
    assert not any(overlaps(p, w) for p in patios for w in walks), "patio on a walk"
    assert not any(overlaps(p, r, .1) for p in patios for _, r, _, _ in hs), "patio under a house"
    print("selftest ok", len(beds), "beds", len(patios), "patios")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("world", nargs="?", default="apps/console/public/assets/world-city3.glb")
    ap.add_argument("--dry-run", action="store_true"); ap.add_argument("--selftest", action="store_true"); a = ap.parse_args()
    selftest() if a.selftest else run(a.world, a.dry_run)
