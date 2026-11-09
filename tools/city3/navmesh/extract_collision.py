#!/usr/bin/env python3
"""Extract world-space triangle soup from world-city3-collision.glb.

The collision GLB is NOT meshopt-compressed (only KHR_texture_transform).
Node geometry may be local: the Tea House structure rides under a
translated parent node (and the lift doors carry their own translation)
since the elevator build, so world matrices are accumulated down the
scene graph and applied to positions. Output: a binary blob
[u32 nVerts][f32 positions...][u32 nIdx][u32 indices...] plus a JSON
sidecar with per-mesh stats, consumed by bake_navmesh.mjs.

Usage: extract_collision.py [collision.glb] [out.bin]
"""
import json, struct, sys, os
import numpy as np

SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(__file__), "../../../apps/console/public/assets/world-city3-collision.glb")
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "collision-geom.bin")

d = open(SRC, "rb").read()
assert d[:4] == b"glTF", "not a GLB"
n = struct.unpack("<I", d[12:16])[0]
j = json.loads(d[20:20 + n])
off = 20 + n
bl = struct.unpack("<I", d[off:off + 4])[0]
BIN = d[off + 8:off + 8 + bl]

CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}

def accessor(i):
    a = j["accessors"][i]
    bv = j["bufferViews"][a["bufferView"]]
    start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    dt = CT[a["componentType"]]
    ncomp = NC[a["type"]]
    count = a["count"]
    stride = bv.get("byteStride")
    itemsize = np.dtype(dt).itemsize * ncomp
    if stride and stride != itemsize:
        raw = np.empty(count * itemsize, dtype=np.uint8)
        for k in range(count):
            raw[k * itemsize:(k + 1) * itemsize] = np.frombuffer(
                BIN[start + k * stride: start + k * stride + itemsize], dtype=np.uint8)
        arr = raw.view(dt)
    else:
        arr = np.frombuffer(BIN[start:start + itemsize * count], dtype=dt).copy()
    return arr.reshape(count, ncomp) if ncomp > 1 else arr

def local_matrix(node):
    if "matrix" in node:
        # glTF matrices are column-major.
        return np.array(node["matrix"], dtype=np.float64).reshape(4, 4).T
    t = node.get("translation", [0, 0, 0])
    q = node.get("rotation", [0, 0, 0, 1])  # xyzw
    s = node.get("scale", [1, 1, 1])
    x, y, z, w = q
    R = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ], dtype=np.float64)
    M = np.eye(4)
    M[:3, :3] = R * np.array(s, dtype=np.float64)
    M[:3, 3] = t
    return M

# Accumulate world matrices down the scene graph (roots first).
parents = {}
for i, node in enumerate(j["nodes"]):
    for c in node.get("children", []):
        parents[c] = i
world = [None] * len(j["nodes"])
def world_matrix(i):
    if world[i] is None:
        m = local_matrix(j["nodes"][i])
        world[i] = world_matrix(parents[i]) @ m if i in parents else m
    return world[i]

positions, indices, stats = [], [], []
voff = 0
for ni, node in enumerate(j["nodes"]):
    if "mesh" not in node:
        continue
    name = node.get("name", "?")
    W = world_matrix(ni)
    mesh = j["meshes"][node["mesh"]]
    mtris = 0
    for prim in mesh["primitives"]:
        pos = accessor(prim["attributes"]["POSITION"]).astype(np.float64)
        pos = pos @ W[:3, :3].T + W[:3, 3]
        pos = pos.astype(np.float32)
        if "indices" in prim:
            idx = accessor(prim["indices"]).astype(np.uint32).reshape(-1)
        else:
            idx = np.arange(pos.shape[0], dtype=np.uint32)
        positions.append(pos)
        indices.append(idx + voff)
        voff += pos.shape[0]
        mtris += idx.shape[0] // 3
    stats.append({"node": name, "tris": mtris})

P = np.concatenate(positions) if positions else np.zeros((0, 3), np.float32)
I = np.concatenate(indices) if indices else np.zeros(0, np.uint32)
with open(OUT, "wb") as f:
    f.write(struct.pack("<I", P.shape[0]))
    f.write(P.tobytes())
    f.write(struct.pack("<I", I.shape[0]))
    f.write(I.tobytes())
meta = {
    "source": os.path.basename(SRC),
    "verts": int(P.shape[0]),
    "tris": int(I.shape[0] // 3),
    "bounds": {"min": P.min(axis=0).tolist(), "max": P.max(axis=0).tolist()},
    "nodes": stats,
}
json.dump(meta, open(OUT + ".json", "w"), indent=1)
print(f"{OUT}: {meta['verts']} verts, {meta['tris']} tris, bounds {meta['bounds']}")
