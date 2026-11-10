#!/usr/bin/env python3
"""Dress cleared edge blocks with landscaping inside the shipped city GLB.

Run AFTER bridge_edge_landscape.py removed the houses of the same blocks.
Adds, per block: a grass ground quad (the city's own `grass` material), a
stone path, bushes, flowers, rocks (Kenney Nature Kit, CC0, converted from
unlit flat colours to lit PBR) and trees that reuse the city's existing
Tree_packtree_a/b/c meshes. Everything is instance nodes over shared meshes:
the Kenney meshes are appended once, uncompressed, to BIN buffer 0.

GLB frame: x_t = x, z_t = -y_plan, y up. Walk slab is y=0.2.

Usage (from repo root):
  python3 tools/city3/bridge_landscape_kit.py --blocks 0,3 [--dry-run]
Collision: none added (walkers pass through plants). Rebuild world-shell.glb
and the navmesh afterwards.
"""
import argparse
import json
import math
import os
import random
import shutil
import struct
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bridge_wave1 import Glb, save_glb
from bridge_edge_landscape import edge_rects

MARK = "edge_landscape_kit"
HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.join(HERE, "assets", "landscape")
GROUND_Y = 0.23          # just above the 0.2 walk slab, hides the old slab
# Kenney palette -> natural linear base colours (matches the Blender pilot).
RECOLOUR = {"leafsGreen": (0.10, 0.28, 0.06), "grass": (0.14, 0.30, 0.07),
            "woodBark": (0.17, 0.10, 0.05), "dirt": (0.30, 0.20, 0.11),
            "stoneDark": (0.30, 0.30, 0.29), "stone": (0.45, 0.45, 0.43),
            "_defaultMat": (0.45, 0.45, 0.43)}
CT = {5126: 4, 5123: 2, 5125: 4}
NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def append_bytes(glb, data):
    while len(glb.bin) % 4:
        glb.bin += b"\x00"
    off = len(glb.bin)
    glb.bin += data
    glb.gltf["buffers"][0]["byteLength"] = len(glb.bin)
    return off


def add_view(glb, data, target):
    off = append_bytes(glb, data)
    views = glb.gltf["bufferViews"]
    views.append({"buffer": 0, "byteOffset": off, "byteLength": len(data),
                  "target": target})
    return len(views) - 1


def add_accessor(glb, view, ctype, count, typ, mn=None, mx=None):
    a = {"bufferView": view, "componentType": ctype, "count": count,
         "type": typ}
    if mn is not None:
        a["min"], a["max"] = mn, mx
    glb.gltf["accessors"].append(a)
    return len(glb.gltf["accessors"]) - 1


def add_material(glb, cache, name, factor, double_sided):
    key = (name, tuple(round(v, 4) for v in factor))
    if key not in cache:
        glb.gltf["materials"].append({
            "name": "ls_" + name,
            "pbrMetallicRoughness": {"baseColorFactor": [*factor, 1.0],
                                     "metallicFactor": 0.0,
                                     "roughnessFactor": 0.92},
            "doubleSided": double_sided})
        cache[key] = len(glb.gltf["materials"]) - 1
    return cache[key]


def import_kenney(glb, name, mat_cache):
    """Append a Kenney template GLB's first mesh; return the new mesh index."""
    d = open(os.path.join(KIT, name + ".glb"), "rb").read()
    jl = struct.unpack("<I", d[12:16])[0]
    j = json.loads(d[20:20 + jl])
    off = 20 + jl
    bl = struct.unpack("<I", d[off:off + 4])[0]
    blob = d[off + 8:off + 8 + bl]
    prims = []
    acc_map = {}

    def accessor(ai):
        if ai in acc_map:
            return acc_map[ai]
        a = j["accessors"][ai]
        bv = j["bufferViews"][a["bufferView"]]
        o = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        size = a["count"] * CT[a["componentType"]] * NC[a["type"]]
        assert "byteStride" not in bv, name + ": strided view unsupported"
        v = add_view(glb, blob[o:o + size], bv.get("target", 34962))
        acc_map[ai] = add_accessor(glb, v, a["componentType"], a["count"],
                                   a["type"], a.get("min"), a.get("max"))
        return acc_map[ai]

    for p in j["meshes"][0]["primitives"]:
        src = j["materials"][p["material"]]
        mname = src.get("name", "mat")
        fac = RECOLOUR.get(mname) or tuple(
            src["pbrMetallicRoughness"]["baseColorFactor"][:3])
        foliage = mname in ("leafsGreen", "grass") or mname.startswith("color")
        prims.append({
            "attributes": {"POSITION": accessor(p["attributes"]["POSITION"]),
                           "NORMAL": accessor(p["attributes"]["NORMAL"])},
            "indices": accessor(p["indices"]),
            "material": add_material(glb, mat_cache, mname, fac, foliage)})
    glb.gltf["meshes"].append({"name": "ls_" + name, "primitives": prims})
    return len(glb.gltf["meshes"]) - 1


