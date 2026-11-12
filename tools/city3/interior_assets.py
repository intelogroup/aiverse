#!/usr/bin/env python3
"""Loaders for the free (CC0) furniture sources used by bridge_bazaar_interiors.py. Returns primitives as numpy arrays:
  {"P": (n,3) f4, "N": (n,3) f4, "U": (n,2) f4, "I": (m,) u4, "mat": name, "color": (r,g,b) or None, "tex": trim name or None}
Sources (all CC0, see assets/bazaar-interiors/sources.json):
  kenney   Kenney Furniture Kit (OBJ + MTL flat colours)          https://kenney.nl/assets/furniture-kit
  qfurn    Quaternius Furniture Pack (OBJ + MTL flat colours)     https://opengameart.org/content/furniture-low-poly
  qfantasy Quaternius Fantasy Props MegaKit (glTF, 3 trim sheets) https://quaternius.com/packs/fantasypropsmegakit.html
  tea      Poly Haven props already in assets/tea-props (decimated GLB + JPEG colour/normal)
"""
import json, os, sys
sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
import numpy as np


def _mtl(path):
    out, cur = {}, None
    if not os.path.exists(path): return out
    for ln in open(path, errors="ignore"):
        w = ln.split()
        if not w: continue
        if w[0] == "newmtl": cur = w[1]; out[cur] = (0.8, 0.8, 0.8)
        elif w[0] == "Kd" and cur: out[cur] = tuple(float(v) for v in w[1:4])
    return out


def load_obj(path):
    """OBJ with usemtl groups -> one primitive per material, fan-triangulated, de-indexed (smooth normals from file if present)."""
    v, vn, vt = [], [], []; mats = _mtl(os.path.splitext(path)[0] + ".mtl"); cur = "default"; faces = {}
    for ln in open(path, errors="ignore"):
        w = ln.split()
        if not w: continue
        if w[0] == "v": v.append([float(x) for x in w[1:4]])
        elif w[0] == "vn": vn.append([float(x) for x in w[1:4]])
        elif w[0] == "vt": vt.append([float(x) for x in w[1:3]])
        elif w[0] == "usemtl": cur = w[1]
        elif w[0] == "f":
            idx = []
            for t in w[1:]:
                a = (t.split("/") + ["", ""])[:3]
                idx.append((int(a[0]) - 1, int(a[1]) - 1 if a[1] else -1, int(a[2]) - 1 if a[2] else -1))
            for k in range(1, len(idx) - 1): faces.setdefault(cur, []).extend([idx[0], idx[k], idx[k + 1]])
    v = np.array(v, "f4"); vn = np.array(vn, "f4") if vn else None; vt = np.array(vt, "f4") if vt else None; prims = []
    for m, f in faces.items():
        f = np.array(f); P = v[f[:, 0]]
        if vn is not None and (f[:, 2] >= 0).all(): N = vn[f[:, 2]]
        else:
            t = P.reshape(-1, 3, 3); fn = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]); fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-9); N = np.repeat(fn, 3, 0)
        U = vt[f[:, 1]] if vt is not None and (f[:, 1] >= 0).all() else np.zeros((len(P), 2), "f4")
        prims.append({"P": P, "N": N.astype("f4"), "U": U.astype("f4"), "I": np.arange(len(P), dtype="<u4"), "mat": m, "color": mats.get(m, (0.8, 0.8, 0.8)), "tex": None})
    return prims


def load_gltf(path):
    """Quaternius glTF (separate .bin, trim-sheet materials MI_Trim_*): flattens node transforms is not needed (props are single-node)."""
    j = json.load(open(path)); base = os.path.dirname(path); bufs = [open(os.path.join(base, b["uri"]), "rb").read() for b in j["buffers"]]
    def acc(i):
        a = j["accessors"][i]; bv = j["bufferViews"][a["bufferView"]]; n = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
        dt = {5126: "<f4", 5123: "<u2", 5125: "<u4", 5121: "u1"}[a["componentType"]]
        off = bv.get("byteOffset", 0) + a.get("byteOffset", 0); stride = bv.get("byteStride")
        if stride and stride != n * np.dtype(dt).itemsize:
            raw = np.frombuffer(bufs[bv["buffer"]], np.uint8, count=a["count"] * stride, offset=off).reshape(a["count"], stride)
            return raw[:, :n * np.dtype(dt).itemsize].copy().view(dt).reshape(a["count"], n)
        return np.frombuffer(bufs[bv["buffer"]], dt, count=a["count"] * n, offset=off).reshape(a["count"], n)
    prims = []
    for node in j["nodes"]:
        if "mesh" not in node: continue
        for p in j["meshes"][node["mesh"]]["primitives"]:
            at = p["attributes"]; mat = j["materials"][p["material"]]
            prims.append({"P": acc(at["POSITION"]).astype("f4"), "N": acc(at["NORMAL"]).astype("f4"), "U": acc(at["TEXCOORD_0"]).astype("f4") if "TEXCOORD_0" in at else np.zeros((len(acc(at["POSITION"])), 2), "f4"),
                          "I": acc(p["indices"]).astype("<u4").ravel(), "mat": mat["name"], "color": None, "tex": mat["name"].replace("MI_", "")})
    return prims


def bbox(prims):
    P = np.concatenate([p["P"] for p in prims]); return P.min(0), P.max(0)


if __name__ == "__main__":
    D = sys.argv[1]
    for name, fn, path in [("kenney bedDouble", load_obj, "kenney/x/Models/bedDouble.obj")]:
        pr = fn(os.path.join(D, path)); print(name, bbox(pr))
