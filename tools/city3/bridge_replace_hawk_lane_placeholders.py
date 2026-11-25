#!/usr/bin/env python3
"""Detach Hawk Lane's old path stamps and shoreline box stack from the world GLB."""
import argparse

import numpy as np

from bridge_landscape_kit import add_accessor, add_view
from bridge_wave1 import Glb, save_glb

MARK = "hawk_lane_real_assets"


def run(source, output):
    world = Glb(source)
    doc = world.gltf
    if doc.get("extras", {}).get(MARK):
        print("Hawk Lane placeholders already detached")
        return
    roots = [doc["nodes"][i] for i in doc["scenes"][doc.get("scene", 0)]["nodes"]]
    landscape, = [node for node in roots if node.get("name") == "Landscape_edge_631"]
    paths = [i for i in landscape["children"] if doc["nodes"][i].get("name") == "ls_path"]
    locations = sorted(doc["nodes"][i]["translation"] for i in paths)
    expect = [[x, 0.23, -157.5] for x in range(14, 39, 3)]
    if len(locations) != len(expect) or not np.allclose(locations, expect, atol=0.001, rtol=0):
        raise ValueError(f"Unexpected Hawk Lane path layout: {locations}")

    props, = [node for node in roots if node.get("name") == "Props"]
    primitive, = doc["meshes"][props["mesh"]]["primitives"]
    positions = world.acc_raw(primitive["attributes"]["POSITION"])
    faces = world.indices_of(primitive).reshape(-1, 3)
    bounds = ([28.17, 0.19, -179.17], [29.45, 1.37, -178.48])
    inside = ((positions[faces] >= bounds[0]) & (positions[faces] <= bounds[1])).all(axis=(1, 2))
    if inside.sum() != 70:
        raise ValueError(f"Expected 70 shoreline stack triangles, found {inside.sum()}")
    print(f"{len(paths)} local path stamps and {inside.sum()} box-stack faces")
    if output:
        landscape["children"] = [i for i in landscape["children"] if i not in paths]
        kept = faces[~inside].astype("<u4").ravel()
        view = add_view(world, kept.tobytes(), 34963)
        primitive["indices"] = add_accessor(world, view, 5125, len(kept), "SCALAR")
        doc.setdefault("extras", {})[MARK] = True
        save_glb(output, doc, world.bin)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("world")
    parser.add_argument("--out", help="Omit to verify the source geometry without writing.")
    args = parser.parse_args()
    run(args.world, args.out)
