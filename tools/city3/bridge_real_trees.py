#!/usr/bin/env python3
"""Replace the world's flat card trees with fewer, real 3D trees from the tree kit (assets/trees, CC-BY, credits in ASSETS.md).

The 455 Tree_packtree_a/b/c clones (LIB_hero_* meshes: a few crossed quads, 285-630 tris) read as flat. Kit trees are 4.5k-15k tris
with real branch structure, so the count drops instead (user call 2026-11-26: "fewer, bigger"):
- plaza allees and rim (bridge_plaza_trees.py) keep every position: formal rows, elm on the allees, flowering species on the rim
- every other tree is kept only if no kept tree stands within SPACING m (greedy, plaza first, then by node name)
Species follow the setting: STREET rows, GARDEN plots, PARK open ground; one species per CELL m cell (a planted row or grove reads
as one species), MIX chance of a different one per tree. Per-instance yaw and 0.85-1.15 scale.
Each tree is a plain clone node (Tree_real_<slug>.NNN) sharing one mesh per species; instance_world.mjs folds them into GPU instances per tile.
Old tree nodes lose their mesh (bytes go with bridge_compact.py --drop-dead). In the collision GLB, the 0.5 m trunk box of every
removed tree is cut: triangles with all three vertices within TRUNK m of its xz (big triangles such as the col_heroes plinth stay).
Kept trees keep their trunk box (positions do not move). Idempotent (extras mark). Rebake the navmesh afterwards.
  python3 tools/city3/bridge_real_trees.py [world.glb] [collision.glb] [--kit DIR] [--dry-run]
"""
import argparse
import json
import math
import os
import random
import sys
import zlib

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from bridge_landscape_kit import add_accessor, add_view
from bridge_wave1 import Glb, save_glb

MARK = "real_trees_pass"
SPACING, CELL, MIX, TRUNK = 10.0, 30.0, 0.25, 0.3
ALLEE = 13.4   # bridge_plaza_trees.ALLEE
PLAZA_ALLEE = ["elm_tree_25"]   # narrow crown (5.4 m) for 8 m allee spacing; elm_29 there cost ~476k tris
PLAZA_RIM = ["japanese_cherry_tree_medium__14", "realistic_hd_blue_jacaranda__41", "sakura_tree_01_low_poly_mode_114", "realistic_hd_blue_jacaranda__40"]
STREET = ["birch_tree_4", "elm_tree_25", "realistic_hd_blue_jacaranda__46", "japanese_cherry_tree_low_pol_13", "poplar_tree_hight_texture_lo_106",
          "realistic_hd_blue_jacaranda__44"]
GARDEN = ["japanese_cherry_tree_low_pol_13", "sakura_121", "sakura_tree_01_low_poly_mode_114", "realistic_hd_blue_jacaranda__41", "birch_11", "willow_125"]
PARK = ["oak_tree_66", "elm_tree_29", "birch_tree_4", "spruce_tree_98", "fir_tree_99", "larch_tree_101", "willow_125", "realistic_hd_blue_jacaranda__46",
        "birch_11"]
SETTING = {"ring": STREET, "westblock": STREET, "citadel": STREET, "teablock": STREET, "tea": STREET,
           "garden": GARDEN, "orchard": GARDEN, "plot": GARDEN}   # everything else: PARK
SPECIES = sorted(set(PLAZA_ALLEE + PLAZA_RIM + STREET + GARDEN + PARK))


def node_mat(n):
    if "matrix" in n:
        return np.array(n["matrix"], float).reshape(4, 4).T
    m = np.eye(4)
    if "scale" in n: m = np.diag([*n["scale"], 1.0]) @ m
    if "rotation" in n:
        x, y, z, w = n["rotation"]
        r = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
        t = np.eye(4); t[:3, :3] = r; m = t @ m
    if "translation" in n:
        t = np.eye(4); t[:3, 3] = n["translation"]; m = t @ m
    return m


def world_mats(g):
    out = {}
    def walk(i, m):
        m = m @ node_mat(g["nodes"][i]); out[i] = m
        for c in g["nodes"][i].get("children", []): walk(c, m)
    for s in g["scenes"]:
        for r in s["nodes"]: walk(r, np.eye(4))
    return out


def old_trees(g, wm):
    """live Tree_packtree nodes (top of each tree) -> [(node, group, x, y, z)]"""
    out = []
    for i, m in wm.items():
        nm = g["nodes"][i].get("name") or ""
        if not nm.startswith("Tree_packtree"):
            continue
        grp = nm.split(".", 1)[1].rstrip("0123456789") if "." in nm else "orig"
        out.append((i, grp, *m[:3, 3].tolist()))
    return out


