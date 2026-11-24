#!/usr/bin/env python3
"""Re-map the top faces of the yard/garden boxes already baked into world-city3.glb to planar (x, z) UVs.

Builder.box (bridge_bazaar_open_space.py, fixed alongside) gave a box 0.05 m or taller the side-wall mapping on its top face too: u = (x+z)/s,
v = y/s, so v was constant across a lawn and its grass texture streaked along x+z. Every vertex of a Bz*_grass / _gravel / _stone primitive whose
normal points up gets (x/s, z/s) with the scale the garden passes used. Idempotent (planar already = unchanged).
  python3 tools/city3/bridge_fix_top_uvs.py [world.glb]
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
from bridge_landscape_kit import add_view
from bridge_wave1 import Glb, save_glb

SCALE = {"_grass": 4.0, "_gravel": 1.5, "_stone": 1.5}

if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "apps/console/public/assets/world-city3.glb"
    g = Glb(path); j = g.gltf; done = {}; seen = set()
    for m in j["meshes"]:
        for p in m["primitives"]:
            mat = j["materials"][p["material"]]["name"] if "material" in p else ""
            s = next((v for k, v in SCALE.items() if mat.startswith("Bz") and mat.endswith(k)), None)
            uv = p["attributes"].get("TEXCOORD_0")
            if s is None or uv is None or uv in seen:
                continue
            seen.add(uv)
            P = g.acc_raw(p["attributes"]["POSITION"]); N = g.acc_raw(p["attributes"]["NORMAL"]); U = g.acc_raw(uv).copy()
            top = N[:, 1] > 0.9
            U[top] = np.stack([P[top, 0] / s, P[top, 2] / s], 1)
            a = j["accessors"][uv]; a["bufferView"] = add_view(g, U.astype("<f4").tobytes(), 34962); a.pop("byteOffset", None)   # a fresh plain view; the old bytes go dead
            a["min"] = U.min(0).tolist(); a["max"] = U.max(0).tolist()
            done[mat] = done.get(mat, 0) + int(top.sum())
    print(json.dumps({"top_vertices_remapped": done}))
    print("wrote", path, save_glb(path, j, g.bin), "bytes")
