#!/usr/bin/env python3
"""Detach the one old bin that overlaps the Hawk Lane overlook."""
import argparse

import numpy as np

from bridge_landscape_kit import add_accessor, add_view
from bridge_wave1 import Glb, save_glb

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("world")
parser.add_argument("--out", help="Omit for a dry run.")
args = parser.parse_args()
world = Glb(args.world)
doc = world.gltf
mark = "hawk_overlook_bin"
if doc.get("extras", {}).get(mark):
    print("Hawk overlook bin already detached")
    raise SystemExit(0)

roots = doc["scenes"][doc.get("scene", 0)]["nodes"]
props, = (doc["nodes"][i] for i in roots if doc["nodes"][i].get("name") == "Props")
primitive, = doc["meshes"][props["mesh"]]["primitives"]
vertices = world.acc_raw(primitive["attributes"]["POSITION"])
faces = world.indices_of(primitive).reshape(-1, 3)
lo, hi = (36.28, 0.19, -179.14), (37.055, 1.11, -178.46)
inside = ((vertices[faces] >= lo) & (vertices[faces] <= hi)).all(axis=(1, 2))
if inside.sum() != 42:
    raise ValueError(f"Expected 42 old bin faces, found {inside.sum()}")
print("42 old bin faces")
if args.out:
    kept = faces[~inside].astype("<u4").ravel()
    view = add_view(world, kept.tobytes(), 34963)
    primitive["indices"] = add_accessor(world, view, 5125, len(kept), "SCALAR")
    doc.setdefault("extras", {})[mark] = True
    save_glb(args.out, doc, world.bin)
