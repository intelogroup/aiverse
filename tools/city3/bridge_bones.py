#!/usr/bin/env python3
"""Replace shipped shop geometry with the generated bones (bones.py).

Per lot, in the visual GLB and the collision GLB: delete the old triangles
whose centroid lies inside the lot footprint (same face-level cut as
bridge_edge_landscape.py), then append the bones as one mesh node
(`Bones_shop{n}` visual, `col_bones_shop{n}` collision). Boxes carry
walls, slabs, stairs and the roof as flat-colour blockout.

GLB frame: x_t = x, z_t = -y_plan, y up. The walk slab is y=0.2, so the
bones are lifted by FLOOR_Y (their local z=0 floor top).

  python3 tools/city3/bridge_bones.py --lots 46 --dry-run
  python3 tools/city3/bridge_bones.py --lots 46
Afterwards rebuild world-shell.glb and the navmesh.
"""
import argparse
import json
import os
import shutil
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
import bridge_edge_landscape as E                      # noqa: E402
from bridge_landscape_kit import add_accessor, add_material, add_view  # noqa
from bridge_wave1 import Glb, save_glb                 # noqa: E402

MARK = "bones_lots"
REBUILD = "--rebuild" in sys.argv   # re-emit bones of already patched lots, no cut
FLOOR_Y = 0.2
E.PAD = 0.1            # shops share party walls: stay inside the footprint
COL = {"shell": (0.82, 0.78, 0.70), "partition": (0.90, 0.88, 0.84),
       "slab": (0.45, 0.40, 0.34), "stair": (0.60, 0.50, 0.38),
       "landing": (0.60, 0.50, 0.38),
       "roof": (0.55, 0.28, 0.18)}
# face = (outward normal, 4 corner picks (axis bit per x,y,z)) CCW from outside
FACES = [((1, 0, 0), [(1, 0, 0), (1, 1, 0), (1, 1, 1), (1, 0, 1)]),
         ((-1, 0, 0), [(0, 0, 0), (0, 0, 1), (0, 1, 1), (0, 1, 0)]),
         ((0, 1, 0), [(0, 1, 0), (0, 1, 1), (1, 1, 1), (1, 1, 0)]),
         ((0, -1, 0), [(0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1)]),
         ((0, 0, 1), [(0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]),
         ((0, 0, -1), [(0, 0, 0), (0, 1, 0), (1, 1, 0), (1, 0, 0)])]


def box_mesh(boxes, role):
    """Plan-frame boxes of one role -> GLB-frame pos/nrm/idx arrays."""
    pos, nrm, idx = [], [], []
    for (x0, y0, z0, x1, y1, z1, r) in boxes:
        if r != role:
            continue
        lo, hi = (x0, y0, z0 + FLOOR_Y), (x1, y1, z1 + FLOOR_Y)
        for n, corners in FACES:
            base = len(pos)
            for c in corners:
                p = [hi[i] if c[i] else lo[i] for i in range(3)]
                pos.append((p[0], p[2], -p[1]))          # plan -> GLB
                nrm.append((n[0], n[2], -n[1]))
            idx += [base, base + 1, base + 2, base, base + 2, base + 3]
    return (np.array(pos, "<f4"), np.array(nrm, "<f4"),
            np.array(idx, "<u4"))


QUADS = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (2, 3, 7, 6), (0, 4, 7, 3),
         (1, 2, 6, 5)]


