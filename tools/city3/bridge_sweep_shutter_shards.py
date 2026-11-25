#!/usr/bin/env python3
"""Remove the stretched shutters left by cleared storefronts in all four ring quadrants."""
import argparse

import numpy as np

from bridge_landscape_kit import add_accessor, add_view
from bridge_sweep_orphans import keep_mask
from bridge_wave1 import Glb, save_glb

MARK = "outer_ring_shutter_shards"


def run(source, output):
    world = Glb(source)
    doc = world.gltf
    if doc.get("extras", {}).get(MARK):
        print("Outer ring shutter shards already removed")
        return
    roots = doc["scenes"][doc.get("scene", 0)]["nodes"]
    shutters, = (doc["nodes"][i] for i in roots if doc["nodes"][i].get("name") == "Shutters")
    if any(k in shutters for k in ("translation", "rotation", "scale", "matrix", "extensions")):
        raise ValueError("Expected the original world-space shutter mesh")
    primitive, = doc["meshes"][shutters["mesh"]]["primitives"]
    faces = world.indices_of(primitive).reshape(-1, 3)
    triangles = world.acc_raw(primitive["attributes"]["POSITION"])[faces]
    lo, hi = triangles.min(axis=1), triangles.max(axis=1)
    span = (hi - lo)[:, [0, 2]]
    outer = np.abs(triangles[:, :, [0, 2]].mean(axis=1)).max(axis=1) > 124
    protected = keep_mask(triangles.reshape(-1, 3)).reshape(-1, 3).any(axis=1)
    # The clipped asset leaves one stretched face per shutter, anchored at
    # these exact elevations. Prebuilt house meshes are separate districts.
    shards = (
        outer & ~protected
        & (abs(lo[:, 1] - 1.32) < 0.007) & (abs(hi[:, 1] - 3.284) < 0.007)
        & (span.min(axis=1) > 0.23) & (span.max(axis=1) > 0.49) & (span.max(axis=1) < 0.73)
    )
    count = int(shards.sum())
    if count != 130:
        raise ValueError(f"Expected 130 shutter shards, found {count}")
    print(f"{count} outer-ring shutter shards")
    if output:
        kept = faces[~shards].astype("<u4").ravel()
        view = add_view(world, kept.tobytes(), 34963)
        primitive["indices"] = add_accessor(world, view, 5125, len(kept), "SCALAR")
        doc.setdefault("extras", {})[MARK] = True
        save_glb(output, doc, world.bin)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("world")
    parser.add_argument("--out", help="Omit to audit the source without writing.")
    args = parser.parse_args()
    run(args.world, args.out)
