"""Bridge: apply the bottle girth correction to the shipped GLBs.

WHY THIS EXISTS: the girth fix's source of truth is the generator
(tools/city3/rooms.py build_bottles + bottle_spec.GIRTH, and goods.py's
FLASK profile for the bazaar trays). A full generator run is impossible in
the sandbox (gitignored asset inputs), so this bridge applies the SAME
factors to the shipped world-city3-library.glb and world-city3.glb. It is
APPEND-ONLY, like bridge_decorate_library.py and bridge_wave1.py: every
original bufferView byte is preserved verbatim (the old BIN is a byte-exact
prefix of the new BIN); squashed POSITION/NORMAL data is appended as plain
bufferViews and the bottle primitives are repointed at the new accessors.
Topology, indices, UVs, materials and placements are untouched — bottles
stand exactly where they stood, just slimmer.

Library mode: every primitive of every LIB_bottle_<shape>_<fam> mesh gets
its positions scaled radially (glTF XZ plane; Y is up) by
bottle_spec.girth_factor(shape), normals by the inverse-transpose.

City mode: the bazaar tray meshes g_bottles_* are merged clusters of six
lathe bottles on a lattice (centres x in {-0.12, 0, 0.12}, z in {-0.1, 0.1},
built by goods.py P_bottles from BOTTLE / BOTTLE2 / FLASK profiles).
Measured on the shipped meshes, BOTTLE is already Ø 76 mm and BOTTLE2
Ø 66 mm (real-world true, left alone); only FLASK clusters (belly
Ø 120 mm) are squashed, radially about their own centre axis, by
76/120 — the same wine-flask yardstick goods.py now carries.

Usage:
  bridge_girth.py library <in.glb> <out.glb> <repo_tools_city3_dir>
  bridge_girth.py city    <in.glb> <out.glb> <repo_tools_city3_dir>
Requires the meshopt-capable decoder in prop_audit.py (PROP_AUDIT_DIR).
"""
import json, struct, sys, os
import numpy as np

sys.path.insert(0, os.environ.get('PROP_AUDIT_DIR', '/home/hatch/tmp-pip'))
sys.path.insert(0, sys.argv[4])                    # bottle_spec
from prop_audit import load_glb, Dec
import bottle_spec as spec

MODE, SRC, DST = sys.argv[1], sys.argv[2], sys.argv[3]
FLASK_FACTOR = 76.0 / 120.0                        # city tray FLASK belly Ø 120 -> 76 mm
CENTRES = [(x, z) for z in (-0.1, 0.1) for x in (-0.12, 0.0, 0.12)]

g, buf = load_glb(SRC)
dec = Dec(g, buf)
gltf = json.loads(json.dumps(g))                   # deep copy via json

# The BIN chunk carries 0-3 zero padding bytes past buffers[0].byteLength
# (4-byte chunk alignment). Appends go after the FULL chunk, so offsets are
# based on len(buf); the declared byteLength becomes len(buf) + appends.
BASE = len(buf)
stream = bytearray()
new_bvs = []

def append_bin(data, align=4):
    pad = (-(BASE + len(stream))) % align
    stream.extend(b'\x00' * pad)
    off = BASE + len(stream)
    stream.extend(data)
    new_bvs.append({"buffer": 0, "byteOffset": off, "byteLength": len(data)})
    return len(g['bufferViews']) + len(new_bvs) - 1

def add_accessor(arr, atype):
    arr = np.ascontiguousarray(arr, dtype='<f4')
    bvi = append_bin(arr.tobytes())
    acc = {"bufferView": bvi, "byteOffset": 0, "componentType": 5126,
           "count": len(arr), "type": atype}
    if atype == 'VEC3':
        v = arr.reshape(-1, 3)
        acc["min"] = v.min(0).tolist()
        acc["max"] = v.max(0).tolist()
    gltf['accessors'].append(acc)
    return len(gltf['accessors']) - 1