def ramp_mesh(prisms):
    """Wedge prisms (8 plan-frame points each) -> pos/nrm/idx, outward CCW."""
    pos, nrm, idx = [], [], []
    for pts in prisms:
        p = np.array([[x, y, z + FLOOR_Y] for x, y, z in pts])
        cen = p.mean(0)
        for q in QUADS:
            a, b, c, d = (p[i] for i in q)
            n = np.cross(b - a, c - a)
            if np.dot(n, (a + b + c + d) / 4 - cen) < 0:
                q = q[::-1]
                a, b, c, d = (p[i] for i in q)
                n = np.cross(b - a, c - a)
            n = n / np.linalg.norm(n)
            base = len(pos)
            for i in q:
                pos.append((p[i][0], p[i][2], -p[i][1]))
                nrm.append((n[0], n[2], -n[1]))
            idx += [base, base + 1, base + 2, base, base + 2, base + 3]
    return (np.array(pos, "<f4"), np.array(nrm, "<f4"), np.array(idx, "<u4"))


def add_bones(glb, lot, cache, roles, collision):
    g = glb.gltf
    prims = []
    for role in roles + (["ramp"] if collision else []):
        if role == "ramp":      # collision only: stairs as ramps (see bones.py)
            pos, nrm, idx = ramp_mesh(lot["ramps"])
        elif collision and role == "stair":
            continue
        else:
            pos, nrm, idx = box_mesh(lot["boxes"], role)
        if not len(pos):
            continue
        pa = add_accessor(glb, add_view(glb, pos.tobytes(), 34962), 5126,
                          len(pos), "VEC3", pos.min(0).tolist(),
                          pos.max(0).tolist())
        na = add_accessor(glb, add_view(glb, nrm.tobytes(), 34962), 5126,
                          len(nrm), "VEC3")
        ia = add_accessor(glb, add_view(glb, idx.tobytes(), 34963), 5125,
                          len(idx), "SCALAR")
        prims.append({"attributes": {"POSITION": pa, "NORMAL": na},
                      "indices": ia,
                      "material": add_material(glb, cache, "bones_" + role,
                                               COL.get(role, COL["stair"]),
                                               False)})
    # capsuleWorld.bakeCollisionRoot only keeps meshes named col_*
    nm = ("col_bones_shop%d" if collision else "Bones_shop%d") % lot["id"]
    old = next((n for n in g["nodes"] if n.get("name") == nm), None)
    if old is not None:         # rebuild: swap prims, old bytes stay dead
        g["meshes"][old["mesh"]]["primitives"] = prims
        return
    g["meshes"].append({"name": nm, "primitives": prims})
    g["nodes"].append({"name": nm,
                       "mesh": len(g["meshes"]) - 1})
    g["scenes"][0]["nodes"].append(len(g["nodes"]) - 1)


FRONT_PAD = 1.5   # awnings, signs, planters, door steps stick out of the street wall
E.VISUAL_NODES = E.VISUAL_NODES + ("WoodFloor", "BladeSigns")


def front_rect(lot):
    x0, y0, x1, y1 = lot["rect"]
    f = lot["face"]
    return [x0 - FRONT_PAD * (f == "W"), y0 - FRONT_PAD * (f == "S"),
            x1 + FRONT_PAD * (f == "E"), y1 + FRONT_PAD * (f == "N")]


def repair_fallbacks(glb):
    """Earlier cuts re-encoded the compressed index copy only; copy the decoded
    indices back into the raw fallback bytes so decoder-less loaders agree."""
    g, fixed = glb.gltf, 0
    for mesh in g["meshes"]:
        for prim in mesh["primitives"]:
            if "indices" not in prim:
                continue
            acc = g["accessors"][prim["indices"]]
            view = g["bufferViews"][acc["bufferView"]]
            if "EXT_meshopt_compression" not in view.get("extensions", {}):
                continue
            vals = glb.indices_of(prim)
            raw = np.asarray(vals, dtype="<u2" if acc["componentType"] == 5123
                             else "<u4").tobytes()
            off = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
            if len(raw) != view["byteLength"] or off + len(raw) > len(glb.bin):
                continue
            if glb.bin[off:off + len(raw)] != raw:
                buf = bytearray(glb.bin)
                buf[off:off + len(raw)] = raw
                glb.bin = bytes(buf)
                fixed += 1
    return fixed