def select(trees):
    plaza = [t for t in trees if t[1] == "plaza"]
    rest = sorted((t for t in trees if t[1] != "plaza"), key=lambda t: t[0])
    kept = list(plaza)
    for t in rest:
        if all((t[2] - k[2]) ** 2 + (t[4] - k[4]) ** 2 >= SPACING ** 2 for k in kept):
            kept.append(t)
    return kept


def species_for(t, rnd):
    _, grp, x, _, z = t
    if grp == "plaza":
        if abs(abs(x) - ALLEE) < 0.6 or abs(abs(z) - ALLEE) < 0.6:
            return PLAZA_ALLEE[0]
        side = (0 if z > 0 else 1) if abs(z) > abs(x) else (2 if x > 0 else 3)
        return PLAZA_RIM[side]
    pal = SETTING.get(grp, PARK)
    cell = (math.floor(x / CELL), math.floor(z / CELL))
    pick = pal[zlib.crc32(f"{grp}{cell}".encode()) % len(pal)]
    return pal[rnd.randrange(len(pal))] if rnd.random() < MIX else pick


def append_kit(world, path):
    """kit GLB (trees_kit.py: one mesh, no meshopt) -> mesh index in world"""
    k = Glb(path); kj = k.gltf; g = world.gltf
    smp = len(g.setdefault("samplers", [])); g["samplers"].append(kj["samplers"][0])
    tex0 = len(g.setdefault("textures", []))
    for im in kj["images"]:
        bv = kj["bufferViews"][im["bufferView"]]; o = bv.get("byteOffset", 0)
        v = add_view(world, bytes(k.bin[o:o + bv["byteLength"]]), None); g["bufferViews"][v].pop("target", None)
        g.setdefault("images", []).append({"name": im["name"], "bufferView": v, "mimeType": im["mimeType"]})
        s = len(g["images"]) - 1
        g["textures"].append({"sampler": smp, "source": s, "extensions": {"KHR_texture_basisu": {"source": s}}})
    mat0 = len(g["materials"])
    for m in kj["materials"]:
        m = json.loads(json.dumps(m))
        bt = m["pbrMetallicRoughness"].get("baseColorTexture")
        if bt: bt["index"] += tex0
        g["materials"].append(m)
    prims = []
    for p in kj["meshes"][0]["primitives"]:
        attrs = {}
        for name, ai in p["attributes"].items():
            a = kj["accessors"][ai]; arr = k.acc_raw(ai)
            attrs[name] = add_accessor(world, add_view(world, np.ascontiguousarray(arr, "<f4").tobytes(), 34962), 5126, a["count"], a["type"],   # acc_raw returns float64: store float32
                                       a.get("min"), a.get("max"))
            assert np.allclose(world.acc_raw(attrs[name]), arr, atol=1e-5), (path, name)   # round-trip: bytes match the declared type
        idx = k.indices_of(p).astype("<u4")
        prims.append({"attributes": attrs, "material": p["material"] + mat0,
                      "indices": add_accessor(world, add_view(world, idx.tobytes(), 34963), 5125, len(idx), "SCALAR")})
    g["meshes"].append({"name": kj["meshes"][0]["name"], "primitives": prims})
    return len(g["meshes"]) - 1


def clone_nodes(world, name, mesh, placements):
    """plain clones sharing one mesh: instance_world.mjs (ALLOW has Tree_real) folds them into GPU instances per tile at tile build,
    so culling and streaming stay per tile; one world-spanning instanced node would never be culled"""
    g = world.gltf; roots = g["scenes"][g.get("scene", 0)]["nodes"]
    for i, (t, r, s) in enumerate(placements):
        g["nodes"].append({"name": f"{name}.{i:03d}", "mesh": mesh, "translation": t, "rotation": r, "scale": s})
        roots.append(len(g["nodes"]) - 1)


def detach(g, i):
    n = g["nodes"][i]; n.pop("mesh", None)
    n.get("extensions", {}).pop("EXT_mesh_gpu_instancing", None)
    if n.get("extensions") == {}: n.pop("extensions")
    for c in n.get("children", []): detach(g, c)


