#!/usr/bin/env python3
"""Apply the Bazaar sightline pass to the shipped city GLB.

The complete generator needs gitignored source asset packs. This bridge keeps
the same scene-level fixes visible in the shipped asset until those packs are
available for a full rebuild.
"""
import argparse
import copy
import math
import os
import random
import shutil
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
from meshoptimizer import encode_index_buffer
from bridge_wave1 import Glb, save_glb


def stall_layout():
    centers = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            for cx in (17, 26, 35, 44, 53):
                for cy in (18, 30, 42, 54):
                    if math.hypot(cx, cy) < 17:
                        continue
                    centers.append((sx * cx, sy * cy,
                                    "N" if sy < 0 else "S"))
    return centers


def selected_stalls(threshold):
    centers = stall_layout()
    return {i for i in range(len(centers))
            if random.Random(4000 + i).random() < threshold}


def procedural_stalls():
    centers = stall_layout()
    med = selected_stalls(0.65)
    return [p[:2] for i, p in enumerate(centers) if i not in med]


def degenerate_inside(glb, primitive, centers, half_x, half_z,
                      y_min, y_max):
    pos_i = primitive["attributes"]["POSITION"]
    positions = glb.acc_raw(pos_i)
    indices_i = primitive["indices"]
    indices = glb.indices_of(primitive).astype(np.uint32)
    triangles = indices.reshape(-1, 3)
    mid = positions[triangles].mean(axis=1)
    remove = np.zeros(len(triangles), dtype=bool)
    for x, z in centers:
        remove |= ((np.abs(mid[:, 0] - x) < half_x) &
                   (np.abs(mid[:, 2] - z) < half_z) &
                   (mid[:, 1] >= y_min) & (mid[:, 1] <= y_max))
    if remove.any():
        triangles[remove, 1] = triangles[remove, 0]
        triangles[remove, 2] = triangles[remove, 0]
        rewrite_indices(glb, indices_i, triangles.ravel(), len(positions))
    return int(remove.sum())


def promote_stalls(glb, report, dry_run=False):
    g = glb.gltf
    layout = stall_layout()
    current = selected_stalls(0.35)
    desired = selected_stalls(0.65)
    extra = sorted(desired - current)
    templates = {}
    existing = [n for n in g["nodes"]
                if n.get("name", "").startswith("SK_med_stall")]
    for node in existing:
        t = node.get("translation", (0, 0, 0))
        templates["N" if t[2] > 0 else "S"] = node
    if extra and not dry_run:
        assert set(templates) == {"N", "S"}, "stall facing templates missing"
        for i in extra:
            x, y, facing = layout[i]
            node = copy.deepcopy(templates[facing])
            node["name"] = f"SK_med_stall_BazaarPass_{i:02d}"
            node["translation"] = [x, node.get("translation", [0, .2, 0])[1], -y]
            if facing == "N":
                node["rotation"] = [0, 1, 0, 0]
            else:
                node.pop("rotation", None)
            node_index = len(g["nodes"])
            g["nodes"].append(node)
            g["scenes"][g.get("scene", 0)]["nodes"].append(node_index)

        positions = [(layout[i][0], -layout[i][1]) for i in extra]
        props_node = next(n for n in g["nodes"] if n.get("name") == "Props")
        props_prim = g["meshes"][props_node["mesh"]]["primitives"][0]
        report["removed_promoted_counter_triangles"] = degenerate_inside(
            glb, props_prim, positions, 2.35, 1.95, .2, 3.3)
        awning_i = next(i for i, m in enumerate(g["meshes"])
                        if m.get("name") == "awning")
        awning_prim = g["meshes"][awning_i]["primitives"][0]
        report["removed_promoted_awning_triangles"] = degenerate_inside(
            glb, awning_prim, positions, 2.31, 1.91, 2.25, 3.4)
    report["added_model_stalls"] = len(extra)