def patch(path, lots, collision, dry_run):
    glb = Glb(path)
    done = set(glb.gltf.get("extras", {}).get(MARK, []))
    todo = lots if REBUILD else [l for l in lots if l["id"] not in done]
    if not todo:
        return {"already_patched": sorted(done)}
    report = {} if REBUILD else E.cut(glb, [front_rect(l) for l in todo],
                                      collision, dry_run)
    if dry_run:
        return {"lots": [l["id"] for l in todo], "removed": report,
                "total": sum(report.values())}
    cache = {}
    for l in todo:
        add_bones(glb, l, cache, list(COL), collision)
    if collision:
        report["fallbacks_repaired"] = repair_fallbacks(glb)
    glb.gltf.setdefault("extras", {})[MARK] = sorted(done | {l["id"] for l in todo})
    target = os.path.abspath(path)
    fd, tmp = tempfile.mkstemp(suffix=".glb", dir=os.path.dirname(target))
    os.close(fd)
    try:
        save_glb(tmp, glb.gltf, glb.bin)
        chk = Glb(tmp)                        # decode everything rewritten
        for node in chk.gltf["nodes"]:
            if "mesh" in node:
                for p in chk.gltf["meshes"][node["mesh"]]["primitives"]:
                    if "indices" in p:
                        chk.indices_of(p)
        for bv in chk.gltf["bufferViews"]:
            e = bv.get("extensions", {}).get("EXT_meshopt_compression")
            assert e is None or "buffer" in e
        shutil.copy2(target, "/tmp/%s.pre-bones" % os.path.basename(target))
        os.replace(tmp, target)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return {"lots": [l["id"] for l in todo], "removed": report,
            "total": sum(report.values())}


def clear_sidecars(assets, lots):
    """The old furnished ground floor lives in interiors/shop-N.json (props)
    and shop-N.col.json (furniture boxes, baked into the navmesh as
    `interior:shop-N`). They stand in the new corridors, so empty them; the
    room entry (name, door, cut) stays."""
    for l in lots:
        for suffix, key in ((".json", "props"), (".col.json", "boxes")):
            p = os.path.join(assets, "interiors", "shop-%d%s" % (l["id"], suffix))
            if not os.path.exists(p):
                continue
            d = json.load(open(p))
            d[key] = []
            if key == "boxes":
                d["floorY"] = FLOOR_Y
            with open(p, "w") as f:
                json.dump(d, f, separators=(",", ":"))


SIGN_MARK = "bones_signs"
SIGN_COL = {"S": (0, -1), "N": (0, 1), "W": (-1, 0), "E": (1, 0)}
SIGN_PAL = [(0.55, 0.12, 0.10), (0.10, 0.30, 0.45), (0.18, 0.38, 0.20),
            (0.60, 0.42, 0.08), (0.35, 0.15, 0.40)]


def fix_cut(assets, lots):
    """Hero-room cutaway slices at index.json cut.y (was 4.45, one storey).
    Put it just under the roof slab so every floor stays visible."""
    p = os.path.join(assets, "interiors", "index.json")
    idx = json.load(open(p))
    byid = {l["id"]: l for l in lots}
    for r in idx:
        l = byid.get(int(r["id"][5:])) if r["id"].startswith("shop-") else None
        if l:
            r["door"] = [l["door"][0], -l["door"][1]]   # GLB z = -plan y
            r["cut"]["y"] = round(l["roof"] - 0.25 + FLOOR_Y - 0.05, 2)
    with open(p, "w") as f:
        json.dump(idx, f, separators=(",", ":"))
    return idx


SIGN_W, SIGN_H, SIGN_T, SIGN_EPS = 1.6, (3.0, 3.7), 0.25, 0.015


