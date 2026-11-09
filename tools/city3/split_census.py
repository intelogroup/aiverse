"""Decoded spatial census of the shipped world GLBs (tools/city3/split_census.py).

For each GLB: decode POSITION accessors (meshopt-aware), compute every mesh
node's world-space bbox, bucket by district bounds (bazaar frame == world
frame; other district GLBs are local to their centre, offset applied).
Reports: node counts, decoded vertex/index bytes, bbox-centroid bucket,
straddlers (bbox intersects >1 district rect or escapes its own rect).
"""
import json, struct, sys
import numpy as np
import meshoptimizer as mo
from collections import defaultdict

DISTRICTS = {  # id: (cx, cz, half)
    "bazaar": (0, 0, 180), "glassq": (0, -400, 180), "foundry": (400, 0, 180),
    "terraces": (-400, 0, 180), "halo": (0, 400, 180),
}

def load(p):
    d = open(p, "rb").read()
    assert d[:4] == b"glTF", p
    n = struct.unpack("<I", d[12:16])[0]
    j = json.loads(d[20:20 + n])
    off = 20 + n
    bl = struct.unpack("<I", d[off:off + 4])[0]
    return j, d[off + 8:off + 8 + bl], len(d)

CTYPE = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2), 5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}
NP = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}

class GLB:
    def __init__(self, path):
        self.j, self.BIN, self.filebytes = load(path)
        self._views = {}
        self._acc = {}

    def view(self, bvi):
        if bvi in self._views:
            return self._views[bvi]
        bv = self.j["bufferViews"][bvi]
        ext = bv.get("extensions", {}).get("EXT_meshopt_compression")
        if not ext:
            out = np.frombuffer(self.BIN[bv.get("byteOffset", 0): bv.get("byteOffset", 0) + bv["byteLength"]], dtype=np.uint8).copy()
        else:
            src = self.BIN[ext["byteOffset"]: ext["byteOffset"] + ext["byteLength"]]
            if ext["mode"] == "ATTRIBUTES":
                raw = mo.decode_vertex_buffer(ext["count"], ext["byteStride"], src)
                filt = ext.get("filter")
                if filt == "EXPONENTIAL":
                    raw = mo.decode_filter_exp(raw, ext["count"], ext["byteStride"])
                elif filt == "OCTAHEDRAL":
                    raw = mo.decode_filter_oct(raw, ext["count"], ext["byteStride"])
                elif filt == "QUATERNION":
                    raw = mo.decode_filter_quat(raw, ext["count"], ext["byteStride"])
                out = np.frombuffer(raw, dtype=np.uint8).copy()
            elif ext["mode"] == "TRIANGLES":
                out = np.frombuffer(mo.decode_index_buffer(ext["count"], ext["byteStride"], src), dtype=np.uint8).copy()
            else:  # INDICES (quantized index sequence)
                out = np.frombuffer(mo.decode_index_sequence(ext["count"], ext["byteStride"], src), dtype=np.uint8).copy()
        self._views[bvi] = out
        return out

    def accessor(self, ai):
        if ai in self._acc:
            return self._acc[ai]
        a = self.j["accessors"][ai]
        bv = self.j["bufferViews"][a["bufferView"]]
        raw = self.view(a["bufferView"])
        fmt, sz = CTYPE[a["componentType"]]
        nc = NCOMP[a["type"]]
        stride = bv.get("byteStride")
        esz = sz * nc
        start = a.get("byteOffset", 0)
        cnt = a["count"]
        if stride and stride != esz:
            out = np.empty(cnt * esz, dtype=np.uint8)
            for k in range(cnt):
                out[k * esz:(k + 1) * esz] = raw[start + k * stride: start + k * stride + esz]
            raw = out
        else:
            raw = raw[start: start + esz * cnt]
        arr = np.frombuffer(raw, dtype=NP[a["componentType"]]).reshape(cnt, nc) if nc > 1 else np.frombuffer(raw, dtype=NP[a["componentType"]])
        self._acc[ai] = arr
        return arr

def node_world_matrices(j):
    """Return {node_index: 4x4 world matrix} walking scene roots."""
    mats = {}
    def local(n):
        if "matrix" in n:
            return np.array(n["matrix"], dtype=np.float64).reshape(4, 4).T
        t = np.array(n.get("translation", [0, 0, 0]), dtype=np.float64)
        r = n.get("rotation", [0, 0, 0, 1])
        s = np.array(n.get("scale", [1, 1, 1]), dtype=np.float64)
        x, y, z, w = r
        R = np.array([
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ], dtype=np.float64)
        M = np.eye(4)
        M[:3, :3] = R * s  # column scaling == R @ diag(s)
        M[:3, 3] = t
        return M
    def walk(ni, parent):
        n = j["nodes"][ni]
        M = parent @ local(n)
        mats[ni] = M
        for c in n.get("children", []):
            walk(c, M)
    scenes = j.get("scenes", [{}])
    roots = scenes[j.get("scene", 0)].get("nodes", []) if scenes else []
    for r in roots:
        walk(r, np.eye(4))
    return mats