def compact_party_festoon(glb, report, dry_run=False):
    """Keep one short party-corner strand and remove the two skyline runs."""
    g = glb.gltf
    factor = 5.5 / 7.6
    props_node = next(n for n in g["nodes"] if n.get("name") == "Props")
    props = g["meshes"][props_node["mesh"]]["primitives"][0]
    pos_i = props["attributes"]["POSITION"]
    pos = glb.acc_raw(pos_i)
    inside_rows = np.zeros(len(pos), dtype=bool)
    for row in (27.0, 45.0):
        zmatch = np.abs(pos[:, 2] + row) < .18
        wires = zmatch & (np.abs(pos[:, 0]) < 7.8) & (pos[:, 1] > 4.35)
        posts = (zmatch & (np.abs(np.abs(pos[:, 0]) - 7.6) < .16) &
                 (pos[:, 1] >= .2) & (pos[:, 1] <= 5.35))
        inside_rows |= wires | posts
    center_wire = ((np.abs(pos[:, 2] + 36.0) < .18) &
                   (np.abs(pos[:, 0]) < 7.8) &
                   (np.abs(np.abs(pos[:, 0]) - 7.6) >= .16) &
                   (pos[:, 1] > 4.35))
    center_posts = ((np.abs(pos[:, 2] + 36.0) < .18) &
                    (np.abs(np.abs(pos[:, 0]) - 7.6) < .16) &
                    (pos[:, 1] >= .2) & (pos[:, 1] <= 5.35))
    report["removed_party_support_vertices"] = int(inside_rows.sum())
    report["compacted_party_vertices"] = int((center_wire | center_posts).sum())
    if not dry_run:
        # Wire and supports at the discarded endpoints are removed by
        # degenerating only their own triangles in the shared Props bucket.
        idx = glb.indices_of(props).astype(np.uint32)
        tri = idx.reshape(-1, 3)
        centers = pos[tri].mean(axis=1)
        remove = np.zeros(len(tri), dtype=bool)
        for row in (27.0, 45.0):
            zmatch = np.abs(centers[:, 2] + row) < .18
            remove |= (zmatch & (np.abs(centers[:, 0]) < 7.8) &
                       (centers[:, 1] > 4.35))
            remove |= (zmatch &
                       (np.abs(np.abs(centers[:, 0]) - 7.6) < .16) &
                       (centers[:, 1] >= .2) & (centers[:, 1] <= 5.35))
        report["removed_party_prop_triangles"] = int(remove.sum())
        if remove.any():
            tri[remove, 1] = tri[remove, 0]
            tri[remove, 2] = tri[remove, 0]
            rewrite_indices(glb, props["indices"], tri.ravel(), len(pos))
        pos[center_wire, 0] *= factor
        pos[center_wire, 1] = 4.6 + (pos[center_wire, 1] - 4.6) * (2 / 3)
        pos[center_posts, 0] *= factor
        pos[center_posts, 1] = .2 + (pos[center_posts, 1] - .2) * .96
        glb.rewrite_accessor(pos_i, pos)

    glow_node = next((n for n in g["nodes"]
                      if n.get("name") == "LampGlow"), None)
    if glow_node:
        glow = g["meshes"][glow_node["mesh"]]["primitives"][0]
        glow_pos_i = glow["attributes"]["POSITION"]
        glow_pos = glb.acc_raw(glow_pos_i)
        remove_vertices = np.zeros(len(glow_pos), dtype=bool)
        for row in (27.0, 45.0):
            remove_vertices |= ((np.abs(glow_pos[:, 2] + row) < .25) &
                                (np.abs(glow_pos[:, 0]) < 8.0) &
                                (glow_pos[:, 1] > 4.3))
        compact = ((np.abs(glow_pos[:, 2] + 36.0) < .25) &
                   (np.abs(glow_pos[:, 0]) < 8.0) &
                   (glow_pos[:, 1] > 4.3))
        if not dry_run:
            prim_idx = glb.indices_of(glow).astype(np.uint32)
            tri = prim_idx.reshape(-1, 3)
            centers = glow_pos[tri].mean(axis=1)
            remove = np.zeros(len(tri), dtype=bool)
            for row in (27.0, 45.0):
                remove |= ((np.abs(centers[:, 2] + row) < .25) &
                           (np.abs(centers[:, 0]) < 8.0) &
                           (centers[:, 1] > 4.3))
            report["removed_party_bulb_triangles"] = int(remove.sum())
            if remove.any():
                tri[remove, 1] = tri[remove, 0]
                tri[remove, 2] = tri[remove, 0]
                rewrite_indices(glb, glow["indices"], tri.ravel(),
                                len(glow_pos))
            glow_pos[compact, 0] *= factor
            glow_pos[compact, 1] = 4.6 + (glow_pos[compact, 1] - 4.6) * (2 / 3)
            glb.rewrite_accessor(glow_pos_i, glow_pos)


def rewrite_indices(glb, accessor_i, values, vertex_count):
    accessor = glb.gltf["accessors"][accessor_i]
    view = glb.gltf["bufferViews"][accessor["bufferView"]]
    encoded = encode_index_buffer(np.asarray(values, dtype=np.uint32),
                                  index_count=accessor["count"],
                                  vertex_count=vertex_count)
    while len(glb.bin) % 4:
        glb.bin += b"\x00"
    ext = view.setdefault("extensions", {}).setdefault(
        "EXT_meshopt_compression", {})
    ext.update({"mode": "TRIANGLES", "byteOffset": len(glb.bin),
                "byteLength": len(encoded),
                "byteStride": 2 if accessor["componentType"] == 5123 else 4,
                "count": accessor["count"]})
    ext.pop("filter", None)
    glb.bin += encoded
    glb.gltf["buffers"][0]["byteLength"] = len(glb.bin)