def sign_png(name, col):
    """512x112 board: shop name auto-fitted in DejaVu Sans Bold (open licence)."""
    import io
    import matplotlib
    from PIL import Image, ImageDraw, ImageFont
    font = os.path.join(os.path.dirname(matplotlib.__file__), "mpl-data",
                        "fonts", "ttf", "DejaVuSans-Bold.ttf")
    W, H = 512, 112
    bg = tuple(int(255 * c ** (1 / 2.2)) for c in col)   # factor is linear, PNG is sRGB
    im = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(im)
    d.rectangle([5, 5, W - 6, H - 6], outline=(235, 220, 180), width=4)
    size = 64
    while True:
        f = ImageFont.truetype(font, size)
        l, t, r, b = d.textbbox((0, 0), name, font=f)
        if (r - l <= W - 48 and b - t <= H - 34) or size <= 14:
            break
        size -= 2
    d.text(((W - (r - l)) / 2 - l, (H - (b - t)) / 2 - t), name, font=f,
           fill=(245, 235, 205))
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def sign_quad(l):
    """Textured quad SIGN_EPS proud of the board's street face, GLB frame.
    Left/right are as seen from the street; UV origin top-left (glTF)."""
    dx, dy = SIGN_COL[l["face"]]
    x0, y0, x1, y1 = l["rect"]
    wall = {"S": y0, "N": y1, "W": x0, "E": x1}[l["face"]]
    door, off = l["door"], SIGN_T + SIGN_EPS
    n = np.array([dx, 0.0, -dy])                       # GLB outward normal
    right = np.array([n[2], 0.0, -n[0]])               # (-n) x up
    z0, z1 = SIGN_H[0] + FLOOR_Y, SIGN_H[1] + FLOOR_Y
    def pt(a, z):
        px, py = (a, wall + dy * off) if dx == 0 else (wall + dx * off, a)
        return np.array([px, z, -py])
    c = door[0] if dx == 0 else door[1]
    ends = sorted([c - SIGN_W, c + SIGN_W],
                  key=lambda a: float(np.dot(right, pt(a, 0))))
    pos = np.array([pt(ends[0], z0), pt(ends[1], z0), pt(ends[1], z1),
                    pt(ends[0], z1)], "<f4")
    uv = np.array([[0, 1], [1, 1], [1, 0], [0, 0]], "<f4")
    return (pos, np.tile(n, (4, 1)).astype("<f4"), uv,
            np.array([0, 1, 2, 0, 2, 3], "<u4"))


def add_sign_text(glb, lot, col, name):
    """Primitive carrying the shop-name texture (image + texture + material)."""
    from bridge_landscape_kit import append_bytes
    g = glb.gltf
    lot_id = lot["id"]
    pos, nrm, uv, ix = sign_quad(lot)
    png = sign_png(name, col)
    off = append_bytes(glb, png)
    g["bufferViews"].append({"buffer": 0, "byteOffset": off, "byteLength": len(png)})
    g.setdefault("images", []).append({"name": "sign_%d" % lot_id, "mimeType": "image/png",
                                       "bufferView": len(g["bufferViews"]) - 1})
    g.setdefault("textures", []).append({"source": len(g["images"]) - 1})
    g["materials"].append({"name": "ls_signtex_%d" % lot_id,
                           "pbrMetallicRoughness": {
                               "baseColorTexture": {"index": len(g["textures"]) - 1},
                               "metallicFactor": 0.0, "roughnessFactor": 0.9},
                           "doubleSided": False})
    pa = add_accessor(glb, add_view(glb, pos.tobytes(), 34962), 5126, 4, "VEC3",
                      pos.min(0).tolist(), pos.max(0).tolist())
    na = add_accessor(glb, add_view(glb, nrm.tobytes(), 34962), 5126, 4, "VEC3")
    ta = add_accessor(glb, add_view(glb, uv.tobytes(), 34962), 5126, 4, "VEC2")
    ia = add_accessor(glb, add_view(glb, ix.tobytes(), 34963), 5125, 6, "SCALAR")
    return {"attributes": {"POSITION": pa, "NORMAL": na, "TEXCOORD_0": ta},
            "indices": ia, "material": len(g["materials"]) - 1}