def cut_trunks(col, spots):
    """drop collision triangles lying wholly inside a TRUNK half-width square at any removed tree -> triangles cut"""
    g = col.gltf; wm = world_mats(g); spots = np.array(spots); cut = 0
    if not len(spots):
        return 0
    for ni, m in wm.items():
        n = g["nodes"][ni]
        if "mesh" not in n:
            continue
        for p in g["meshes"][n["mesh"]]["primitives"]:
            P = col.acc_raw(p["attributes"]["POSITION"]).astype(float) @ m[:3, :3].T + m[:3, 3]
            tri = col.indices_of(p).reshape(-1, 3) if "indices" in p else np.arange(len(P) - len(P) % 3).reshape(-1, 3)
            v = P[tri]                                   # (t, 3, 3)
            if not len(tri):
                continue
            lo, hi = v.min(1), v.max(1)
            drop = np.zeros(len(tri), bool)
            for sx, sz in spots:   # whole triangle inside the square: a big triangle (plinth, floor) never qualifies
                drop |= (lo[:, 0] >= sx - TRUNK) & (hi[:, 0] <= sx + TRUNK) & (lo[:, 2] >= sz - TRUNK) & (hi[:, 2] <= sz + TRUNK)
            if not drop.any():
                continue
            keep = tri[~drop].ravel()
            big = ("indices" in p and g["accessors"][p["indices"]]["componentType"] == 5125) or len(P) > 65535
            p["indices"] = add_accessor(col, add_view(col, keep.astype("<u4" if big else "<u2").tobytes(), 34963), 5125 if big else 5123, len(keep), "SCALAR",
                                        [int(keep.min())] if len(keep) else [0], [int(keep.max())] if len(keep) else [0])
            cut += int(drop.sum())
    g["buffers"][0]["byteLength"] = len(col.bin)
    return cut


def plan(world_path):
    g = Glb(world_path).gltf; wm = world_mats(g)
    trees = old_trees(g, wm); kept = select(trees); rnd = random.Random(26112026)
    by = {}
    for t in kept:
        a = rnd.uniform(0, 2 * math.pi); s = rnd.uniform(0.85, 1.15)
        by.setdefault(species_for(t, rnd), []).append(([t[2], t[3], t[4]], [0, math.sin(a / 2), 0, math.cos(a / 2)], [s, s, s]))
    removed = [t for t in trees if t not in kept]
    return trees, kept, removed, by


def run(world_path, col_path, kit, dry):
    trees, kept, removed, by = plan(world_path)
    man = json.load(open(os.path.join(kit, "manifest.json")))
    tris = sum(man[s]["tris"] * len(v) for s, v in by.items())
    print(json.dumps({"old": len(trees), "kept": len(kept), "removed": len(removed), "species": {s: len(v) for s, v in sorted(by.items())},
                      "instance_tris": tris}))
    if dry:
        return
    w, c = Glb(world_path), Glb(col_path); g = w.gltf
    if g.get("extras", {}).get(MARK):
        print({"already": True}); return
    for t in trees:
        detach(g, t[0])
    for s, pl in sorted(by.items()):
        clone_nodes(w, "Tree_real_" + s, append_kit(w, os.path.join(kit, s + ".glb")), pl)
    cut = cut_trunks(c, [(t[2], t[4]) for t in removed])
    for e in ("KHR_texture_basisu",):
        if e not in g.setdefault("extensionsUsed", []): g["extensionsUsed"].append(e)
    g.setdefault("extras", {})[MARK] = {"kept": len(kept), "removed": len(removed)}
    g["buffers"][0]["byteLength"] = len(w.bin)
    print(json.dumps({"collision_tris_cut": cut}))
    save_glb(world_path, g, w.bin); save_glb(col_path, c.gltf, c.bin)


def check(world_path):
    """gate: no flat card tree still renders, and real trees exist -> exit code"""
    g = Glb(world_path).gltf; wm = world_mats(g)
    flat = [g["nodes"][i]["name"] for i in wm if (g["nodes"][i].get("name") or "").startswith("Tree_packtree") and "mesh" in g["nodes"][i]]
    real = sum(1 for i in wm if (g["nodes"][i].get("name") or "").startswith("Tree_real_") and "mesh" in g["nodes"][i])
    print(json.dumps({"flat_trees": len(flat), "real_trees": real, "sample": flat[:3]}))
    return 0 if not flat and real else 1


def selftest():
    t = [(0, "plaza", 13.4, 0.2, 20.0, ), (1, "plaza", 30.0, 0.2, 57.5), (2, "ring", 0, 0.2, 5.0), (3, "ring", 0, 0.2, 40.0), (4, "open", 0, 0.2, 44.0)]
    k = select(t)
    assert [x[0] for x in k] == [0, 1, 2, 3], k       # plaza always kept; open (0,44) is 4 m from ring (0,40): dropped
    rnd = random.Random(1)
    assert species_for(t[0], rnd) == "elm_tree_25" and species_for(t[1], rnd) == PLAZA_RIM[0]
    assert all(s in SPECIES for s in PLAZA_RIM + STREET + GARDEN + PARK)
    print("selftest ok")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("world", nargs="?", default="apps/console/public/assets/world-city3.glb")
    ap.add_argument("collision", nargs="?", default="apps/console/public/assets/world-city3-collision.glb")
    ap.add_argument("--kit", default=os.path.join(HERE, "assets", "trees"))
    ap.add_argument("--dry-run", action="store_true"); ap.add_argument("--selftest", action="store_true"); ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    if a.check: sys.exit(check(a.world))
    selftest() if a.selftest else run(a.world, a.collision, a.kit, a.dry_run)