def rects_hit(bmin, bmax):
    hits = []
    for did, (cx, cz, h) in DISTRICTS.items():
        if bmax[0] >= cx - h and bmin[0] <= cx + h and bmax[2] >= cz - h and bmin[2] <= cz + h:
            hits.append(did)
    return hits

def bucket_of_point(x, z):
    for did, (cx, cz, h) in DISTRICTS.items():
        if abs(x - cx) <= h and abs(z - cz) <= h:
            return did
    return "gap"

def census(path, frame_offset=(0, 0), home=None):
    g = GLB(path)
    j = g.j
    mats = node_world_matrices(j)
    ox, oz = frame_offset
    rows = []
    tot_vbytes = 0
    for ni, n in enumerate(j.get("nodes", [])):
        if "mesh" not in n:
            continue
        mesh = j["meshes"][n["mesh"]]
        M = mats.get(ni)
        if M is None:  # node not reachable from scene roots: use its local transform
            M = np.eye(4)
        bmin = np.array([np.inf] * 3); bmax = np.array([-np.inf] * 3)
        vb = ib = 0
        for prim in mesh["primitives"]:
            pos = g.accessor(prim["attributes"]["POSITION"])
            lo = pos.min(axis=0).astype(np.float64); hi = pos.max(axis=0).astype(np.float64)
            corners = np.array([[x, y, z, 1.0] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
            w = corners @ M.T
            bmin = np.minimum(bmin, w[:, :3].min(axis=0)); bmax = np.maximum(bmax, w[:, :3].max(axis=0))
            vb += sum(g.accessor(ai).nbytes for ai in prim["attributes"].values())
            if "indices" in prim:
                ib += g.accessor(prim["indices"]).nbytes
        bmin[0] += ox; bmax[0] += ox; bmin[2] += oz; bmax[2] += oz
        cen = (bmin + bmax) / 2
        rows.append({
            "node": n.get("name", f"node{ni}"), "mesh": mesh.get("name", ""),
            "bucket": bucket_of_point(cen[0], cen[2]), "hits": rects_hit(bmin, bmax),
            "cen": [round(float(cen[0]), 1), round(float(cen[2]), 1)],
            "span": [round(float(bmax[0] - bmin[0]), 1), round(float(bmax[2] - bmin[2]), 1)],
            "vbytes": vb, "ibytes": ib,
        })
        tot_vbytes += vb + ib
    print(f"\n===== {path}  file={g.filebytes:,} B  mesh-nodes={len(rows)}  decoded-attr-bytes={tot_vbytes:,}")
    by = defaultdict(lambda: [0, 0])
    for r in rows:
        by[r["bucket"]][0] += 1
        by[r["bucket"]][1] += r["vbytes"] + r["ibytes"]
    for b in sorted(by):
        print(f"  bucket {b:9s} nodes={by[b][0]:4d} decoded={by[b][1]:>13,} B")
    strad = [r for r in rows if len(r["hits"]) != 1 or (r["hits"] and r["hits"][0] != r["bucket"])]
    print(f"  straddlers (bbox hits != exactly its centroid bucket): {len(strad)}")
    for r in sorted(strad, key=lambda r: -(r["vbytes"] + r["ibytes"]))[:25]:
        print(f"    {r['node'][:44]:44s} mesh={r['mesh'][:30]:30s} cen={r['cen']} span={r['span']} hits={r['hits']} dec={r['vbytes'] + r['ibytes']:,}")
    if home:
        outside = [r for r in rows if r["bucket"] != home]
        print(f"  nodes whose centroid is OUTSIDE home district '{home}': {len(outside)}")
        for r in sorted(outside, key=lambda r: -(r["vbytes"] + r["ibytes"]))[:25]:
            print(f"    {r['node'][:44]:44s} cen={r['cen']} bucket={r['bucket']} span={r['span']} dec={r['vbytes'] + r['ibytes']:,}")
    return rows

if __name__ == "__main__":
    A = "apps/console/public/assets/"  # run from the repo root
    census(A + "world-city3.glb", (0, 0), home="bazaar")
    census(A + "world-city3-collision.glb", (0, 0), home="bazaar")
    census(A + "world-glassq.glb", (0, -400), home="glassq")
    census(A + "world-halo.glb", (0, 400), home="halo")
    census(A + "world-links.glb", (0, 0))