def add_signs(path, lots, idx, dry_run):
    """Board over each street door, plus a lettered quad with the shop name."""
    glb = Glb(path)
    done = set(glb.gltf.get("extras", {}).get(SIGN_MARK, []))
    todo = lots if REBUILD else [l for l in lots if l["id"] not in done]
    cache, boxes = {}, []
    for l in todo:
        dx, dy = SIGN_COL[l["face"]]
        door = l["door"]            # plan frame, on the street wall line
        x0, y0, x1, y1 = l["rect"]
        # door sits on the street wall line; board 3.2 wide, 0.6 tall, 0.25 proud
        w, h, t = 1.6, (3.0, 3.7), 0.25
        wall = {"S": y0, "N": y1, "W": x0, "E": x1}[l["face"]]
        if dx == 0:
            bx = (door[0] - w, wall + (0 if dy > 0 else -t), h[0],
                  door[0] + w, wall + (t if dy > 0 else 0), h[1])
        else:
            bx = (wall + (0 if dx > 0 else -t), door[1] - w, h[0],
                  wall + (t if dx > 0 else 0), door[1] + w, h[1])
        boxes.append((l["id"], bx))
    if dry_run or not boxes:
        return {"signs": [b[0] for b in boxes]}
    byid = {l["id"]: l for l in todo}
    names = {int(r["id"][5:]): r["name"] for r in idx if r["id"].startswith("shop-")}
    for lid, bx in boxes:
        pos, nrm, ix = box_mesh([bx + ("sign",)], "sign")
        pa = add_accessor(glb, add_view(glb, pos.tobytes(), 34962), 5126,
                          len(pos), "VEC3", pos.min(0).tolist(), pos.max(0).tolist())
        na = add_accessor(glb, add_view(glb, nrm.tobytes(), 34962), 5126,
                          len(nrm), "VEC3")
        ia = add_accessor(glb, add_view(glb, ix.tobytes(), 34963), 5125,
                          len(ix), "SCALAR")
        col = SIGN_PAL[lid % len(SIGN_PAL)]
        mat = add_material(glb, cache, "sign_%d" % lid, col, False)
        nm = "Sign_shop%d" % lid
        prim = {"attributes": {"POSITION": pa, "NORMAL": na}, "indices": ia,
                "material": mat}
        prims = [prim]
        if names.get(lid):
            prims.append(add_sign_text(glb, byid[lid], col, names[lid]))
        old = next((n for n in glb.gltf["nodes"] if n.get("name") == nm), None)
        if old is not None:         # rebuild: swap prims, old bytes stay dead
            glb.gltf["meshes"][old["mesh"]]["primitives"] = prims
            continue
        glb.gltf["meshes"].append({"name": nm, "primitives": prims})
        glb.gltf["nodes"].append({"name": nm, "mesh": len(glb.gltf["meshes"]) - 1})
        glb.gltf["scenes"][0]["nodes"].append(len(glb.gltf["nodes"]) - 1)
    glb.gltf.setdefault("extras", {})[SIGN_MARK] = sorted(done | {b[0] for b in boxes})
    fd, tmp = tempfile.mkstemp(suffix=".glb", dir=os.path.dirname(os.path.abspath(path)))
    os.close(fd)
    try:
        save_glb(tmp, glb.gltf, glb.bin)
        chk = Glb(tmp)
        for node in chk.gltf["nodes"]:
            if "mesh" in node:
                for p in chk.gltf["meshes"][node["mesh"]]["primitives"]:
                    if "indices" in p:
                        chk.indices_of(p)
        shutil.copy2(path, "/tmp/%s.pre-signs" % os.path.basename(path))
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return {"signs": [b[0] for b in boxes]}


LIFT = 0.02
PITCH_MARK, PITCH_TAN, PITCH_OV = "bones_pitched", 0.42, 0.35
PITCH_COL = (0.62, 0.30, 0.20)


