#!/usr/bin/env python3
"""Remove measured shutter and trim fragments along Hawk Lane. Run before compacting the GLB."""
import argparse

import numpy as np

from bridge_landscape_kit import add_accessor, add_view
from bridge_wave1 import Glb, save_glb

# Four stretched shutter faces and one detached strip, located by browser picking.
REGIONS = {
    "Shutters": ([25.55, 1.31, -137.48], [31.45, 3.30, -136.88], 4),
    "Props": ([32.67, 0.67, -137.71], [32.73, 1.16, -136.09], 5),
}
MARK = "hawk_lane_debris"


def run(source, output):
    world = Glb(source)
    doc = world.gltf
    if doc.get("extras", {}).get(MARK):
        print("Hawk Lane debris already removed")
        return
    roots = doc["scenes"][doc.get("scene", 0)]["nodes"]
    for name, (lo, hi, expected) in REGIONS.items():
        node, = (doc["nodes"][i] for i in roots if doc["nodes"][i].get("name") == name)
        primitive, = doc["meshes"][node["mesh"]]["primitives"]
        positions = world.acc_raw(primitive["attributes"]["POSITION"])
        faces = world.indices_of(primitive).reshape(-1, 3)
        vertices = positions[faces]
        inside = ((vertices >= lo) & (vertices <= hi)).all(axis=(1, 2))
        area_twice = np.linalg.norm(np.cross(vertices[:, 1] - vertices[:, 0], vertices[:, 2] - vertices[:, 0]), axis=1)
        visible = int((inside & (area_twice > 0.0001)).sum())
        if visible != expected:
            raise ValueError(f"{name}: expected {expected} visible debris faces, found {visible}")
        print(f"{name}: {visible} visible faces, {inside.sum()} total")
        if output:
            kept = faces[~inside].astype("<u4").ravel()
            view = add_view(world, kept.tobytes(), 34963)
            primitive["indices"] = add_accessor(world, view, 5125, len(kept), "SCALAR")
    if output:
        doc.setdefault("extras", {})[MARK] = True
        save_glb(output, doc, world.bin)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("world")
    parser.add_argument("--out", help="Without this flag, report the matched fragments and write nothing.")
    args = parser.parse_args()
    run(args.world, args.out)
