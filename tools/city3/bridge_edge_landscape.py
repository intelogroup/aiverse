#!/usr/bin/env python3
"""Remove generic edge-ring houses from a shipped city GLB (landscape pass).

Buildings are merged into a few world-wide meshes (facades, roofs, shutters,
window/chimney props), so removal is per triangle: any triangle of those
meshes whose centroid lies inside a chosen edge-block building footprint
(+PAD) and above the walk slab is collapsed to a degenerate triangle, the
same trick bridge_bazaar.py uses. Footprints come from plan.py (run in a temp
cwd because plan.py writes plan.json) so lot ids / rng are never touched.

GLB frame: x_t = x, z_t = -y_plan, y up. Plan y -> GLB z is negated.

Usage (from repo root):
  python3 tools/city3/bridge_edge_landscape.py --blocks 0,3 --dry-run
  python3 tools/city3/bridge_edge_landscape.py --blocks 0,3
  python3 tools/city3/bridge_edge_landscape.py --blocks 0,3 \
      apps/console/public/assets/world-city3-collision.glb --all-meshes
Run on world-city3.glb AND world-city3-collision.glb, then rebuild
world-shell.glb (build_shell.py) and the navmesh (packages/world-sim bake).
"""
import argparse
import json
import os
import runpy
import shutil
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
from bridge_wave1 import Glb, save_glb
from bridge_bazaar import rewrite_indices

PAD = 0.4          # metres around each footprint
Y_MIN = 0.3        # keep the walk slab (0.2) and sidewalks
MARK = "edge_landscape_pass"
# Merged building meshes in world-city3.glb (verified by node census).
VISUAL_NODES = ("B_Facade_", "RoofFlat", "RoofTile", "Shutters", "LampGlow",
                "Props", "Awnings", "Glass", "Signs", "InteriorWalls")


def edge_rects(blocks, key="buildings"):
    """Edge-block rects [x0, y0, x1, y1] (plan frame) for blocks.
    key: 'buildings' (house footprints) or 'courtyards' (inner yard slab)."""
    here = os.getcwd()
    tmp = tempfile.mkdtemp()
    try:
        os.chdir(tmp)  # plan.py dumps plan.json into cwd
        ns = runpy.run_path(os.path.join(os.path.dirname(
            os.path.abspath(__file__)), "plan.py"))
    finally:
        os.chdir(here)
        shutil.rmtree(tmp, ignore_errors=True)
    kinds = {(b["i"], b["j"]): b["kind"] for b in ns["blocks"]}
    out = []
    for bd in ns[key]:
        key = tuple(bd["block"])
        if kinds[key] != "edge":
            continue
        if blocks is not None and key not in blocks:
            continue
        out.append(bd["rect"])
    return out


def to_glb(rects):
    return np.array([[x0 - PAD, -(y1 + PAD), x1 + PAD, -(y0 - PAD)]
                     for x0, y0, x1, y1 in rects])   # x0, z0, x1, z1 (GLB)


def cut(glb, rects, all_meshes, dry_run, yards=()):
    g = glb.gltf
    report = {}
    r = to_glb(rects)
    ry = to_glb(yards) if len(yards) else np.zeros((0, 4))
    for node in g["nodes"]:
        name = node.get("name", "")
        if "mesh" not in node:
            continue
        is_yard = name == "Courtyards"
        if not all_meshes and not is_yard and \
                not name.startswith(VISUAL_NODES):
            continue
        rr = ry if is_yard else r
        ymin = -1.0 if is_yard else Y_MIN   # yard slab sits at y=0.3
        # Merged meshes sit at the origin; a transform would shift centroids.
        assert not any(k in node for k in ("translation", "rotation",
                                           "scale", "matrix")) or \
            all_meshes, f"{name} has a transform; centroid test invalid"
        total = 0
        for prim in g["meshes"][node["mesh"]]["primitives"]:
            if "indices" not in prim or prim.get("mode", 4) != 4:
                continue
            pos = glb.acc_raw(prim["attributes"]["POSITION"])
            tri = glb.indices_of(prim).astype(np.uint32).reshape(-1, 3)
            c = pos[tri].mean(axis=1)
            hit = np.zeros(len(tri), dtype=bool)
            for x0, z0, x1, z1 in rr:
                hit |= ((c[:, 0] >= x0) & (c[:, 0] <= x1) &
                        (c[:, 2] >= z0) & (c[:, 2] <= z1))
            hit &= c[:, 1] > ymin
            n = int(hit.sum())
            total += n
            if n and not dry_run:
                tri[hit, 1] = tri[hit, 0]
                tri[hit, 2] = tri[hit, 0]
                rewrite_indices(glb, prim["indices"], tri.ravel(), len(pos))
                # Views that were stored uncompressed have no 'buffer' key
                # yet; Blender and three.js both require it on the extension.
                view = g["bufferViews"][g["accessors"][prim["indices"]]
                                        ["bufferView"]]
                view["extensions"]["EXT_meshopt_compression"].setdefault(
                    "buffer", 0)
                used = set(g.get("extensionsUsed", []))
                used.add("EXT_meshopt_compression")
                g["extensionsUsed"] = sorted(used)
        if total:
            report[name] = report.get(name, 0) + total
    return report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("glb", nargs="?",
                    default="apps/console/public/assets/world-city3.glb")
    ap.add_argument("--blocks", default=None,
                    help="'i,j;i,j' edge blocks; omit with --all-edge")
    ap.add_argument("--all-edge", action="store_true")
    ap.add_argument("--all-meshes", action="store_true",
                    help="cut every mesh node (collision GLB)")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if bool(a.blocks) == a.all_edge:
        ap.error("pass exactly one of --blocks or --all-edge")
    blocks = None if a.all_edge else {
        tuple(int(v) for v in s.split(",")) for s in a.blocks.split(";")}
    rects = edge_rects(blocks)
    if not rects:
        sys.exit("no edge building footprints selected")
    glb = Glb(a.glb)
    prev = glb.gltf.get("extras", {}).get(MARK)
    if prev:
        print({"already_patched": prev})
        return
    yards = [] if a.all_meshes else edge_rects(blocks, "courtyards")
    report = cut(glb, rects, a.all_meshes, a.dry_run, yards)
    print(json.dumps({"footprints": len(rects), "removed_triangles": report,
                      "total": sum(report.values())}, indent=1))
    if a.dry_run:
        return
    glb.gltf.setdefault("extras", {})[MARK] = {
        "blocks": sorted(map(list, blocks)) if blocks else "all-edge"}
    target = os.path.abspath(a.glb)
    fd, tmp = tempfile.mkstemp(suffix=".glb", dir=os.path.dirname(target))
    os.close(fd)
    try:
        save_glb(tmp, glb.gltf, glb.bin)
        check = Glb(tmp)  # decode every rewritten prim before replacing
        for node in check.gltf["nodes"]:
            if "mesh" in node and (a.all_meshes or
                                   node.get("name", "").startswith(VISUAL_NODES)):
                for prim in check.gltf["meshes"][node["mesh"]]["primitives"]:
                    if "indices" in prim:
                        check.indices_of(prim)
        for bv in check.gltf["bufferViews"]:
            ext = bv.get("extensions", {}).get("EXT_meshopt_compression")
            assert ext is None or "buffer" in ext, "meshopt ext lacks buffer"
        shutil.copy2(target, "/tmp/%s.pre-edge-landscape" %
                     os.path.basename(target))
        os.replace(tmp, target)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


if __name__ == "__main__":
    main()