def pitched_roof(lot):
    """Gable roof over the flat bones roof slab, GLB frame, visual only. The
    ridge runs along the longer side; the slopes overhang the eaves by
    PITCH_OV; the gable ends are flush with the party walls. Returns
    (pos, nrm, idx) with flat normals."""
    x0, y0, x1, y1 = lot["rect"]
    lo, hi = (x0, -y1), (x1, -y0)                       # GLB (x, z) rect
    ridge_x = (hi[0] - lo[0]) >= (hi[1] - lo[1])
    a0, a1, c0, c1 = (lo[0], hi[0], lo[1], hi[1]) if ridge_x else (lo[1], hi[1], lo[0], hi[0])
    cm, half = (c0 + c1) / 2, (c1 - c0) / 2
    yt = lot["roof"] + FLOOR_Y + LIFT
    yr, ye = yt + half * PITCH_TAN, yt - PITCH_OV * PITCH_TAN
    cl, ch = c0 - PITCH_OV, c1 + PITCH_OV
    def P(a, c, y):
        return (a, y, c) if ridge_x else (c, y, a)
    tris = [
        (P(a0, cl, ye), P(a1, cl, ye), P(a1, cm, yr)),      # slope, low side
        (P(a0, cl, ye), P(a1, cm, yr), P(a0, cm, yr)),
        (P(a0, ch, ye), P(a1, cm, yr), P(a1, ch, ye)),      # slope, high side
        (P(a0, ch, ye), P(a0, cm, yr), P(a1, cm, yr)),
        (P(a0, cl, ye), P(a0, cm, yr), P(a0, ch, ye)),      # gable ends
        (P(a1, cl, ye), P(a1, ch, ye), P(a1, cm, yr)),
        (P(a0, cl, ye), P(a1, ch, ye), P(a1, cl, ye)),      # underside
        (P(a0, cl, ye), P(a0, ch, ye), P(a1, ch, ye)),
    ]
    mid = np.array(P((a0 + a1) / 2, cm, (yt + yr) / 2))
    pos, nrm = [], []
    for a, b, c in tris:
        a, b, c = map(np.array, (a, b, c))
        n = np.cross(b - a, c - a)
        n /= np.linalg.norm(n)
        if np.dot(n, (a + b + c) / 3 - mid) < 0:        # wind CCW from outside
            b, c, n = c, b, -n
        pos += [a, b, c]
        nrm += [n, n, n]
    return np.array(pos, "<f4"), np.array(nrm, "<f4"), np.arange(len(pos), dtype="<u4")


def add_pitched(path, lots, dry_run):
    """Visual-only `Roof_shop{n}` gable roof on every bones lot (no collision:
    the roof is not walkable). The cutaway clips it with the rest of the roof."""
    glb = Glb(path)
    done = set(glb.gltf.get("extras", {}).get(PITCH_MARK, []))
    todo = lots if REBUILD else [l for l in lots if l["id"] not in done]
    if dry_run or not todo:
        return {"roofs": [l["id"] for l in todo]}
    cache = {}
    for l in todo:
        pos, nrm, ix = pitched_roof(l)
        pa = add_accessor(glb, add_view(glb, pos.tobytes(), 34962), 5126,
                          len(pos), "VEC3", pos.min(0).tolist(), pos.max(0).tolist())
        na = add_accessor(glb, add_view(glb, nrm.tobytes(), 34962), 5126, len(nrm), "VEC3")
        ia = add_accessor(glb, add_view(glb, ix.tobytes(), 34963), 5125, len(ix), "SCALAR")
        prim = {"attributes": {"POSITION": pa, "NORMAL": na}, "indices": ia,
                "material": add_material(glb, cache, "pitched_roof", PITCH_COL, False)}
        nm = "Roof_shop%d" % l["id"]
        old = next((n for n in glb.gltf["nodes"] if n.get("name") == nm), None)
        if old is not None:
            glb.gltf["meshes"][old["mesh"]]["primitives"] = [prim]
            continue
        glb.gltf["meshes"].append({"name": nm, "primitives": [prim]})
        glb.gltf["nodes"].append({"name": nm, "mesh": len(glb.gltf["meshes"]) - 1})
        glb.gltf["scenes"][0]["nodes"].append(len(glb.gltf["nodes"]) - 1)
    glb.gltf.setdefault("extras", {})[PITCH_MARK] = sorted(done | {l["id"] for l in todo})
    fd, tmp = tempfile.mkstemp(suffix=".glb", dir=os.path.dirname(os.path.abspath(path)))
    os.close(fd)
    try:
        save_glb(tmp, glb.gltf, glb.bin)
        chk = Glb(tmp)
        for node in chk.gltf["nodes"]:
            if "mesh" in node:
                for p in chk.gltf["meshes"][node["mesh"]]["primitives"]:
                    if "indices" in p:
                        chk.indices_of(p)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return {"roofs": [l["id"] for l in todo]}


