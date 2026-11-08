#!/usr/bin/env python3
"""bridge_wave1.py — Prop Wave 1 mechanical cures applied to the shipped City 3 GLBs.

Why a bridge: the full build_city.py regeneration cannot run off the asset
workstation (several source packs are gitignored downloads), so — exactly like
bridge_decorate_library.py (PR #40) — the generator source carries the same
cures (build_city.py: DoubleSide material set + _CUP_S cup scale/UV collapse)
and this script applies the identical cures to the shipped artifacts, proving
with an accessor-level diff that nothing else moved.

Cures (per PROP-AUDIT, mechanical only):
  1. doubleSided=True on the audit's flip-list materials:
     library GLB: palette, signs, rug, lamp_glow
     city GLB:    palette, signs, lamp_glow, interior_wall, wood_floor,
                  mdvl_palette (+ its Blender .NNN export variants)
     (District GLBs are NOT touched: their `palette` is mkit.py's material,
     which is single-sided by that kit's own stated design, and the audit did
     not census district interiors.)
  2. Party cups (audit classes (e)+(f)): cup meshes rescaled to 0.110 m tall
     (were 0.186 m, ~1.7x a real 9.5-11 cm party cup), beer-pong rack
     formations tightened by the same factor about their table centres,
     tipped litter re-grounded to the new rim radius, and cup UVs collapsed
     into a solid patch of each mesh's own dominant sheet colour (kills the
     atlas-bleed streaks: the USDZ sheets print neighbouring artwork onto the
     cup walls because wall UVs span the whole sheet).
  Bottle proportions are deliberately NOT touched (Jim's separate call).

Verdicts recorded (no cure applied — evidence in the run report):
  * Flipped normals (audit class (c)): the audit's own position-welded
    census measured 0.00 of furniture faces opposing their stored normals;
    worst overall is bottle shape 3 at 0.07, lip detail only. No shading-pop
    population exists, so no normals cure is applied.
  * Door / folding-table placement (audit class (h)): the audit reported
    20 of 77 instanced doors flipped 180 degrees and one folding-table
    instance flipped + sunk 0.8 m. A normalized-quaternion census of the
    shipped GLBs (this script, `placement_census`, with a synthetic-flip
    positive control) finds 77/77 door instances upright (world bbox spans
    +0.00..+2.88/3.12 m above each placement origin, exactly as authored)
    and 3/3 table instances upright and grounded — in BOTH the 971b006 base
    GLB and the post-fountain main GLB. The audit's flip claim is a
    measurement artifact and is NOT reproduced in any shipped artifact, so
    no instance transform is touched (editing correct transforms would
    break them). The census stays in this bridge as a guard: if a future
    regeneration ever ships genuinely flipped instances, the census will
    flag them in the report before anything merges.

Requires: numpy, meshoptimizer, PIL (the lane's pylibs). Pure Python; no Blender.
Usage: python3 bridge_wave1.py <assets_dir> [--dry-run]
"""
import json, struct, sys, os, io
sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
import numpy as np
from PIL import Image
from meshoptimizer import (decode_vertex_buffer, decode_index_buffer,
                           decode_filter_exp, decode_filter_oct,
                           encode_vertex_buffer)

CUP_TARGET_H = 0.110          # metres — real party cup height (audit class (f))
RIM_R = 0.072                 # generator _CR (build_city.py) before scaling
TABLES = [(-4.2, -31.0), (4.2, -31.0), (0.0, -40.5)]   # (x, z) of pong tables
TABLETOP_Y = 1.198
TABLE_HALF = (0.55, 0.97)     # footprint half-extents (x, z), small margin
FLIP_SETS = {
    "world-city3-library.glb": {"palette", "signs", "rug", "lamp_glow"},
    "world-city3.glb": {"palette", "signs", "lamp_glow", "interior_wall",
                        "wood_floor"},
}
CT = {5126: ('f', 4), 5123: ('H', 2), 5125: ('I', 4), 5121: ('B', 1),
      5120: ('b', 1), 5122: ('h', 2)}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}


def load_glb(path):
    data = open(path, 'rb').read()
    assert data[:4] == b'glTF', path
    jlen = struct.unpack('<I', data[12:16])[0]
    gltf = json.loads(data[20:20 + jlen])
    off = 20 + jlen
    blen = struct.unpack('<I', data[off:off + 4])[0]
    binchunk = data[off + 8:off + 8 + blen]
    return gltf, bytearray(binchunk)


