#!/usr/bin/env python3
"""Build the real-tree kit: one small GLB per species in tools/city3/assets/trees/, ready for bridge_real_trees.py.

Input: Blender-normalised trees (trees_normalise.py: trunk base at the origin, y up, real height in metres).
Per species: base colour only (normal/ORM maps dropped), each texture resized to <= 512 px with power-of-two sides
(KTX2 sides not a multiple of 4 render black on S3TC GPUs, fix_npot_ktx2.py) and encoded KTX2 basis-lz with mipmaps.
A texture whose alpha channel cuts out (leaf and blossom cards) gets alphaMode MASK 0.5 + doubleSided, whatever the source
said: BLEND sorts badly in three.js and some sources tag cut-out leaves OPAQUE (maple_tree_54 rendered square cards).
Primitives sharing a material are merged. Writes <out>/<slug>.glb and <out>/manifest.json (height, crown, tris, credit).
  python3 tools/city3/trees_kit.py <normalised_dir> <sketchfab_manifest.json> [out_dir]
"""
import io
import json
import os
import struct
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from bridge_wave1 import Glb

MAX_TEX = 512
EXCLUDE = {"maple_tree_54": "leaf texture is RGB on a white background (no alpha): renders as square cards"}


def pot_floor(n):
    return 1 << max(2, int(n).bit_length() - 1)


def encode_ktx2(im):
    w, h = (min(MAX_TEX, pot_floor(s)) for s in im.size)
    im = im.convert("RGBA").resize((w, h), Image.LANCZOS)
    im.info.pop("icc_profile", None)   # ktx create refuses PNGs with an ICC profile
    with tempfile.TemporaryDirectory() as d:
        src, dst = os.path.join(d, "t.png"), os.path.join(d, "t.ktx2")
        im.save(src, icc_profile=None)
        subprocess.run(["ktx", "create", "--format", "R8G8B8A8_SRGB", "--encode", "basis-lz", "--generate-mipmap", "--assign-tf", "srgb",
                        "--assign-primaries", "bt709",
                        src, dst], check=True, capture_output=True)
        return open(dst, "rb").read(), (w, h)


def cuts_out(im):
    if im.mode not in ("RGBA", "LA", "P"):
        return False
    a = np.asarray(im.convert("RGBA"))[..., 3]
    return (a < 128).mean() > 0.02


