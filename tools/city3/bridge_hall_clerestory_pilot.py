#!/usr/bin/env python3
"""Glaze the central south clerestory bay while retaining the original ironwork atlas."""
import argparse
from collections import deque
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

from bridge_landscape_kit import add_accessor, add_view
from bridge_wave1 import Glb, _rotmat, save_glb

MARK = "market_hall_south_clerestory_pilot"


def pane_texture(world, material, uv):
    doc = world.gltf
    texture = doc["textures"][material["pbrMetallicRoughness"]["baseColorTexture"]["index"]]
    atlas = doc["images"][texture["source"]]
    if atlas["name"] != "townhouse_troyes_market_hall":
        raise ValueError("Unexpected Market Hall atlas")
    image = Image.open(BytesIO(world.view_physical_bytes(atlas["bufferView"]))).convert("RGBA")
    size = np.array(image.size)
    left, top = np.floor(uv.min(0) * size).astype(int)
    right, bottom = np.ceil(uv.max(0) * size).astype(int)
    if (left, top, right, bottom) != (0, 641, 512, 801):
        raise ValueError("The selected bay no longer maps to the measured ironwork atlas region")
    crop = np.array(image.crop((left, top, right, bottom)))
    # The original pane regions are connected black cavities with intact gray
    # frame outlines. Flood only those three regions. The dark spandrels stay.
    candidate = crop[:, :, :3].max(axis=2) < 53
    candidate[:8] = False
    candidate[117:] = False
    mask = np.zeros_like(candidate)
    for x in (91, 256, 421):
        component = np.zeros_like(mask)
        queue = deque([(50, x)])
        while queue:
            y, col = queue.popleft()
            if not (0 <= y < crop.shape[0] and 0 <= col < crop.shape[1]):
                continue
            if component[y, col] or not candidate[y, col]:
                continue
            component[y, col] = True
            queue.extend(((y - 1, col), (y + 1, col), (y, col - 1), (y, col + 1)))
        if not 13_000 < component.sum() < 14_000 or (mask & component).any():
            raise ValueError("The glass mask escaped the measured pane outlines")
        mask |= component
    feather = np.asarray(Image.fromarray(mask.astype(np.uint8) * 255).filter(ImageFilter.GaussianBlur(0.45))) / 255
    pane = np.array([154, 186, 207, 26])
    rgba = np.rint(crop * (1 - feather[..., None]) + pane * feather[..., None]).astype(np.uint8)
    image = Image.fromarray(rgba)
    buffer = BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return image, buffer.getvalue(), (uv * size - [left, top]) / [right - left, bottom - top]


def accessor(world, data, kind, component, target, bounds=False):
    view = add_view(world, data.tobytes(), target)
    minimum, maximum = (data.min(0).tolist(), data.max(0).tolist()) if bounds else (None, None)
    return add_accessor(world, view, component, len(data), kind, minimum, maximum)


def install(world, preview):
    doc = world.gltf
    if doc.get("extras", {}).get(MARK):
        print("Market Hall clerestory pilot already installed")
        return
    node, = (n for n in doc["nodes"] if n.get("name") == "Kit_hall0_troyes_market_hall")
    mesh = doc["meshes"][node["mesh"]]
    original, = mesh["primitives"]
    local = world.acc_raw(original["attributes"]["POSITION"])
    points = (local * node["scale"]) @ _rotmat(node["rotation"]).T + node["translation"]
    faces = world.indices_of(original).reshape(-1, 3)
    tris = points[faces]
    lo, hi = tris.min(1), tris.max(1)
    select = (
        (np.abs(tris[:, :, 2] + 85.0658) < 0.002).all(1)
        & (np.abs(lo[:, 0] - 32.4498) < 0.002)
        & (np.abs(hi[:, 0] - 37.5502) < 0.002)
        & (np.abs(lo[:, 1] - 9.6989) < 0.002)
        & (np.abs(hi[:, 1] - 11.3414) < 0.002)
    )
    if select.sum() != 2:
        raise ValueError(f"Expected exactly two central south window faces, found {select.sum()}")
    ids, remapped = np.unique(faces[select], return_inverse=True)
    source_mat = doc["materials"][original["material"]]
    uv = world.acc_raw(original["attributes"]["TEXCOORD_0"])[ids]
    image, data, texcoords = pane_texture(world, source_mat, uv)
    if preview:
        image.save(preview)

    view = add_view(world, data, None)
    doc["bufferViews"][view].pop("target", None)
    doc["images"].append({"name": "market_hall_south_clerestory", "bufferView": view, "mimeType": "image/png"})
    doc["textures"].append({"source": len(doc["images"]) - 1})
    doc["materials"].append({
        "name": "Market Hall South Clerestory",
        "alphaMode": "BLEND",
        "doubleSided": True,
        "pbrMetallicRoughness": {
            "baseColorTexture": {"index": len(doc["textures"]) - 1},
            "metallicFactor": 0,
            "roughnessFactor": 0.48,
        },
    })
    original["indices"] = accessor(world, faces[~select].astype("<u4").ravel(), "SCALAR", 5125, 34963)
    normals = world.acc_raw(original["attributes"]["NORMAL"])[ids].astype("<f4")
    mesh["primitives"].append({
        "attributes": {
            "POSITION": accessor(world, local[ids].astype("<f4"), "VEC3", 5126, 34962, bounds=True),
            "NORMAL": accessor(world, normals, "VEC3", 5126, 34962),
            "TEXCOORD_0": accessor(world, texcoords.astype("<f4"), "VEC2", 5126, 34962),
        },
        "indices": accessor(world, remapped.astype("<u2").ravel(), "SCALAR", 5123, 34963),
        "material": len(doc["materials"]) - 1,
    })
    doc.setdefault("extras", {})[MARK] = True
    print("Central south bay glazed: 5.100 × 1.642 m, three panes and original frames")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("world")
    parser.add_argument("--out")
    parser.add_argument("--preview", type=Path)
    args = parser.parse_args()
    world = Glb(args.world)
    install(world, args.preview)
    if args.out:
        save_glb(args.out, world.gltf, world.bin)
