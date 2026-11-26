"""Minimal GLB reader shared by the City 3 world gates. Pure python + numpy.

No Blender, no glTF library: the shipped world GLBs require
EXT_meshopt_compression, so their POSITION buffers cannot be decoded without the
meshopt codec -- but every accessor still declares exact min/max, which is exact
for the mesh *in its own space*. What must not be skipped is the scene graph:
node translation/rotation/scale and parent chains, or a gate is blind to the
exact defect it exists for (a prop scaled 1.25 on its node still measures
life-size from raw accessor extents).

Axes: glTF is Y-up metres. The kit specs and layout JSONs here are Blender/three
space, so `to_blender` is the one conversion the dims gate needs.
"""
import json
import struct

import numpy as np

MAGIC = 0x46546C67  # "glTF"


class GLB:
    def __init__(self, path, doc, binchunk, size):
        self.path, self.doc, self.bin, self.size = path, doc, binchunk, size

    @property
    def nodes(self):
        return self.doc.get("nodes", [])

    @property
    def accessors(self):
        return self.doc.get("accessors", [])

    def node_index(self, name):
        for i, n in enumerate(self.nodes):
            if n.get("name") == name:
                return i
        return None

    def names(self, prefix=""):
        return [n.get("name") for n in self.nodes
                if n.get("name") and n["name"].startswith(prefix)]

    def requires(self):
        return self.doc.get("extensionsRequired", []) or []


def load(path):
    """Read a .glb, or a .gltf plus its sidecar .bin."""
    import os
    with open(path, "rb") as f:
        head = f.read(12)
        if len(head) < 12 or struct.unpack("<I", head[:4])[0] != MAGIC:
            with open(path) as g:
                doc = json.load(g)
            binchunk = b""
            uri = doc.get("buffers", [{}])[0].get("uri")
            if uri and not uri.startswith("data:"):
                with open(os.path.join(os.path.dirname(path), uri), "rb") as g:
                    binchunk = g.read()
            return GLB(path, doc, binchunk, os.path.getsize(path))
        _, version, length = struct.unpack("<III", head)
        if version != 2:
            raise ValueError(f"{path}: glTF version {version}, expected 2")
        doc, binchunk = None, b""
        while f.tell() < length:
            chunk_len, chunk_type = struct.unpack("<II", f.read(8))
            data = f.read(chunk_len)
            if chunk_type == 0x4E4F534A:      # JSON
                doc = json.loads(data)
            elif chunk_type == 0x004E4942:    # BIN
                binchunk = data
        if doc is None:
            raise ValueError(f"{path}: no JSON chunk")
        return GLB(path, doc, binchunk, length)


