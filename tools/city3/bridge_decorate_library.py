"""Bridge: apply the bottle_spec decoration to the shipped library GLB.

WHY THIS EXISTS: the decoration's source of truth is the generator
(tools/city3/rooms.py + bottle_spec.py). A full generator run is impossible
in the sandbox — several asset inputs are gitignored downloads and the
BlendSwap pack behind the bottles is absent (connector key 401) — so this
bridge applies the SAME spec (imported from the repo) to the shipped
world-city3-library.glb. It is APPEND-ONLY: every original bufferView byte
is preserved verbatim; new geometry/textures are appended to the BIN chunk
as plain (uncompressed) bufferViews, and the JSON gains primitives,
materials, textures and images. Once a full build_city run lands the
generator version, this bridge is obsolete.

Usage: bridge_decorate_library.py <in.glb> <out.glb> <repo_tools_city3_dir>
Requires the meshopt-capable glTF decoder used by this workspace's audit
tooling (prop_audit.py): set PROP_AUDIT_DIR to its directory.
"""
import json, struct, sys
import numpy as np

import os
sys.path.insert(0, os.environ.get('PROP_AUDIT_DIR', '/home/hatch/tmp-pip'))  # prop_audit decoder
sys.path.insert(0, sys.argv[3])                    # bottle_spec
from prop_audit import load_glb, Dec
import bottle_spec as spec

SRC, DST = sys.argv[1], sys.argv[2]
g, buf = load_glb(SRC)
dec = Dec(g, buf)
gltf = json.loads(json.dumps(g))                   # deep copy via json

BASE = g['buffers'][0]['byteLength']
stream = bytearray()                               # bytes appended after BASE
new_bvs = []                                       # bufferView dicts, in order

def append_bin(data, align=4):
    """Append bytes to the new stream; returns the new bufferView index."""
    pad = (-(BASE + len(stream))) % align
    stream.extend(b'\x00' * pad)
    off = BASE + len(stream)
    stream.extend(data)
    new_bvs.append({"buffer": 0, "byteOffset": off, "byteLength": len(data)})
    return len(g['bufferViews']) + len(new_bvs) - 1

def add_accessor(arr, atype):
    bvi = append_bin(np.ascontiguousarray(arr, dtype='<f4').tobytes())
    acc = {"bufferView": bvi, "byteOffset": 0, "componentType": 5126,
           "count": len(arr), "type": atype}
    if atype == 'VEC3':
        acc["min"] = arr.reshape(-1, 3).min(0).tolist()
        acc["max"] = arr.reshape(-1, 3).max(0).tolist()
    gltf['accessors'].append(acc)
    return len(gltf['accessors']) - 1

def add_material(m):
    gltf['materials'].append(m)
    return len(gltf['materials']) - 1

def b2g(v):  # Blender (x,y,z) -> glTF (x,z,-y)
    return (v[0], v[2], -v[1])

# ---- measure profiles per shape from the shipped glass -------------------
profiles, heights = {}, {}
for n in gltf['nodes']:
    nm = n.get('name', '')
    if not nm.startswith('LIB_bottle_'):
        continue
    shape = int(nm[4:].split('_')[1])
    if shape in profiles:
        continue
    prim = gltf['meshes'][n['mesh']]['primitives'][0]
    pos = dec.acc(prim['attributes']['POSITION']).astype(float)
    pts = [(float(x), float(-z), float(y)) for (x, y, z) in pos]   # -> Blender space
    profiles[shape] = spec.profile_from_points(pts, step=0.01)
    heights[shape] = max(p[2] for p in pts)
print('profiles measured for shapes', sorted(profiles), 'heights', {k: round(v, 3) for k, v in heights.items()})

def soup(verts, faces, uvs=None):
    """Non-indexed triangle soup with flat normals, in glTF space."""
    P, N, U = [], [], []
    for f in faces:
        a, b, c = (np.array(b2g(verts[i]), float) for i in f)
        n = np.cross(b - a, c - a)
        ln = np.linalg.norm(n)
        n = n / ln if ln > 0 else np.array([0.0, 1.0, 0.0])
        for i, p in zip(f, (a, b, c)):
            P.append(p); N.append(n)
            if uvs is not None: U.append(uvs[i])
    return (np.array(P, dtype='<f4'), np.array(N, dtype='<f4'),
            np.array(U, dtype='<f4') if uvs is not None else None)

