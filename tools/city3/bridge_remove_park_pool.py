#!/usr/bin/env python3
"""Remove the northwest park's old basin, coping and collision from a built City 3."""
import argparse

import numpy as np

from bridge_landscape_kit import add_accessor, add_view
from bridge_wave1 import Glb, save_glb

MARK = "northwest_park_open_lawn"
BOUNDS = ((-92.41, -0.10, -112.41), (-79.59, 1.20, -105.59))


def cut(glb, name, materials):
    doc = glb.gltf
    node, = (n for n in doc["nodes"] if n.get("name") == name)
    matched = set()
    for primitive in doc["meshes"][node["mesh"]]["primitives"]:
        material = doc["materials"][primitive["material"]].get("name")
        if material not in materials:
            continue
        p = glb.acc_raw(primitive["attributes"]["POSITION"])
        faces = glb.indices_of(primitive).reshape(-1, 3)
        verts = p[faces]
        remove = ((verts >= BOUNDS[0]) & (verts <= BOUNDS[1])).all(axis=(1, 2))
        if int(remove.sum()) != materials[material]:
            raise ValueError(f"{name}/{material}: expected {materials[material]} basin faces, found {remove.sum()}")
        matched.add(material)
        kept = faces[~remove].astype("<u4").ravel()
        primitive["indices"] = add_accessor(glb, add_view(glb, kept.tobytes(), 34963), 5125, len(kept), "SCALAR")
    if matched != set(materials):
        raise ValueError(f"{name}: missing basin materials {set(materials) - matched}")
    doc.setdefault("extras", {})[MARK] = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("world")
    parser.add_argument("collision")
    parser.add_argument("--out", nargs=2, metavar=("WORLD", "COLLISION"))
    args = parser.parse_args()
    world, collision = Glb(args.world), Glb(args.collision)
    marked = [g.gltf.get("extras", {}).get(MARK) for g in (world, collision)]
    if all(marked):
        print("Northwest park lawn already clear")
        return
    if any(marked):
        raise ValueError("Park visual and collision revisions differ")
    cut(world, "BzOpenSpace", {"BzOpen_stone": 40, "BzOpen_water": 2})
    cut(collision, "col_bazaar_open", {"col_grey": 12})
    print("42 visual faces and one collision box removed from the northwest lawn")
    if args.out:
        for g, out in zip((world, collision), args.out):
            save_glb(out, g.gltf, g.bin)


if __name__ == "__main__":
    main()