# ---------------------------------------------------------------- transforms
def local_matrix(node):
    """4x4 local transform: column-major `matrix`, else composed TRS."""
    if "matrix" in node:
        return np.array(node["matrix"], dtype=np.float64).reshape(4, 4).T
    m = np.eye(4)
    if "translation" in node:
        m[:3, 3] = node["translation"]
    if "rotation" in node:
        x, y, z, w = node["rotation"]
        m[:3, :3] = np.array([
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    if "scale" in node:
        m[:3, :3] = m[:3, :3] @ np.diag(node["scale"])
    return m


def world_matrices(doc):
    """Per-node world matrix from the default scene's roots. None = unreached."""
    nodes = doc.get("nodes", [])
    out = [None] * len(nodes)
    scene = doc.get("scene", 0)
    scenes = doc.get("scenes") or [{"nodes": list(range(len(nodes)))}]
    stack = [(r, np.eye(4)) for r in scenes[scene].get("nodes", [])]
    while stack:
        i, parent = stack.pop()
        if i >= len(nodes) or out[i] is not None:
            continue
        out[i] = parent @ local_matrix(nodes[i])
        for c in nodes[i].get("children", []):
            stack.append((c, out[i]))
    return out


# ---------------------------------------------------------------- bounds
def accessor_aabb(doc, acc_i):
    """(min, max) declared by an accessor, or None when it declares neither."""
    a = doc["accessors"][acc_i]
    if "min" not in a or "max" not in a:
        return None
    return np.array(a["min"], dtype=np.float64), np.array(a["max"], dtype=np.float64)


def mesh_aabb(doc, mesh_i):
    """Local-space AABB of a mesh: union of its primitives' POSITION min/max."""
    lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
    found = False
    for pr in doc["meshes"][mesh_i].get("primitives", []):
        pos = pr.get("attributes", {}).get("POSITION")
        box = accessor_aabb(doc, pos) if pos is not None else None
        if box is None:
            continue
        found = True
        lo, hi = np.minimum(lo, box[0]), np.maximum(hi, box[1])
    return (lo, hi) if found else None


def instance_span(doc, node):
    """EXT_mesh_gpu_instancing TRANSLATION min/max, if the node instances a mesh."""
    ext = (node.get("extensions") or {}).get("EXT_mesh_gpu_instancing")
    tr = (ext or {}).get("attributes", {}).get("TRANSLATION")
    return None if tr is None else accessor_aabb(doc, tr)


def subtree_bounds(doc, world, i, _seen=None):
    """World AABB of node i plus descendants. None when no mesh lives below.

    The mesh box comes from accessor min/max (exact, meshopt-safe); the node's own
    world matrix is applied to all eight corners, so a node scale, a rotated parent
    or a translated chain all move the number. Instance spreads are added per axis
    before the transform, which is the conservative bound for a gpu-instanced mesh.
    """
    seen = _seen if _seen is not None else set()
    if i in seen:
        return None
    seen.add(i)
    node = doc["nodes"][i]
    W = world[i] if world[i] is not None else np.eye(4)
    lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
    got = False
    box = mesh_aabb(doc, node["mesh"]) if "mesh" in node else None
    if box:
        a, b = box
        span = instance_span(doc, node)
        if span is not None:
            a, b = a + span[0], b + span[1]
        for x in (a[0], b[0]):
            for y in (a[1], b[1]):
                for z in (a[2], b[2]):
                    p = (W @ np.array([x, y, z, 1.0]))[:3]
                    lo, hi = np.minimum(lo, p), np.maximum(hi, p)
        got = True
    for c in node.get("children", []):
        sub = subtree_bounds(doc, world, c, seen)
        if sub is not None:
            lo, hi = np.minimum(lo, sub[0]), np.maximum(hi, sub[1])
            got = True
    return (lo, hi) if got else None


def scene_bounds(doc):
    world = world_matrices(doc)
    lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
    for i in range(len(doc.get("nodes", []))):
        b = subtree_bounds(doc, world, i)
        if b is not None:
            lo, hi = np.minimum(lo, b[0]), np.maximum(hi, b[1])
    if not np.isfinite(lo).all():
        return None
    return lo, hi


def to_blender(dims):
    """glTF Y-up [x, y, z] -> Blender Z-up [x, z, y]."""
    return [dims[0], dims[2], dims[1]]


# ---------------------------------------------------------------- images
def images(glb):
    """-> [(index, name, mime, bytes)] for bufferView, data-uri and file images."""
    doc, out = glb.doc, []
    for i, im in enumerate(doc.get("images", [])):
        mime = im.get("mimeType", "")
        data = b""
        if "bufferView" in im:
            bv = doc["bufferViews"][im["bufferView"]]
            start = bv.get("byteOffset", 0)
            data = glb.bin[start:start + bv["byteLength"]]
        elif im.get("uri", "").startswith("data:"):
            import base64
            head, _, payload = im["uri"].partition(",")
            mime = mime or head[5:].split(";")[0]
            data = base64.b64decode(payload)
        elif im.get("uri"):
            import os
            p = os.path.join(os.path.dirname(glb.path), im["uri"])
            if os.path.exists(p):
                with open(p, "rb") as f:
                    data = f.read()
        out.append((i, im.get("name", f"image_{i}"), mime, data))
    return out


# ---------------------------------------------------------------- animations
def animations(glb):
    """Per-clip structure with no keyframe decode.

    Duration/start come from each sampler-input accessor's declared min/max (every
    Blender export writes them), so this works on meshopt GLBs too. `orphans`
    counts channels whose target is not a joint of any skin -- the broken-bone
    class of defect; `constant` counts samplers with a zero-length time range.
    """
    doc = glb.doc
    acc = doc.get("accessors", [])
    joint_of = {j: k for k, sk in enumerate(doc.get("skins", []))
                for j in sk.get("joints", [])}
    out = []
    for a in doc.get("animations", []):
        targets, dur, start, orphans, constant = set(), 0.0, None, 0, 0
        for ch in a.get("channels", []):
            node = ch.get("target", {}).get("node")
            if node is None:
                continue
            targets.add(node)
            orphans += node not in joint_of
            s = a["samplers"][ch["sampler"]]
            inp = acc[s["input"]]
            mn = (inp.get("min") or [0.0])[0]
            mx = (inp.get("max") or [0.0])[0]
            start = mn if start is None else min(start, mn)
            dur = max(dur, mx)
            if mx - mn < 1e-6:
                constant += 1
        out.append(dict(name=a.get("name", ""), channels=len(a.get("channels", [])),
                        targets=len(targets),
                        joints=sum(1 for t in targets if t in joint_of),
                        start=round(start or 0.0, 4), duration=round(dur, 4),
                        samplers=len(a.get("samplers", [])), orphans=orphans,
                        constant=constant))
    return out