def apply(glb, dry_run=False):
    g = glb.gltf
    if g.get("extras", {}).get("bazaar_sightline_pass"):
        return {"already_patched": True}
    report = {"shrunk_trees": 0, "raised_awning_vertices": 0,
              "raised_posts": 0, "enlarged_benches": 0,
              "removed_plaza_prop_triangles": 0,
              "removed_plaza_bulb_triangles": 0}

    promote_stalls(glb, report, dry_run)
    compact_party_festoon(glb, report, dry_run)

    # Full-height plaza-rim trees sit directly behind the outer stall rows.
    for node in g["nodes"]:
        name = node.get("name", "")
        if not name.startswith("Tree_"):
            continue
        t = node.get("translation", (0, 0, 0))
        if abs(t[0]) < 60 and abs(t[2]) < 60:
            scale = node.get("scale", (1, 1, 1))
            node["scale"] = [float(s) * 0.16 for s in scale]
            report["shrunk_trees"] += 1

    # Slightly fuller seat proportions, consistent with build_city.py.
    for node in g["nodes"]:
        if node.get("name", "").startswith("SK_med_bench"):
            node["scale"] = [float(s) * 1.12
                             for s in node.get("scale", (1, 1, 1))]
            report["enlarged_benches"] += 1

    # Raise only the procedural Bazaar awnings; shopfront cloth stays put.
    mesh_i = next(i for i, m in enumerate(g["meshes"])
                  if m.get("name") == "awning")
    prim = g["meshes"][mesh_i]["primitives"][0]
    pos_i = prim["attributes"]["POSITION"]
    pos = glb.acc_raw(pos_i)
    for cx, cy in procedural_stalls():
        mask = ((np.abs(pos[:, 0] - cx) < 2.31) &
                (np.abs(pos[:, 2] + cy) < 1.91) &
                (pos[:, 1] >= 2.45) & (pos[:, 1] <= 3.2))
        report["raised_awning_vertices"] += int(mask.sum())
        pos[mask, 1] += 0.45
    if not dry_run and report["raised_awning_vertices"]:
        glb.rewrite_accessor(pos_i, pos)

    # Raise procedural stall posts at their four corners to meet the lifted cloth.
    props_i = next(i for i, n in enumerate(g["nodes"])
                   if n.get("name") == "Props")
    props_prim = g["meshes"][g["nodes"][props_i]["mesh"]]["primitives"][0]
    props_pos_i = props_prim["attributes"]["POSITION"]
    props_pos = glb.acc_raw(props_pos_i)
    for cx, cy in procedural_stalls():
        for dx in (-2.0, 2.0):
            for dy in (-1.5, 1.5):
                mask = ((np.abs(props_pos[:, 0] - (cx + dx)) < 0.061) &
                        (np.abs(props_pos[:, 2] + cy + dy) < 0.061) &
                        (props_pos[:, 1] >= 2.89) &
                        (props_pos[:, 1] <= 2.91))
                report["raised_posts"] += int(mask.sum())
                props_pos[mask, 1] += 0.45
    if not dry_run and report["raised_posts"]:
        glb.rewrite_accessor(props_pos_i, props_pos)

    # The plaza festoons include separate emissive-bulb geometry. Remove both
    # the wire/pole triangles and their bulbs from the clear central ring.
    def clear_ring(primitive, y_min, key):
        pos_values = glb.acc_raw(primitive["attributes"]["POSITION"])
        idx = glb.indices_of(primitive).astype(np.uint32)
        tris = idx.reshape(-1, 3)
        centers = pos_values[tris].mean(axis=1)
        radius = np.hypot(centers[:, 0], centers[:, 2])
        remove = ((radius > 20.5) & (radius < 23.5) &
                  (centers[:, 1] > y_min) & (centers[:, 1] < 6.3))
        report[key] = int(remove.sum())
        if not dry_run and remove.any():
            tris[remove, 1] = tris[remove, 0]
            tris[remove, 2] = tris[remove, 0]
            rewrite_indices(glb, primitive["indices"], tris.ravel(),
                            len(pos_values))

    clear_ring(props_prim, 0.2, "removed_plaza_prop_triangles")
    glow_node = next((n for n in g["nodes"]
                      if n.get("name") == "LampGlow"), None)
    if glow_node:
        glow_prim = g["meshes"][glow_node["mesh"]]["primitives"][0]
        clear_ring(glow_prim, 5.0, "removed_plaza_bulb_triangles")

    if not dry_run:
        g.setdefault("extras", {})["bazaar_sightline_pass"] = "v3"
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("glb", nargs="?", default=
                        "apps/console/public/assets/world-city3.glb")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    glb = Glb(args.glb)
    if glb.gltf.get("extras", {}).get("bazaar_sightline_pass"):
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
        # Verify the rewritten compressed streams can be decoded before replace.
        check = Glb(tmp)
        for i in glb.modified_accessors:
            check.acc_raw(i)
        shutil.copy2(target, "/tmp/world-city3.glb.pre-bazaar")
        os.replace(tmp, target)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


if __name__ == "__main__":
    main()