# ---- label textures + shared materials ------------------------------------
label_mat, liquid_mat = {}, {}
for fam in spec.FAMILIES:
    bvi = append_bin(spec.make_label_png(fam), align=1)
    gltf.setdefault('images', []).append({"bufferView": bvi, "mimeType": "image/png", "name": f"label_{fam}"})
    gltf.setdefault('textures', []).append({"source": len(gltf['images']) - 1, "name": f"label_{fam}"})
    label_mat[fam] = add_material({
        "name": f"label_{fam}",
        "pbrMetallicRoughness": {"baseColorTexture": {"index": len(gltf['textures']) - 1},
                                 "roughnessFactor": spec.LABEL_ROUGH, "metallicFactor": 0.0}})
    liquid_mat[fam] = add_material({
        "name": f"liquid_{fam}",
        "pbrMetallicRoughness": {"baseColorFactor": [*spec.FAMILIES[fam]["liquid"], 1.0],
                                 "roughnessFactor": spec.LIQUID_ROUGH, "metallicFactor": 0.0}})
cork_mat = add_material({
    "name": "cork",
    "pbrMetallicRoughness": {"baseColorFactor": [*spec.CORK_RGB, 1.0],
                             "roughnessFactor": spec.CORK_ROUGH, "metallicFactor": 0.0}})

# ---- per-variant parts ------------------------------------------------------
for n in gltf['nodes']:
    nm = n.get('name', '')
    if not nm.startswith('LIB_bottle_'):
        continue
    key = nm[4:]
    shape = int(key.split('_')[1])
    fam = key.split('_', 2)[2]
    prof = profiles[shape]
    mesh = gltf['meshes'][n['mesh']]
    gm = gltf['materials'][mesh['primitives'][0]['material']]
    gm['pbrMetallicRoughness']['baseColorFactor'][3] = spec.FAMILIES[fam]['glass_alpha']
    gm['alphaMode'] = 'BLEND'
    lv, lf = spec.liquid_geometry(prof, spec.fill_for(key, shape))
    P, N, _ = soup(lv, lf)
    mesh['primitives'].append({"attributes": {"POSITION": add_accessor(P, 'VEC3'),
                                              "NORMAL": add_accessor(N, 'VEC3')},
                               "material": liquid_mat[fam], "mode": 4})
    z0, z1 = spec.SHAPES[shape]['label']
    rband = max(r for (z, r) in prof if z0 - 0.01 <= z <= z1 + 0.01)
    gv, gf, guv = spec.label_geometry(rband, z0, z1)
    P, N, U = soup(gv, gf, guv)
    mesh['primitives'].append({"attributes": {"POSITION": add_accessor(P, 'VEC3'),
                                              "NORMAL": add_accessor(N, 'VEC3'),
                                              "TEXCOORD_0": add_accessor(U, 'VEC2')},
                               "material": label_mat[fam], "mode": 4})
    top = heights[shape]
    neck_r = min(r for (z, r) in prof if z >= top - 0.012 and r > 0.005)
    cv, cf = spec.cork_geometry(neck_r, top)
    P, N, _ = soup(cv, cf)
    mesh['primitives'].append({"attributes": {"POSITION": add_accessor(P, 'VEC3'),
                                              "NORMAL": add_accessor(N, 'VEC3')},
                               "material": cork_mat, "mode": 4})

gltf['bufferViews'] += new_bvs
gltf['buffers'][0]['byteLength'] = BASE + len(stream)

new_bin = bytes(buf) + bytes(stream)
json_bytes = json.dumps(gltf, separators=(',', ':')).encode()
json_bytes += b' ' * ((-len(json_bytes)) % 4)
out = b'glTF' + struct.pack('<II', 2, 12 + 8 + len(json_bytes) + 8 + len(new_bin))
out += struct.pack('<I', len(json_bytes)) + b'JSON' + json_bytes
out += struct.pack('<I', len(new_bin)) + b'BIN\x00' + new_bin
open(DST, 'wb').write(out)
print('wrote', DST, len(out), 'bytes; materials', len(gltf['materials']),
      'accessors', len(gltf['accessors']), 'bufferViews', len(gltf['bufferViews']),
      'images', len(gltf['images']))