def lift_visual(path, dry_run):
    """The bones ground slab top (y=0.2) is coplanar with the textured
    `Sidewalks` ground, so the two z-fight (striped wood-grain patches on every
    bones floor). Lift each visual Bones_shop node 2 cm with a node translation:
    JSON-only, collision (col_bones_*) keeps the true walk height."""
    glb = Glb(path)
    n = 0
    for node in glb.gltf["nodes"]:
        if node.get("name", "").startswith("Bones_shop") and "mesh" in node:
            if node.get("translation") != [0, LIFT, 0]:
                node["translation"] = [0, LIFT, 0]
                n += 1
    if n and not dry_run:
        fd, tmp = tempfile.mkstemp(suffix=".glb", dir=os.path.dirname(os.path.abspath(path)))
        os.close(fd)
        try:
            save_glb(tmp, glb.gltf, glb.bin)
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
    return {"lifted": n}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lift", action="store_true",
                    help="only lift visual Bones nodes 2 cm (z-fight with Sidewalks)")
    ap.add_argument("--pitched", action="store_true",
                    help="only add visual gable roofs (Roof_shop{n}) for --lots")
    ap.add_argument("--rebuild", action="store_true",
                    help="swap the bones of already patched lots (no cut)")
    ap.add_argument("--signs", action="store_true",
                    help="only fix cut.y and add door signs for --lots")
    ap.add_argument("--lots", required=True, help="'46,47' or 'all'")
    ap.add_argument("--json", default=os.path.join(HERE, "out",
                                                   "bones_all.json"))
    ap.add_argument("--visual", default="apps/console/public/assets/"
                                        "world-city3.glb")
    ap.add_argument("--collision", default="apps/console/public/assets/"
                                           "world-city3-collision.glb")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    data = json.load(open(a.json))
    if a.lots != "all":
        want = {int(v) for v in a.lots.split(",")}
        data = [d for d in data if d["id"] in want]
        assert len(data) == len(want), "unknown lot id"
    assets = os.path.dirname(a.visual)
    if a.lift:
        print("lift", json.dumps(lift_visual(a.visual, a.dry_run)))
        return
    if a.pitched:
        print("pitched", json.dumps(add_pitched(a.visual, data, a.dry_run)))
        return
    if not a.signs:
        print("visual", json.dumps(patch(a.visual, data, False, a.dry_run)))
        print("collision", json.dumps(patch(a.collision, data, True, a.dry_run)))
        if not a.dry_run:
            clear_sidecars(assets, data)
    idx = (json.load(open(os.path.join(assets, "interiors", "index.json")))
           if a.dry_run else fix_cut(assets, data))
    print("signs", json.dumps(add_signs(a.visual, data, idx, a.dry_run)))


if __name__ == "__main__":
    main()
