#!/usr/bin/env python3
"""Reduce the distant Halo spire silhouette in the shipped world GLB.

The Bazaar is adjacent to the Halo Lagoon district. Its 140 m hero spire
overwhelmed the medieval skyline, so the source generator and shipped mesh
both shorten it to the new 102 m profile.
"""
import argparse
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
from bridge_wave1 import Glb, save_glb

FACTOR = 0.73
BASE = 0.2


def apply(glb, dry_run=False):
    g = glb.gltf
    if g.get("extras", {}).get("bazaar_skyline_pass"):
        return {"already_patched": True}
    accessors = set()
    for node in g["nodes"]:
        if not node.get("name", "").startswith("spire_"):
            continue
        for prim in g["meshes"][node["mesh"]]["primitives"]:
            accessors.add(prim["attributes"]["POSITION"])
    if not accessors:
        raise RuntimeError("No named Halo spire meshes found")
    span = 0.0
    for accessor_i in accessors:
        acc = g["accessors"][accessor_i]
        span = max(span, acc["max"][1] - BASE)
        if not dry_run:
            pos = glb.acc_raw(accessor_i)
            pos[:, 1] = BASE + (pos[:, 1] - BASE) * FACTOR
            glb.rewrite_accessor(accessor_i, pos)
    g.setdefault("extras", {})["bazaar_skyline_pass"] = "v1"
    return {"spire_position_accessors": len(accessors),
            "original_height": round(span, 1),
            "new_height": round(span * FACTOR, 1)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("glb", nargs="?", default=
                        "apps/console/public/assets/world-halo.glb")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    glb = Glb(args.glb)
    if glb.gltf.get("extras", {}).get("bazaar_skyline_pass"):
        print({"already_patched": True})
        return
    report = apply(glb, args.dry_run)
    print(report)
    if args.dry_run:
        return
    target = os.path.abspath(args.glb)
    fd, tmp = tempfile.mkstemp(suffix=".glb", dir=os.path.dirname(target))
    os.close(fd)
    try:
        save_glb(tmp, glb.gltf, glb.bin)
        check = Glb(tmp)
        for i in glb.modified_accessors:
            check.acc_raw(i)
        shutil.copy2(target, "/tmp/world-halo.glb.pre-bazaar")
        os.replace(tmp, target)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


if __name__ == "__main__":
    main()
