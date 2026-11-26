#!/usr/bin/env python3
"""Drop zero-area triangles from every live primitive of world-city3.glb.

Demolition passes (bridge_bazaar.degenerate_inside and friends) "kill" triangles by collapsing them in place,
so ~71k of the world's ~335k accessor triangles (2026-11-26) render nothing but still upload and rasterise.
This writes a fresh index accessor per affected primitive holding only triangles with area > AREA_MIN m^2:
- indexed primitive: new uint16/uint32 index accessor in a new (uncompressed) view; the old view becomes dead bytes
- non-indexed primitive: gains an index accessor listing its live vertex triples (attributes untouched)
- primitive with no live triangle: removed from its mesh; a mesh left empty is detached from its nodes
Existing views are never mutated (meshopt views can be shared), no Blender re-export (rule 3), collision GLB untouched.
Follow with bridge_compact.py --drop-dead to shed the dead bytes.
  python3 tools/city3/bridge_drop_degenerate.py IN.glb OUT.glb [--check]
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from bridge_landscape_kit import add_accessor, add_view
from bridge_wave1 import Glb, save_glb

AREA_MIN = 1e-9


def live_meshes(g):
    nodes = g["nodes"]; out = {}
    def walk(i):
        n = nodes[i]
        if "mesh" in n:
            out.setdefault(n["mesh"], []).append(i)
        for c in n.get("children", []):
            walk(c)
    for s in g["scenes"]:
        for r in s["nodes"]:
            walk(r)
    return out


def live_triangles(glb, prim):
    pos = glb.acc_raw(prim["attributes"]["POSITION"])
    if "indices" in prim:
        tri = glb.indices_of(prim).reshape(-1, 3)
    else:
        tri = np.arange(len(pos) - len(pos) % 3, dtype=np.int64).reshape(-1, 3)
    v = pos[tri]
    area = 0.5 * np.linalg.norm(np.cross(v[:, 1] - v[:, 0], v[:, 2] - v[:, 0]), axis=1)
    return tri, area > AREA_MIN, len(pos)


def count(glb):
    tris = dead = 0
    for mi in live_meshes(glb.gltf):
        for p in glb.gltf["meshes"][mi]["primitives"]:
            if p.get("mode", 4) != 4:
                continue
            tri, keep, _ = live_triangles(glb, p)
            tris += len(tri); dead += int((~keep).sum())
    return tris, dead


def main():
    src, dst = sys.argv[1], sys.argv[2]
    glb = Glb(src); g = glb.gltf
    stat = {"prims_reindexed": 0, "prims_dropped": 0, "meshes_detached": 0, "tris_removed": 0}
    for mi, users in live_meshes(g).items():
        mesh = g["meshes"][mi]; kept = []
        for p in mesh["primitives"]:
            if p.get("mode", 4) != 4:
                kept.append(p); continue
            tri, keep, nverts = live_triangles(glb, p)
            dead = int((~keep).sum())
            if not dead:
                kept.append(p); continue
            stat["tris_removed"] += dead
            if not keep.any():
                stat["prims_dropped"] += 1; continue
            idx = tri[keep].ravel()
            # keep the original index type (tests pin uint32 on Tea props); size decides only for unindexed prims
            old = g["accessors"][p["indices"]]["componentType"] if "indices" in p else None
            big = old == 5125 or nverts > 65535
            data = idx.astype("<u4" if big else "<u2").tobytes()
            view = add_view(glb, data, 34963)
            p["indices"] = add_accessor(glb, view, 5125 if big else 5123, len(idx), "SCALAR",
                                        [int(idx.min())], [int(idx.max())])
            stat["prims_reindexed"] += 1; kept.append(p)
        if kept:
            mesh["primitives"] = kept
        else:   # glTF needs >= 1 primitive per mesh: leave the mesh, take it off its nodes
            stat["meshes_detached"] += 1
            for ni in users:
                n = g["nodes"][ni]; n.pop("mesh", None)
                n.get("extensions", {}).pop("EXT_mesh_gpu_instancing", None)
                if n.get("extensions") == {}:
                    n.pop("extensions")
    g["buffers"][0]["byteLength"] = len(glb.bin)
    save_glb(dst, g, glb.bin)
    after = count(Glb(dst))
    stat["after_tris"], stat["after_degenerate"] = after
    print(json.dumps(stat))
    assert after[1] == 0, "degenerate triangles left after the pass"


if __name__ == "__main__":
    if "--check" in sys.argv:
        t, d = count(Glb(sys.argv[1])); print(json.dumps({"tris": t, "degenerate": d})); sys.exit(1 if d else 0)
    main()
