#!/usr/bin/env python3
"""Append-only bridge: replace the lathe-goods family meshes in the shipped
City 3 GLBs with the phase-2 baked items (and the phase-1 hero goblet).

- world-city3.glb: inst_goods_{goblets,ewers,bowls,pots_terra,pots_blue,
  pots_green,pots_mixed,r_pot} meshes get new multi-primitive geometry built
  from the baked item GLBs, merged at the generator's placement data
  (goods.py P_goblets / P_ewer / P_stacks / P_pots specs; Blender space ->
  glTF (x, z, -y)). Instance transforms / nodes are NOT touched.
- world-city3-library.glb: LIB_brass_goblets' 3 primitives get hero-goblet
  geometry at the original props' centres (radially symmetric, so identity
  orientation is exact), sharing one hero material.

Same discipline as bridge_decorate_library.py: the original BIN chunk is
preserved byte-for-byte as a prefix; every original bufferView keeps its
offset/length; original accessors are untouched. Appended materials ship
FrontSide (the new forms are closed solids).

Usage: bridge_pottery_library.py <city_in.glb> <city_out.glb> \
           <library_in.glb> <library_out.glb> <items_dir> <hero_goblet.glb>
where <items_dir> holds the baked per-item GLBs from the phase-2 pipeline
(pottery_spec.ITEMS names) and <hero_goblet.glb> is the phase-1 game goblet.
"""
import json, struct, sys, os
import numpy as np

COMP = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16,
        5125: np.uint32, 5126: np.float32}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}

def align4(n):
    return (4 - n % 4) % 4

def read_glb(path):
    data = open(path, "rb").read()
    total = struct.unpack_from("<I", data, 8)[0]
    off = 12; gltf = None; binchunk = None
    while off < total:
        clen, ctype = struct.unpack_from("<II", data, off)
        chunk = data[off + 8: off + 8 + clen]
        if ctype == 0x4E4F534A: gltf = json.loads(chunk)
        elif ctype == 0x004E4942: binchunk = bytes(chunk)
        off += 8 + clen
    return gltf, binchunk, len(data)

def acc_array(gltf, binchunk, ai):
    a = gltf["accessors"][ai]
    bv = gltf["bufferViews"][a["bufferView"]]
    dt = COMP[a["componentType"]]; nc = NCOMP[a["type"]]
    stride = bv.get("byteStride", np.dtype(dt).itemsize * nc)
    start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    raw = np.frombuffer(binchunk, dtype=np.uint8, count=stride * a["count"], offset=start)
    arr = np.lib.stride_tricks.as_strided(raw.view(dt), shape=(a["count"], nc),
                                          strides=(stride, np.dtype(dt).itemsize))
    return np.array(arr)

class Appender:
    """Collects appended geometry + images; commit() writes them after the
    original BIN prefix and registers their bufferViews/images in the gltf."""
    def __init__(self, gltf):
        self.g = gltf
        self.blob = bytearray()
        self.images = []            # (payload, mimeType) in call order
        self.geo_view = None

    def add_geometry(self, pos, nrm, uv, idx):
        offs = {}
        for key, arr in (("POSITION", pos), ("NORMAL", nrm), ("TEXCOORD_0", uv), ("INDEX", idx)):
            self.blob += b"\x00" * align4(len(self.blob))
            offs[key] = (len(self.blob), arr)
            self.blob += arr.tobytes()
        return offs

    def add_image(self, payload, mime):
        final_index = len(self.g["images"]) + len(self.images)
        self.images.append((bytes(payload), mime))
        return final_index

    def commit(self, binchunk):
        g = self.g
        out_bin = bytearray(binchunk)
        out_bin += b"\x00" * align4(len(out_bin))
        geo_off = len(out_bin)
        out_bin += self.blob
        g["bufferViews"].append({"buffer": 0, "byteOffset": geo_off, "byteLength": len(self.blob)})
        self.geo_view = len(g["bufferViews"]) - 1
        for payload, mime in self.images:
            out_bin += b"\x00" * align4(len(out_bin))
            start = len(out_bin); out_bin += payload
            g["bufferViews"].append({"buffer": 0, "byteOffset": start, "byteLength": len(payload)})
            g["images"].append({"bufferView": len(g["bufferViews"]) - 1, "mimeType": mime})
        g["buffers"][0]["byteLength"] = len(out_bin)
        return bytes(out_bin)

