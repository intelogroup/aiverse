#!/usr/bin/env python3
"""Open the existing south recess of the Troyes Market Hall and hollow its collider."""
import argparse
from pathlib import Path

import numpy as np

from bridge_citadel_townhouses import box_mesh
from bridge_landscape_kit import add_accessor, add_view
from bridge_wave1 import Glb, _rotmat, save_glb

MARK = "market_hall_south_entry"
ASSETS = Path("apps/console/public/assets")


def only_mesh(g, name):
    node, = (node for node in g["nodes"] if node.get("name") == name)
    prim, = g["meshes"][node["mesh"]]["primitives"]
    return node, prim


def indices(glb, faces, dtype, component):
    data = np.asarray(faces, dtype=dtype).ravel()
    return add_accessor(glb, add_view(glb, data.tobytes(), 34963), component, len(data), "SCALAR")


def open_entry(world, collision):
    shell, surface = only_mesh(world.gltf, "Kit_hall0_troyes_market_hall")
    points = world.acc_raw(surface["attributes"]["POSITION"])
    rotation = _rotmat(shell["rotation"])
    points = (points * shell["scale"]) @ rotation.T + shell["translation"]
    faces = world.indices_of(surface).reshape(-1, 3)
    verts = points[faces]
    # The two leaves are four coplanar faces inside the modeled jambs.
    # Keep the jamb returns and lintel. Fail if a new source changes that topology.
    bounds_min, bounds_max = verts.min(axis=1), verts.max(axis=1)
    cut = (
        (np.abs(verts[:, :, 2] + 76.9836) < 0.005).all(axis=1)
        & (bounds_min[:, 0] > 32.47)
        & (bounds_max[:, 0] < 37.53)
        & (bounds_min[:, 1] < 0.01)
        & (np.abs(bounds_max[:, 1] - 2.8153) < 0.005)
    )
    if cut.sum() != 4:
        raise ValueError(f"Expected four door leaf faces, found {cut.sum()}")
    opening = verts[cut].reshape(-1, 3)
    left, bottom, front = opening.min(axis=0)
    right, header, _ = opening.max(axis=0)
    x0, floor, z0 = points.min(axis=0)
    x1, top, _ = points.max(axis=0)

    _, collider = only_mesh(collision.gltf, "col_kit_hall0")
    old_bounds = collision.acc_raw(collider["attributes"]["POSITION"])
    if len(old_bounds) != 8 or not np.allclose(old_bounds.min(axis=0), points.min(axis=0), atol=0.001):
        raise ValueError("Hall collision no longer matches its original solid footprint")
    if not np.allclose(old_bounds.max(axis=0), points.max(axis=0), atol=0.001):
        raise ValueError("Hall visual and collision bounds differ")

    depth = 0.24
    segments = [
        (x0, z0, x1, z0 + depth, floor),
        (x0, z0 + depth, x0 + depth, front, floor),
        (x1 - depth, z0 + depth, x1, front, floor),
        (x0, front - depth, left, front, floor),
        (right, front - depth, x1, front, floor),
        (left, front - depth, right, front, header),
    ]
    pos, faces_col = [], []
    for xa, za, xb, zb, y in segments:
        vertices, triangles = box_mesh(xa, za, xb, zb, top - y)
        vertices[:, 1] += y
        faces_col.append(triangles + 8 * len(pos))
        pos.append(vertices)
    vertices = np.concatenate(pos)
    collider["attributes"]["POSITION"] = add_accessor(
        collision, add_view(collision, vertices.tobytes(), 34962), 5126, len(vertices), "VEC3",
        vertices.min(axis=0).tolist(), vertices.max(axis=0).tolist(),
    )
    collider["indices"] = indices(collision, np.concatenate(faces_col), "<u2", 5123)
    surface["indices"] = indices(world, faces[~cut], "<u4", 5125)
    return f"{int(cut.sum())} faces removed, opening {right - left:.3f} × {header - bottom:.3f} m, {len(segments)} collider segments"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("world", nargs="?", default=ASSETS / "world-city3.glb")
    parser.add_argument("collision", nargs="?", default=ASSETS / "world-city3-collision.glb")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    world, collision = Glb(args.world), Glb(args.collision)
    marked = [bool(g.gltf.get("extras", {}).get(MARK)) for g in (world, collision)]
    if all(marked):
        print("South entry already open")
        return
    if any(marked):
        raise ValueError("Hall visual and collision files do not have the same entry revision")
    print(open_entry(world, collision))
    if not args.dry_run:
        for g in (world, collision):
            g.gltf.setdefault("extras", {})[MARK] = True
            print(g.path, save_glb(g.path, g.gltf, g.bin), "bytes")


if __name__ == "__main__":
    main()