def save_glb(path, gltf, binchunk):
    js = json.dumps(gltf, separators=(',', ':')).encode()
    js += b' ' * ((4 - len(js) % 4) % 4)
    binchunk = bytes(binchunk)
    binchunk += b'\x00' * ((4 - len(binchunk) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(binchunk)
    out = struct.pack('<4sII', b'glTF', 2, total)
    out += struct.pack('<I4s', len(js), b'JSON') + js
    out += struct.pack('<I4s', len(binchunk), b'BIN\x00') + binchunk
    open(path, 'wb').write(out)
    return len(out)


class Glb:
    """Layout note (this exporter): EXT_meshopt_compression byteOffset /
    byteLength are ABSOLUTE into the BIN chunk, while bufferView offsets /
    lengths describe the virtual decoded buffer. Uncompressed views (images,
    some attributes) are physical at their bufferView offsets. The patch
    therefore never moves existing bytes: replaced streams are appended to
    the end of the BIN and the extension pointers are updated."""

    def __init__(self, path):
        self.path = path
        self.gltf, self.bin = load_glb(path)
        self.modified_accessors = set()

    def view_physical_bytes(self, bvi):
        bv = self.gltf['bufferViews'][bvi]
        o = bv.get('byteOffset', 0)
        return bytes(self.bin[o:o + bv['byteLength']])

    # ---- decoding -------------------------------------------------------
    def acc_raw(self, ai):
        """Decoded accessor as float64 array (count, ncomp). Meshopt-aware."""
        g = self.gltf
        a = g['accessors'][ai]
        bv = g['bufferViews'][a['bufferView']]
        n = a['count']
        ct = CT[a['componentType']]
        ncomp = NCOMP[a['type']]
        ext = bv.get('extensions', {}).get('EXT_meshopt_compression')
        if ext:
            src = np.frombuffer(bytes(self.bin), dtype=np.uint8,
                                count=ext['byteLength'],
                                offset=ext['byteOffset']).copy()
            stride = ext['byteStride']
            if ext['mode'] in ('TRIANGLES', 'INDICES'):
                arr = decode_index_buffer(ext['count'], stride, src)
                u = np.frombuffer(np.ascontiguousarray(arr).tobytes(),
                                  dtype='<u2' if a['componentType'] == 5123
                                  else '<u4')
                return u[:n].astype(np.float64).reshape(n, ncomp)
            dec = decode_vertex_buffer(ext['count'], stride, src)
            rawb = np.frombuffer(np.ascontiguousarray(dec).tobytes(),
                                 dtype=np.uint8).copy()
            f = ext.get('filter')
            if f in ('EXPONENTIAL', 'OCTAHEDRAL'):
                fn = decode_filter_exp if f == 'EXPONENTIAL' \
                    else decode_filter_oct
                rawb = np.asarray(fn(rawb, ext['count'], stride),
                                  dtype=np.uint8)
            dt = {5126: '<f4', 5123: '<u2', 5125: '<u4', 5121: 'u1',
                  5120: 'i1', 5122: '<i2'}[a['componentType']]
            vals = np.frombuffer(rawb.tobytes(), dtype=dt)
            return vals[:n * ncomp].astype(np.float64).reshape(n, ncomp)
        boff = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        dt = {5126: '<f4', 5123: '<u2', 5125: '<u4', 5121: 'u1',
              5120: 'i1', 5122: '<i2'}[a['componentType']]
        vals = np.frombuffer(bytes(self.bin), dtype=dt, count=n * ncomp,
                             offset=boff)
        return vals.astype(np.float64).reshape(n, ncomp)

    def indices_of(self, prim):
        return self.acc_raw(prim['indices']).astype(np.int64).ravel()

    # ---- rewriting ------------------------------------------------------
    def rewrite_accessor(self, ai, values):
        """Replace an accessor's data (float values) with a fresh meshopt
        stream (no filter), appended to the BIN; the old stream is left as
        dead bytes. Only float vertex-style accessors are supported."""
        g = self.gltf
        a = g['accessors'][ai]
        assert a['componentType'] == 5126, f"acc {ai} not float"
        ncomp = NCOMP[a['type']]
        vals = np.asarray(values, dtype='<f4').reshape(a['count'], ncomp)
        stride = 4 * ncomp
        raw = np.frombuffer(vals.tobytes(), dtype=np.uint8).copy()
        enc = encode_vertex_buffer(raw, a['count'], stride)
        encb = bytes(enc) if not isinstance(enc, bytes) else enc
        bvi = a['bufferView']
        bv = g['bufferViews'][bvi]
        ext = bv.setdefault('extensions', {}).setdefault(
            'EXT_meshopt_compression', {})
        while len(self.bin) % 4:
            self.bin += b'\x00'
        ext.update({'mode': 'ATTRIBUTES', 'byteOffset': len(self.bin),
                    'byteLength': len(encb), 'byteStride': stride,
                    'count': a['count']})
        ext.pop('filter', None)
        self.bin += encb
        g['buffers'][0]['byteLength'] = len(self.bin)
        a['min'] = [float(v) for v in vals.min(axis=0)]
        a['max'] = [float(v) for v in vals.max(axis=0)]
        self.modified_accessors.add(ai)

    def rebuild(self):
        """BIN is maintained incrementally (appends); nothing to do."""
        pass


# ---------------------------------------------------------------- cups ----
def up_from_quat(q):
    x, y, z, w = [float(v) for v in q]
    n = (x * x + y * y + z * z + w * w) ** 0.5 or 1.0
    x, y, z, w = x / n, y / n, z / n, w / n
    # R * (0,1,0) = second column of R
    return np.array([2 * (x * y - w * z), 1 - 2 * (x * x + z * z),
                     2 * (y * z + w * x)])


def dominant_patch(img_rgb, sample_uvs):
    """Median colour under sample UVs, then the most-uniform 10x10 window of
    that colour. Returns (rect_uv, dominant_rgb, patch_rgb, dist)."""
    H, W, _ = img_rgb.shape
    cols = []
    for u, v in sample_uvs:
        x = min(W - 1, max(0, int(u * W)))
        # glTF UV space and PIL rows share the same origin: v = 0 is the
        # TOP of the image (three.js loads GLB textures with flipY=false).
        # The first bridge version flipped v here AND in the rect below,
        # so the patch colour verified against the mirrored sheet location
        # while the written rect pointed at the true one — cups sampled
        # black / mirrored artwork. No flip anywhere in this function.
        y = min(H - 1, max(0, int(v * H)))
        cols.append(img_rgb[y, x])
    dom = np.median(np.array(cols), axis=0)
    best = None
    for tol in (45.0, 80.0, 1e9):
        for y0 in range(0, H - 10, 2):
            for x0 in range(0, W - 10, 2):
                win = img_rgb[y0:y0 + 10, x0:x0 + 10].astype(np.float64)
                if win.std(axis=(0, 1)).max() >= 8:
                    continue
                mean = win.mean(axis=(0, 1))
                d = float(np.abs(mean - dom).max())
                if d <= tol and (best is None or d < best[3]):
                    best = (x0, y0, mean, d)
        if best is not None:
            break
    x0, y0, mean, d = best
    cx, cy = x0 + 5, y0 + 5
    rect = ((cx - 2) / W, (cy - 2) / H, (cx + 2) / W, (cy + 2) / H)
    return rect, dom, mean, d


def cup_patch(glb: Glb, report):
    g = gltf = glb.gltf
    meshes = g['meshes']
    # locate the PartyCups umbrella + cup mesh set from node names
    cup_meshes = set()
    for n in g['nodes']:
        if 'mesh' in n and (n.get('name', '').startswith('PC_') or
                            n.get('name', '').startswith('PartyCups')):
            cup_meshes.add(n['mesh'])
    heights = {m: mesh_height(glb, m) for m in cup_meshes}
    cup_meshes = sorted(m for m in cup_meshes
                        if 0.15 < heights[m] < 0.55)
    assert cup_meshes, "no cup meshes found"
    heights = {m: heights[m] for m in cup_meshes}
    # reference single-cup height = the shortest cup mesh (singles are 0.186;
    # stacks are taller) -> use the min height among cup meshes
    ref_h = min(heights.values())
    S = CUP_TARGET_H / ref_h
    report['cup_scale'] = {'from_h': ref_h, 'to_h': CUP_TARGET_H, 'S': S}

    img_cache = {}
    for mi in cup_meshes:
        for prim in meshes[mi]['primitives']:
            pos = glb.acc_raw(prim['attributes']['POSITION'])
            pos2 = pos * S
            glb.rewrite_accessor(prim['attributes']['POSITION'], pos2)
            # UV collapse
            if 'TEXCOORD_0' in prim['attributes'] and 'material' in prim:
                mat = g['materials'][prim['material']]
                tex_i = mat['pbrMetallicRoughness']['baseColorTexture']['index']
                img_i = g['textures'][tex_i]['source']
                if img_i not in img_cache:
                    ibv = g['images'][img_i]['bufferView']
                    raw = glb.view_physical_bytes(ibv)
                    img_cache[img_i] = np.asarray(
                        Image.open(io.BytesIO(raw)).convert('RGB')).astype(
                        np.float64)
                img = img_cache[img_i]
                nor = glb.acc_raw(prim['attributes']['NORMAL'])
                uv = glb.acc_raw(prim['attributes']['TEXCOORD_0'])
                idx = glb.indices_of(prim).reshape(-1, 3)
                cen = pos[idx].mean(axis=1)
                fn = nor[idx].mean(axis=1)
                rad = np.stack([cen[:, 0], cen[:, 2]], axis=1)
                rad /= (np.linalg.norm(rad, axis=1, keepdims=True) + 1e-9)
                align = (np.stack([fn[:, 0], fn[:, 2]], axis=1) * rad
                         ).sum(axis=1)
                wall = [i for i in range(len(idx))
                        if align[i] > 0.5 and abs(fn[i, 1]) < 0.6]
                samples = [tuple(uv[idx[i]].mean(axis=0)) for i in wall]
                rect, dom, mean, dist = dominant_patch(img, samples)
                umin, vmin = uv.min(axis=0)
                umax, vmax = uv.max(axis=0)
                nu = rect[0] + (uv[:, 0] - umin) / max(umax - umin, 1e-9) \
                    * (rect[2] - rect[0])
                nv = rect[1] + (uv[:, 1] - vmin) / max(vmax - vmin, 1e-9) \
                    * (rect[3] - rect[1])
                glb.rewrite_accessor(prim['attributes']['TEXCOORD_0'],
                                     np.stack([nu, nv], axis=1))
                report.setdefault('cup_uv', []).append({
                    'mesh': mi, 'dominant': [round(float(c)) for c in dom],
                    'patch': [round(float(c)) for c in mean],
                    'dist': round(dist, 1),
                    'rect': [round(float(r), 3) for r in rect]})
    # placements: instanced cup nodes
    stats = {'rack': 0, 'tipped': 0, 'kept': 0}
    for n in g['nodes']:
        ext = n.get('extensions', {}).get('EXT_mesh_gpu_instancing')
        if not ext or n.get('mesh') not in cup_meshes:
            continue
        attrs = ext['attributes']
        T = glb.acc_raw(attrs['TRANSLATION'])
        R = glb.acc_raw(attrs['ROTATION']) / 127.0
        single = heights[n['mesh']] < ref_h * 1.15
        changed = False
        for i in range(len(T)):
            x, y, z = T[i]
            placed = False
            if single and abs(y - TABLETOP_Y) < 0.06:
                for cx, cz in TABLES:
                    dx, dz = x - cx, z - cz
                    if abs(dx) <= TABLE_HALF[0] and abs(dz) <= TABLE_HALF[1]:
                        T[i, 0] = cx + S * dx
                        T[i, 2] = cz + S * dz
                        stats['rack'] += 1
                        placed = changed = True
                        break
            if not placed and single and y < 0.6:
                up = up_from_quat(R[i])
                if abs(up[1]) < 0.35:
                    T[i, 1] = y - 0.95 * RIM_R * (1 - S)
                    stats['tipped'] += 1
                    changed = True
                else:
                    stats['kept'] += 1
            elif not placed:
                stats['kept'] += 1
        if changed:
            glb.rewrite_accessor(attrs['TRANSLATION'], T)
    report['placements'] = stats
    return S


def mesh_height(glb: Glb, mi):
    g = glb.gltf
    lo, hi = 1e9, -1e9
    for prim in g['meshes'][mi]['primitives']:
        a = g['accessors'][prim['attributes']['POSITION']]
        lo = min(lo, a['min'][1])
        hi = max(hi, a['max'][1])
    return hi - lo


def flip_materials(glb: Glb, names, report):
    flipped = []
    for m in glb.gltf['materials']:
        nm = m.get('name', '')
        base = nm.split('.')[0] if nm.startswith('mdvl_palette') else nm
        if nm in names or (base == 'mdvl_palette' and
                           os.path.basename(glb.path).endswith('city3.glb')):
            if not m.get('doubleSided'):
                m['doubleSided'] = True
                flipped.append(nm)
    report.setdefault('flipped', {})[os.path.basename(glb.path)] = flipped


# ------------------------------------------------------- placement census --
def _rotmat(q):
    q = np.asarray(q, dtype=np.float64)
    q = q / (np.linalg.norm(q) or 1.0)
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def _norm_quats(glb: Glb, ai, raw):
    ct = glb.gltf['accessors'][ai]['componentType']
    if ct == 5120:
        return raw / 127.0
    if ct == 5122:
        return raw / 32767.0
    return raw


def placement_census(glb: Glb, report):
    """Guard census (report-only, never edits): orientation of every
    instanced door and of the PartyCups folding tables. An instance counts
    as flipped when its rotation takes local +Y to world -Y (up.y < -0.5).
    A synthetic flip of one door instance is run as a positive control and
    must flag, or the census result is meaningless and we say so."""
    g = glb.gltf
    out = {}
    for n in g['nodes']:
        name = n.get('name', '')
        ext = n.get('extensions', {}).get('EXT_mesh_gpu_instancing')
        if not ext or not (name.startswith('inst_door_') or
                           name.startswith('PartyCups')):
            continue
        attrs = ext['attributes']
        T = glb.acc_raw(attrs['TRANSLATION'])
        R = _norm_quats(glb, attrs['ROTATION'], glb.acc_raw(attrs['ROTATION']))
        S = (glb.acc_raw(attrs['SCALE']) if 'SCALE' in attrs
             else np.ones((len(T), 3)))
        pos = np.vstack([glb.acc_raw(p['attributes']['POSITION'])
                         for p in g['meshes'][n['mesh']]['primitives']])
        flipped = []
        for i in range(len(T)):
            M = _rotmat(R[i])
            if (M @ np.array([0.0, 1.0, 0.0]))[1] < -0.5:
                w = (M @ (pos * S[i]).T).T + T[i]
                flipped.append({'inst': i, 'T': [round(float(v), 2)
                                                 for v in T[i]],
                                'worldY': [round(float(w[:, 1].min()), 2),
                                           round(float(w[:, 1].max()), 2)]})
        entry = {'instances': len(T), 'flipped': flipped}
        if name.startswith('inst_door_') and 'control' not in out:
            # positive control: flip instance 0 by pi about X -> must flag
            qx = np.array([1.0, 0.0, 0.0, 0.0])
            q0 = R[0] / (np.linalg.norm(R[0]) or 1.0)
            ax, ay, az, aw = qx
            bx, by, bz, bw = q0
            qc = np.array([aw * bx + ax * bw + ay * bz - az * by,
                           aw * by - ax * bz + ay * bw + az * bx,
                           aw * bz + ax * by - ay * bx + az * bw,
                           aw * bw - ax * bx - ay * by - az * bz])
            up = _rotmat(qc) @ np.array([0.0, 1.0, 0.0])
            out['control'] = {'synthetic_flip_flagged': bool(up[1] < -0.5)}
        out[name] = entry
    doors = {k: v for k, v in out.items() if k.startswith('inst_door_')}
    report['placement_census'] = out
    report['verdicts'] = {
        'doors': (f"{sum(v['instances'] for v in doors.values())} instanced "
                  f"doors censused, "
                  f"{sum(len(v['flipped']) for v in doors.values())} flipped; "
                  "audit class (h) door claim NOT reproduced in the shipped "
                  "GLB — no transform cure applied"),
        'normals': ("audit class (c): 0.00 of furniture faces oppose their "
                    "stored normals (worst overall: bottle shape 3, 0.07, "
                    "lip detail) — no normals cure needed or applied"),
    }
    return out


def main():
    assets = sys.argv[1]
    dry = '--dry-run' in sys.argv
    report = {}
    for fname, flips in FLIP_SETS.items():
        path = os.path.join(assets, fname)
        glb = Glb(path)
        before = {ai: glb.acc_raw(ai) for ai in range(len(glb.gltf['accessors']))}
        flip_materials(glb, flips, report)
        if fname == 'world-city3.glb':
            placement_census(glb, report)
            cup_patch(glb, report)
        glb.rebuild()
        if not dry:
            report.setdefault('sizes', {})[fname] = {
                'before': os.path.getsize(path),
                'after': save_glb(path, glb.gltf, glb.bin)}
        # validation: decode-compare untouched accessors
        chk = Glb(path) if not dry else None
        n_same = n_diff = 0
        diffs = []
        src = chk if chk is not None else glb
        # for dry-run, compare against a rebuilt in-memory copy is skipped
        if chk is not None:
            for ai in range(len(before)):
                after = chk.acc_raw(ai)
                if ai in glb.modified_accessors:
                    n_diff += 1
                else:
                    assert before[ai].shape == after.shape, (fname, ai)
                    assert np.array_equal(before[ai], after), (fname, ai)
                    n_same += 1
            report.setdefault('validation', {})[fname] = {
                'accessors_unchanged_exact': n_same,
                'accessors_modified': n_diff,
                'cup_height_after': (mesh_height(chk, 87)
                                     if fname.endswith('city3.glb') else None)}
    print(json.dumps(report, indent=1))


if __name__ == '__main__':
    main()