class ItemCache:
    def __init__(self, gltf, app, items_dir, hero_path):
        self.g = gltf; self.app = app; self.mat_cache = {}; self.geo = {}
        self.items_dir = items_dir; self.hero_path = hero_path

    def load_geo(self, name):
        if name in self.geo: return self.geo[name]
        path = self.hero_path if name == "hero" else os.path.join(self.items_dir, name + ".glb")
        g, b, _ = read_glb(path)
        prim = g["meshes"][0]["primitives"][0]
        pos = acc_array(g, b, prim["attributes"]["POSITION"]).astype(np.float32)
        nrm = acc_array(g, b, prim["attributes"]["NORMAL"]).astype(np.float32)
        uv = acc_array(g, b, prim["attributes"]["TEXCOORD_0"]).astype(np.float32)
        idx = acc_array(g, b, prim["indices"]).reshape(-1).astype(np.uint32)
        self.geo[name] = (pos, nrm, uv, idx, g, b)
        return self.geo[name]

    def material_index(self, name):
        if name in self.mat_cache: return self.mat_cache[name]
        *_, g, b = self.load_geo(name)
        img_map = {}
        def map_texture(tex_idx):
            tex = g["textures"][tex_idx]
            si = tex["source"]
            if si not in img_map:
                sbv = g["bufferViews"][g["images"][si]["bufferView"]]
                s = sbv.get("byteOffset", 0)
                payload = b[s: s + sbv["byteLength"]]
                img_map[si] = self.app.add_image(payload, g["images"][si].get("mimeType", "image/png"))
            new_tex = {}
            if "sampler" in tex:
                self.g.setdefault("samplers", []).append(dict(g["samplers"][tex["sampler"]]))
                new_tex["sampler"] = len(self.g["samplers"]) - 1
            new_tex["source"] = img_map[si]
            self.g["textures"].append(new_tex)
            return len(self.g["textures"]) - 1
        mat = json.loads(json.dumps(g["materials"][0]))
        pbr = mat.get("pbrMetallicRoughness", {})
        for key in ("baseColorTexture", "metallicRoughnessTexture"):
            if key in pbr:
                pbr[key] = {"index": map_texture(pbr[key]["index"])}
        if "normalTexture" in mat:
            mat["normalTexture"] = {"index": map_texture(mat["normalTexture"]["index"])}
        mat["doubleSided"] = False   # closed solids ship FrontSide (phase-2 decision)
        self.g["materials"].append(mat)
        self.mat_cache[name] = len(self.g["materials"]) - 1
        return self.mat_cache[name]

def b2g(v):
    return np.stack([v[:, 0], v[:, 2], -v[:, 1]], axis=1).astype(np.float32)

def g2b(v):
    return np.stack([v[:, 0], -v[:, 2], v[:, 1]], axis=1).astype(np.float32)

def write_glb(path, gltf, binbytes):
    jb = json.dumps(gltf).encode(); jb += b" " * align4(len(jb))
    total = 12 + 8 + len(jb) + 8 + len(binbytes)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(jb), 0x4E4F534A)); f.write(jb)
        f.write(struct.pack("<II", len(binbytes), 0x004E4942)); f.write(binbytes)
    return total

# (item, scale, (x, y, z) blender) in generator build order
GROUPS = {
    "inst_goods_goblets": [("hero", 0.16 / 0.18, (-0.2, 0.0, 0.0)),
                            ("hero", 0.192 / 0.18, (0.0, 0.05, 0.0)),
                            ("hero", 0.16 / 0.18, (0.2, -0.02, 0.0))],
    "inst_goods_ewers": [("ewer_brass", 1.0, (-0.2, 0.0, 0.0)),
                          ("ewer_copper", 0.8, (0.0, 0.0, 0.0)),
                          ("ewer_brass", 1.15, (0.2, 0.0, 0.0))],
    "inst_goods_bowls": [("bowl_terra", 1.0, (-0.2, 0.0, 0.0)),
                          ("bowl_terra", 1.0, (-0.2, 0.0, 0.05)),
                          ("bowl_terra", 1.0, (-0.2, 0.0, 0.10)),
                          ("bowl_ochre", 1.0, (0.18, 0.0, 0.0)),
                          ("bowl_ochre", 1.0, (0.18, 0.0, 0.05)),
                          ("bowl_ochre", 1.0, (0.18, 0.0, 0.10)),
                          ("bowl_ochre", 1.0, (0.18, 0.0, 0.15))],
    "inst_goods_pots_terra": [("pot_jug_terra", 1.0, (-0.2, 0.0, 0.0)),
                               ("pot_amphora_terra", 0.85, (0.0, 0.02, 0.0)),
                               ("pot_vase_brick", 1.0, (0.2, 0.0, 0.0)),
                               ("pot_pitcher_terra", 0.9, (-0.05, -0.18, 0.0))],
    "inst_goods_pots_blue": [("pot_vase_blue", 1.0, (-0.2, 0.0, 0.0)),
                              ("pot_jug_blue", 1.0, (0.0, 0.0, 0.0)),
                              ("pot_bowl_blue", 1.0, (0.22, 0.02, 0.0)),
                              ("pot_pitcher_cream", 0.9, (-0.06, -0.19, 0.0))],
    "inst_goods_pots_green": [("pot_amphora_green", 0.8, (-0.18, 0.0, 0.0)),
                               ("pot_urn_green", 0.8, (0.05, 0.0, 0.0)),
                               ("pot_jug_cream", 0.9, (0.24, 0.02, 0.0))],
    "inst_goods_pots_mixed": [("pot_jug_ochre", 1.0, (-0.25, 0.0, 0.0)),
                               ("pot_vase_blue", 0.95, (-0.02, 0.0, 0.0)),
                               ("pot_urn_terra", 0.75, (0.22, 0.02, 0.0)),
                               ("pot_bowl_green", 0.9, (-0.1, -0.2, 0.0))],
    "inst_goods_r_pot": [("rpot_terra", 1.0, (0.0, 0.0, 0.0))],
}
LIB_CENTERS = [(-0.007, 0.0, 0.073), (-0.156, 0.0, -0.077), (0.1525, 0.0, -0.0745)]
LIB_SCALE = 1.511