def ground_mesh(glb, grass_mat, x0, z0, x1, z1):
    tile = 8.0
    pos = np.array([[x0, GROUND_Y, z0], [x1, GROUND_Y, z0],
                    [x1, GROUND_Y, z1], [x0, GROUND_Y, z1]], dtype="<f4")
    nrm = np.tile(np.array([0, 1, 0], dtype="<f4"), (4, 1))
    uv = np.array([[x0 / tile, z0 / tile], [x1 / tile, z0 / tile],
                   [x1 / tile, z1 / tile], [x0 / tile, z1 / tile]],
                  dtype="<f4")
    idx = np.array([0, 2, 1, 0, 3, 2], dtype="<u2")   # +Y facing
    pa = add_accessor(glb, add_view(glb, pos.tobytes(), 34962), 5126, 4,
                      "VEC3", pos.min(0).tolist(), pos.max(0).tolist())
    na = add_accessor(glb, add_view(glb, nrm.tobytes(), 34962), 5126, 4,
                      "VEC3")
    ta = add_accessor(glb, add_view(glb, uv.tobytes(), 34962), 5126, 4,
                      "VEC2")
    ia = add_accessor(glb, add_view(glb, idx.tobytes(), 34963), 5123, 6,
                      "SCALAR")
    glb.gltf["meshes"].append({"name": "ls_ground", "primitives": [{
        "attributes": {"POSITION": pa, "NORMAL": na, "TEXCOORD_0": ta},
        "indices": ia, "material": grass_mat}]})
    return len(glb.gltf["meshes"]) - 1


def yaw(a):
    return [0.0, math.sin(a / 2), 0.0, math.cos(a / 2)]


def build_block(glb, rects, mesh, rng):
    g = glb.gltf
    x0 = min(r[0] for r in rects); x1 = max(r[2] for r in rects)
    y0 = min(r[1] for r in rects); y1 = max(r[3] for r in rects)
    gx0, gx1, gz0, gz1 = x0, x1, -y1, -y0           # plan y -> GLB z
    children = []

    def node(name, m, x, z, s, a=0.0, y=GROUND_Y):
        g["nodes"].append({"name": name, "mesh": m,
                           "translation": [x, y, z],
                           "rotation": yaw(a), "scale": [s, s, s]})
        children.append(len(g["nodes"]) - 1)

    g["nodes"].append({"name": "ls_ground", "mesh": mesh["ground"]})
    children.append(len(g["nodes"]) - 1)
    taken = []

    def free(x, z, r):
        return all(math.hypot(x - a, z - b) > r + q for a, b, q in taken)

    # path: from the street-facing (plaza-side) edge toward the middle row
    zc = (gz0 + gz1) / 2
    toward = 1 if abs(gx1) < abs(gx0) else -1       # side nearest plaza
    start = gx1 - 1.5 if toward == 1 else gx0 + 1.5
    for i in range(int((gx1 - gx0) * 0.65 / 3.0)):
        x = start - toward * i * 3.0
        node("ls_path", mesh["path_stone"], x, zc, 3.0)
        taken.append((x, zc, 2.0))
    for _ in range(60):
        x = rng.uniform(gx0 + 3, gx1 - 3); z = rng.uniform(gz0 + 3, gz1 - 3)
        if free(x, z, 3.5):
            k = rng.choice(["a", "b", "b", "c"])
            s = rng.uniform(0.28, 0.42) if k != "c" else rng.uniform(.4, .55)
            node("ls_tree", mesh["tree_" + k], x, z, s,
                 rng.uniform(0, 6.28))
            taken.append((x, z, 3.5))
    for nm, count, lo, hi, r in (("bush", 120, 3.0, 4.5, 0.8),
                                 ("rock", 40, 2.5, 4.0, 0.6),
                                 ("flower", 120, 3.0, 5.0, 0.3)):
        for _ in range(count):
            x = rng.uniform(gx0 + 2, gx1 - 2); z = rng.uniform(gz0 + 2, gz1 - 2)
            if not free(x, z, r):
                continue
            key = {"bush": rng.choice(["plant_bush", "plant_bushDetailed"]),
                   "rock": "rock_smallA",
                   "flower": rng.choice(["flower_redA", "flower_yellowA",
                                         "flower_purpleA"])}[nm]
            node("ls_" + nm, mesh[key], x, z, rng.uniform(lo, hi),
                 rng.uniform(0, 6.28))
            taken.append((x, z, r))
    g["nodes"].append({"name": "Landscape_edge_%d" % (len(g["scenes"][0]
                       ["nodes"])), "children": children})
    g["scenes"][0]["nodes"].append(len(g["nodes"]) - 1)
    return len(children)