def read_tree(path):
    glb = Glb(path); g = glb.gltf
    by_mat = {}

    def walk(i, m):
        n = g["nodes"][i]
        t = np.eye(4)
        if "matrix" in n:
            t = np.array(n["matrix"], float).reshape(4, 4).T
        else:
            if "scale" in n: t = np.diag([*n["scale"], 1.0]) @ t
            if "rotation" in n:
                x, y, z, w = n["rotation"]
                r = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                              [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                              [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
                q = np.eye(4); q[:3, :3] = r; t = q @ t
            if "translation" in n:
                q = np.eye(4); q[:3, 3] = n["translation"]; t = q @ t
        m = m @ t
        if "mesh" in n:
            for p in g["meshes"][n["mesh"]]["primitives"]:
                P = glb.acc_raw(p["attributes"]["POSITION"]).astype(float) @ m[:3, :3].T + m[:3, 3]
                N = glb.acc_raw(p["attributes"]["NORMAL"]).astype(float) @ np.linalg.inv(m[:3, :3])
                N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)
                U = glb.acc_raw(p["attributes"]["TEXCOORD_0"]).astype("<f4") if "TEXCOORD_0" in p["attributes"] else np.zeros((len(P), 2), "<f4")
                I = glb.indices_of(p).reshape(-1) if "indices" in p else np.arange(len(P))
                by_mat.setdefault(p.get("material"), []).append((P, N, U, I))
        for c in n.get("children", []):
            walk(c, m)

    for r in g["scenes"][g.get("scene", 0)]["nodes"]:
        walk(r, np.eye(4))
    return glb, by_mat


def image_of(glb, tex_index):
    g = glb.gltf; t = g["textures"][tex_index]
    im = g["images"][t.get("source", t.get("extensions", {}).get("KHR_texture_basisu", {}).get("source"))]
    bv = g["bufferViews"][im["bufferView"]]; o = bv.get("byteOffset", 0)
    return Image.open(io.BytesIO(bytes(glb.bin[o:o + bv["byteLength"]])))


def build(slug, src):
    glb, by_mat = read_tree(src); g = glb.gltf
    J = {"asset": {"version": "2.0", "generator": "trees_kit.py"}, "extensionsUsed": ["KHR_texture_basisu"],
         "extensionsRequired": ["KHR_texture_basisu"], "scenes": [{"nodes": [0]}], "scene": 0,
         "nodes": [{"name": slug, "mesh": 0}], "meshes": [{"name": "Tree_real_" + slug, "primitives": []}],
         "materials": [], "textures": [], "images": [], "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}],
         "accessors": [], "bufferViews": [], "buffers": [{"byteLength": 0}]}
    B = bytearray()

    def view(data, target=None):
        while len(B) % 4: B.append(0)
        J["bufferViews"].append({"buffer": 0, "byteOffset": len(B), "byteLength": len(data), **({"target": target} if target else {})})
        B.extend(data); return len(J["bufferViews"]) - 1

    def acc(a, typ, ctype, target, mm=False):
        a = np.ascontiguousarray(a)
        d = {"bufferView": view(a.tobytes(), target), "componentType": ctype, "count": len(a), "type": typ}
        if mm: d["min"], d["max"] = a.min(0).tolist(), a.max(0).tolist()
        J["accessors"].append(d); return len(J["accessors"]) - 1

    tris = 0; leaf_mats = 0; Pall = []
    for mi, parts in by_mat.items():
        P = np.concatenate([p[0] for p in parts]).astype("<f4"); N = np.concatenate([p[1] for p in parts]).astype("<f4")
        U = np.concatenate([p[2] for p in parts]).astype("<f4")
        base, I = 0, []
        for p in parts:
            I.append(p[3] + base); base += len(p[0])
        I = np.concatenate(I).astype("<u4").reshape(-1, 3)
        v = P[I]; area = 0.5 * np.linalg.norm(np.cross(v[:, 1] - v[:, 0], v[:, 2] - v[:, 0]), axis=1)
        I = I[area > 1e-9].ravel()   # zero-area source triangles fail the world's degenerate gate (bridge_drop_degenerate.AREA_MIN)
        tris += len(I) // 3; Pall.append(P)
        src_m = g["materials"][mi] if mi is not None else {}
        pbr = src_m.get("pbrMetallicRoughness", {})
        m = {"name": f"Tree_real_{slug}_{len(J['materials'])}", "pbrMetallicRoughness": {"metallicFactor": 0.0, "roughnessFactor": 0.9}}
        if "baseColorFactor" in pbr:
            m["pbrMetallicRoughness"]["baseColorFactor"] = pbr["baseColorFactor"]
        if "baseColorTexture" in pbr:
            im = image_of(glb, pbr["baseColorTexture"]["index"])
            leaf = cuts_out(im)
            data, _ = encode_ktx2(im)
            J["images"].append({"name": m["name"], "bufferView": view(data), "mimeType": "image/ktx2"})
            k = len(J["images"]) - 1
            J["textures"].append({"sampler": 0, "source": k, "extensions": {"KHR_texture_basisu": {"source": k}}})
            m["pbrMetallicRoughness"]["baseColorTexture"] = {"index": len(J["textures"]) - 1}
            if leaf:
                m["alphaMode"], m["alphaCutoff"], m["doubleSided"] = "MASK", 0.5, True; leaf_mats += 1
        J["materials"].append(m)
        J["meshes"][0]["primitives"].append({"attributes": {"POSITION": acc(P, "VEC3", 5126, 34962, True), "NORMAL": acc(N, "VEC3", 5126, 34962),
                                                            "TEXCOORD_0": acc(U, "VEC2", 5126, 34962)},
                                             "indices": acc(I, "SCALAR", 5125, 34963), "material": len(J["materials"]) - 1})
    while len(B) % 4: B.append(0)
    J["buffers"][0]["byteLength"] = len(B)
    P = np.concatenate(Pall)
    return J, bytes(B), {"tris": tris, "leaf_mats": leaf_mats, "H": round(float(P[:, 1].max()), 2),
                         "crown": round(float(max(np.ptp(P[:, 0]), np.ptp(P[:, 2]))), 2)}


def write_glb(path, J, B):
    js = json.dumps(J, separators=(",", ":")).encode(); js += b" " * ((4 - len(js) % 4) % 4)
    with open(path, "wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(js) + 8 + len(B)))
        f.write(struct.pack("<I4s", len(js), b"JSON")); f.write(js)
        f.write(struct.pack("<I4s", len(B), b"BIN\0")); f.write(B)


def main():
    src_dir, sf_manifest = sys.argv[1], sys.argv[2]
    out = sys.argv[3] if len(sys.argv) > 3 else os.path.join(HERE, "assets", "trees")
    os.makedirs(out, exist_ok=True)
    sf = json.load(open(sf_manifest)); man = {}
    for slug, credit in sorted(sf.items()):
        src = os.path.join(src_dir, slug + ".glb")
        if not os.path.exists(src) or slug in EXCLUDE:
            continue
        J, B, st = build(slug, src)
        write_glb(os.path.join(out, slug + ".glb"), J, B)
        assert Glb(os.path.join(out, slug + ".glb")).gltf["meshes"][0]["primitives"], slug   # round-trip read
        man[slug] = {**st, "kb": len(B) // 1024, "category": credit["cat"], "title": credit["name"], "author": credit["user"],
                     "license": credit["lic"], "url": f"https://sketchfab.com/3d-models/{credit['uid']}"}
        print(slug, json.dumps(man[slug]))
    json.dump(man, open(os.path.join(out, "manifest.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