def finish_prims(gltf, app, pending):
    geo_view = app.geo_view
    for mesh_i, prims in pending:
        new_prims = []
        for offs, mi, pg in prims:
            attrs = {}
            for key, ty in (("POSITION", "VEC3"), ("NORMAL", "VEC3"), ("TEXCOORD_0", "VEC2")):
                off, arr = offs[key]
                a = {"bufferView": geo_view, "byteOffset": off, "componentType": 5126,
                     "count": len(arr), "type": ty}
                if key == "POSITION":
                    a["min"] = [float(x) for x in pg.min(axis=0)]
                    a["max"] = [float(x) for x in pg.max(axis=0)]
                gltf["accessors"].append(a); attrs[key] = len(gltf["accessors"]) - 1
            off, arr = offs["INDEX"]
            gltf["accessors"].append({"bufferView": geo_view, "byteOffset": off,
                                      "componentType": 5125, "count": len(arr), "type": "SCALAR"})
            new_prims.append({"attributes": attrs, "indices": len(gltf["accessors"]) - 1,
                              "material": mi})
        gltf["meshes"][mesh_i]["primitives"] = new_prims

def bridge_file(in_path, out_path, kind, items_dir, hero_path):
    gltf, binchunk, in_size = read_glb(in_path)
    keys = ("meshes", "materials", "textures", "images", "accessors", "bufferViews", "nodes")
    orig_counts = {k: len(gltf.get(k, [])) for k in keys}
    app = Appender(gltf)
    cache = ItemCache(gltf, app, items_dir, hero_path)
    pending = []
    def uploaded_glass(mesh_i):
        return any(gltf['materials'][p['material']].get('name') == 'Drinkware_Clear_Glass'
                   for p in gltf['meshes'][mesh_i]['primitives'] if 'material' in p)
    if kind == "city":
        name2mesh = {n["name"]: n["mesh"] for n in gltf["nodes"]
                     if "mesh" in n and n.get("name") in GROUPS}
        assert set(name2mesh) == set(GROUPS), f"missing: {set(GROUPS) - set(name2mesh)}"
        for gname, layout in GROUPS.items():
            if gname == 'inst_goods_goblets' and uploaded_glass(name2mesh[gname]):
                continue  # Preserve the later user-supplied glass replacement.
            prims = []
            for item, s, t in layout:
                pos, nrm, uv, idx, *_ = cache.load_geo(item)
                pg = b2g(g2b(pos) * s + np.array(t, dtype=np.float32))
                offs = app.add_geometry(pg, nrm, uv, idx)
                prims.append((offs, cache.material_index(item), pg))
            pending.append((name2mesh[gname], prims))
    else:
        mesh_i = next(n["mesh"] for n in gltf["nodes"] if n.get("name") == "LIB_brass_goblets")
        if uploaded_glass(mesh_i):
            out_size = write_glb(out_path, gltf, binchunk)
            return {'file':os.path.basename(in_path), 'in_bytes':in_size, 'out_bytes':out_size,
                    'preserved_uploaded_glass':True, 'bin_prefix_preserved':True}
        prims = []
        for c in LIB_CENTERS:
            pos, nrm, uv, idx, *_ = cache.load_geo("hero")
            pg = pos * LIB_SCALE + np.array(c, dtype=np.float32)
            offs = app.add_geometry(pg, nrm, uv, idx)
            prims.append((offs, cache.material_index("hero"), pg))
        pending.append((mesh_i, prims))
    out_bin = app.commit(binchunk)
    finish_prims(gltf, app, pending)
    out_size = write_glb(out_path, gltf, out_bin)
    return {"file": os.path.basename(in_path), "in_bytes": in_size, "out_bytes": out_size,
            "orig_counts": orig_counts,
            "new_counts": {k: len(gltf.get(k, [])) for k in keys},
            "bin_prefix_preserved": out_bin[:len(binchunk)] == binchunk}

def main():
    city_in, city_out, lib_in, lib_out, items_dir, hero_path = sys.argv[1:7]
    rep = [bridge_file(city_in, city_out, "city", items_dir, hero_path),
           bridge_file(lib_in, lib_out, "library", items_dir, hero_path)]
    print(json.dumps(rep, indent=1))

if __name__ == "__main__":
    main()