def squash_attrs(prim, pos, nrm):
    """Repoint one primitive at appended squashed POSITION/NORMAL accessors.
    pos/nrm are float64 arrays in glTF space, already transformed."""
    prim['attributes']['POSITION'] = add_accessor(pos, 'VEC3')
    if nrm is not None:
        prim['attributes']['NORMAL'] = add_accessor(nrm, 'VEC3')

def radial(pos, nrm, f, centre=(0.0, 0.0)):
    """Scale XZ radially about (cx, cz); normals via inverse-transpose."""
    p = pos.copy()
    p[:, 0] = centre[0] + (p[:, 0] - centre[0]) * f
    p[:, 2] = centre[1] + (p[:, 2] - centre[1]) * f
    n = None
    if nrm is not None:
        n = nrm.copy()
        n[:, 0] /= f; n[:, 2] /= f
        ln = np.linalg.norm(n, axis=1, keepdims=True)
        n = n / np.where(ln > 0, ln, 1.0)
    return p, n

report = []

if MODE == 'library':
    done = set()
    for n in gltf['nodes']:
        nm = n.get('name', '')
        if not nm.startswith('LIB_bottle_'):
            continue
        shape = int(nm.split('_')[2])
        f = spec.girth_factor(shape)
        mi = n['mesh']
        if mi in done:
            continue
        done.add(mi)
        for prim in gltf['meshes'][mi]['primitives']:
            pos = dec.acc(prim['attributes']['POSITION']).astype(np.float64)
            nrm = dec.acc(prim['attributes']['NORMAL']).astype(np.float64) \
                if 'NORMAL' in prim['attributes'] else None
            p2, n2 = radial(pos, nrm, f)
            squash_attrs(prim, p2, n2)
        report.append(f"mesh {mi} {nm}: factor {f}")
    print(f"library: squashed {len(done)} bottle meshes")
elif MODE == 'city':
    hit = 0
    for mi, m in enumerate(gltf['meshes']):
        if not m.get('name', '').startswith('g_bottles'):
            continue
        for prim in m['primitives']:
            pos = dec.acc(prim['attributes']['POSITION']).astype(np.float64)
            nrm = dec.acc(prim['attributes']['NORMAL']).astype(np.float64) \
                if 'NORMAL' in prim['attributes'] else None
            p2 = pos.copy()
            n2 = nrm.copy() if nrm is not None else None
            for (cx, cz) in CENTRES:
                d = np.hypot(pos[:, 0] - cx, pos[:, 2] - cz)
                sel = (d < 0.065) & (pos[:, 1] > 0.025)
                if not sel.any():
                    continue
                belly = 2 * d[sel].max()
                if belly > 0.100:            # FLASK cluster (Ø 120 mm)
                    pp, nn = radial(pos[sel], nrm[sel] if nrm is not None else None,
                                    FLASK_FACTOR, centre=(cx, cz))
                    p2[sel] = pp
                    if n2 is not None:
                        n2[sel] = nn
                    hit += 1
                    report.append(f"{m['name']} cluster ({cx:+.2f},{cz:+.2f}): "
                                  f"belly Ø {belly*1000:.1f} -> {belly*FLASK_FACTOR*1000:.1f} mm")
            squash_attrs(prim, p2, n2)
    print(f"city: squashed {hit} FLASK clusters")
else:
    raise SystemExit(f"unknown mode {MODE}")

for r in report:
    print(" ", r)

gltf['bufferViews'] += new_bvs
gltf['buffers'][0]['byteLength'] = BASE + len(stream)

new_bin = bytes(buf) + bytes(stream)
json_bytes = json.dumps(gltf, separators=(',', ':')).encode()
json_bytes += b' ' * ((-len(json_bytes)) % 4)
out = b'glTF' + struct.pack('<II', 2, 12 + 8 + len(json_bytes) + 8 + len(new_bin))
out += struct.pack('<I', len(json_bytes)) + b'JSON' + json_bytes
out += struct.pack('<I', len(new_bin)) + b'BIN\x00' + new_bin
open(DST, 'wb').write(out)
print('wrote', DST, len(out), 'bytes; accessors', len(gltf['accessors']),
      'bufferViews', len(gltf['bufferViews']))
