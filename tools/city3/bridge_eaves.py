#!/usr/bin/env python3
"""Close see-through roof eaves in world-city3.glb by making single-sided roof materials double-sided.

Roof meshes such as roof_tile_v4 are one sheet with up-facing triangles only. The browser renders
glTF materials FrontSide, so seen from the street below the overhang the eave band disappears and
sky shows between the facade top and the roof (Workbench with backface culling reproduces it,
2026-11-26). Flagging the material doubleSided makes three.js draw the underside, lit with the
flipped normal. JSON-only: the BIN chunk is untouched, collision GLB and navmesh are unaffected.
Idempotent.
  python3 tools/city3/bridge_eaves.py IN.glb OUT.glb [--check]
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from bridge_wave1 import Glb, save_glb

EAVE_MATERIALS = ("roof_tile_v4",)


def single_sided(g):
    return [m["name"] for m in g["materials"] if m.get("name") in EAVE_MATERIALS and not m.get("doubleSided")]


def main():
    src, dst = sys.argv[1], sys.argv[2]
    glb = Glb(src); g = glb.gltf
    found = {m.get("name") for m in g["materials"]}
    missing = [n for n in EAVE_MATERIALS if n not in found]
    assert not missing, f"eave materials not in GLB: {missing}"
    fixed = single_sided(g)
    for m in g["materials"]:
        if m.get("name") in EAVE_MATERIALS:
            m["doubleSided"] = True
    save_glb(dst, g, glb.bin)
    print(json.dumps({"double_sided": fixed}))


if __name__ == "__main__":
    if "--check" in sys.argv:
        left = single_sided(Glb(sys.argv[1]).gltf)
        print(json.dumps({"single_sided_eaves": left})); sys.exit(1 if left else 0)
    main()