def apply(glb, blocks, dry_run):
    g = glb.gltf
    if g.get("extras", {}).get(MARK):
        return {"already_patched": g["extras"][MARK]}
    by_name = {n.get("name"): n for n in g["nodes"] if "mesh" in n}
    mesh = {f"tree_{k}": by_name[f"Tree_packtree_{k}"]["mesh"]
            for k in "abc"}
    grass = next(i for i, m in enumerate(g["materials"])
                 if m.get("name") == "grass")
    report = {"blocks": {}, "bytes_added": 0}
    start_bin = len(glb.bin)
    cache = {}
    for n in ("path_stone", "plant_bush", "plant_bushDetailed", "rock_smallA",
              "flower_redA", "flower_yellowA", "flower_purpleA"):
        mesh[n] = import_kenney(glb, n, cache)
    for blk in sorted(blocks):
        rects = edge_rects({blk})
        assert rects, f"no footprints for block {blk}"
        x0 = min(r[0] for r in rects); x1 = max(r[2] for r in rects)
        y0 = min(r[1] for r in rects); y1 = max(r[3] for r in rects)
        mesh["ground"] = ground_mesh(glb, grass, x0, -y1, x1, -y0)
        rng = random.Random(2503 + blk[0] * 10 + blk[1])
        report["blocks"][str(blk)] = build_block(glb, rects, mesh, rng)
    report["bytes_added"] = len(glb.bin) - start_bin
    g.setdefault("extras", {})[MARK] = {"blocks": sorted(map(list, blocks))}
    return report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("glb", nargs="?",
                    default="apps/console/public/assets/world-city3.glb")
    ap.add_argument("--blocks", required=True)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    blocks = {tuple(int(v) for v in s.split(",")) for s in a.blocks.split(";")}
    glb = Glb(a.glb)
    if MARK not in glb.gltf.get("extras", {}) and \
            "edge_landscape_pass" not in glb.gltf.get("extras", {}):
        sys.exit("run bridge_edge_landscape.py on this GLB first")
    report = apply(glb, blocks, a.dry_run)
    print(json.dumps(report, indent=1))
    if a.dry_run or "already_patched" in report:
        return
    target = os.path.abspath(a.glb)
    fd, tmp = tempfile.mkstemp(suffix=".glb", dir=os.path.dirname(target))
    os.close(fd)
    try:
        save_glb(tmp, glb.gltf, glb.bin)
        check = Glb(tmp)
        for node in check.gltf["nodes"]:
            if node.get("name", "").startswith("ls_") and "mesh" in node:
                for p in check.gltf["meshes"][node["mesh"]]["primitives"]:
                    if p.get("name") != "x" and "indices" in p:
                        check.acc_raw(p["indices"])
        for bv in check.gltf["bufferViews"]:
            e = bv.get("extensions", {}).get("EXT_meshopt_compression")
            assert e is None or "buffer" in e
        shutil.copy2(target, "/tmp/%s.pre-landscape-kit" %
                     os.path.basename(target))
        os.replace(tmp, target)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


if __name__ == "__main__":
    main()
