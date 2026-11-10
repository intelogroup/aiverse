#!/usr/bin/env python3
"""Parametric building bones for the market-block shops (generalises
pilotb_building.py: same space rules, any length / depth / floor count).

Local frame per building: x along the street (0..L), y depth from the street
wall (0..Dp), z up. Depth >= 10.4 m -> double-loaded (rooms | corridor |
rooms, stair flights run +y from the corridor centre). Shallower -> single
loaded (rooms on the street, corridor behind, flights run -y from the
corridor). Stair core sits at the west end. layout()/check() are pure python;
to_plan() maps local boxes into the plan frame by the lot's street face.

  python3 tools/city3/bones.py --check            # every market lot
  python3 tools/city3/bones.py --emit OUT.json    # boxes in plan coords
  Blender -b --factory-startup --python tools/city3/bones.py -- OUT_BASE IN.json
"""
import json
import os
import runpy
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pilotb_building import (  # noqa: E402
    BODY_H, BODY_R, DOOR_H, DOOR_W, RISER_MAX, SLAB, STAIR_W, STREET_H,
    STREET_W, TREAD, T_IN, T_OUT, WIN_H, WIN_SILL, WIN_W, X_CORE, _wall_y,
    wall_x,
)

GROUND_H, UPPER_H = 4.2, 3.8
SKIP_LOTS = {102}          # Tea House: hand-built, keep as is


def variant(L, Dp):
    """Narrow lots (< 10 m along the street, 12 m deep): lay the building out
    the long way (corridor runs along the depth, one room column, street door
    in the stair lobby). Returns (L', Dp', end_door)."""
    if L < 10.0 and Dp >= 10.4:
        return Dp, L, True
    return L, Dp, False


def geom(L, Dp, end_door=False):
    double = Dp >= 10.4
    if double:
        rd = (Dp - 2 * T_OUT - 2 * T_IN - 2.4) / 2
        Y_S = (T_OUT, T_OUT + rd)
        Y_C = (Y_S[1] + T_IN, Y_S[1] + T_IN + 2.4)
        Y_N = (Y_C[1] + T_IN, Dp - T_OUT)
    else:
        rd = Dp - 2 * T_OUT - T_IN - 2.4
        Y_S = (T_OUT, T_OUT + rd)
        Y_C = (Y_S[1] + T_IN, Dp - T_OUT)
        Y_N = None
    avail = L - T_OUT - (X_CORE[1] + T_IN) - T_OUT
    n = max(1, round(avail / 6.9))
    rw = (avail - (n - 1) * T_IN) / n
    xs, x = [], X_CORE[1] + T_IN
    for _ in range(n):
        xs.append((x, x + rw))
        x += rw + T_IN
    s = 1 if double else -1
    y_a = (Y_C[0] + Y_C[1]) / 2 if double else \
        Dp - T_OUT - (1.9 if end_door else 1.6)
    return dict(L=L, Dp=Dp, double=double, Y_S=Y_S, Y_C=Y_C, Y_N=Y_N,
                X_ROOMS=xs, RW=rw, s=s, y_a=y_a)


def floors_z(nfl):
    fl = [0.0, GROUND_H] + [GROUND_H + UPPER_H * i for i in range(1, nfl - 1)]
    fl = fl[:nfl]
    return fl, fl[-1] + UPPER_H


def layout(L, Dp, nfl, end_door=False):
    g = geom(L, Dp, end_door)
    Y_S, Y_C, Y_N, XR = g["Y_S"], g["Y_C"], g["Y_N"], g["X_ROOMS"]
    s, y_a = g["s"], g["y_a"]
    FL, ROOF = floors_z(nfl)
    levels = FL + [ROOF]
    mid = lambda r: (r[0] + r[1]) / 2.0
    boxes, doors, stairs = [], [], []
    ent = -1 if end_door else len(XR) // 2   # street-door room
    for fi, zf in enumerate(FL):
        zc = levels[fi + 1] - SLAB
        if fi == 0:
            boxes.append((0, 0, -0.5, L, Dp, 0.0, "slab"))
        else:
            if s > 0:
                boxes += [(0, 0, zf - SLAB, L, y_a, zf, "slab"),
                          (X_CORE[1], y_a, zf - SLAB, L, Dp, zf, "slab"),
                          (0, y_a, zf - SLAB, X_CORE[0], Dp, zf, "slab")]
            else:
                boxes += [(0, y_a, zf - SLAB, L, Dp, zf, "slab"),
                          (X_CORE[1], 0, zf - SLAB, L, y_a, zf, "slab"),
                          (0, 0, zf - SLAB, X_CORE[0], y_a, zf, "slab")]
        win = lambda xr: (mid(xr) - WIN_W / 2, mid(xr) + WIN_W / 2,
                          zf + WIN_SILL, zf + WIN_SILL + WIN_H)
        so = []
        for i, xr in enumerate(XR):
            if fi == 0 and i == ent:
                xm = mid(xr)
                so.append((xm - STREET_W / 2, xm + STREET_W / 2, 0.0, STREET_H))
            else:
                so.append(win(xr))
        boxes += wall_x(0, T_OUT, 0, L, zf, zc, "shell", so)
        boxes += wall_x(Dp - T_OUT, Dp, 0, L, zf, zc, "shell",
                        [win(xr) for xr in XR])
        west = []
        if end_door:       # street door (ground) / window (upper) in the lobby
            lc = (y_a + Dp - T_OUT) / 2
            west = [(lc - 0.9, lc + 0.9, 0.0, STREET_H)] if fi == 0 else \
                [(lc - 0.8, lc + 0.8, zf + WIN_SILL, zf + WIN_SILL + WIN_H)]
        boxes += _wall_y(0, T_OUT, 0, Dp, zf, zc, "shell", west)
        boxes += _wall_y(L - T_OUT, L, 0, Dp, zf, zc, "shell",
                         [(Y_C[0] + 0.2, Y_C[1] - 0.2, zf + 0.8, zf + 3.0)])
        boxes += _wall_y(X_CORE[1], X_CORE[1] + T_IN, T_OUT, Dp - T_OUT, zf, zc,
                         "partition", [(Y_C[0], Y_C[1], zf, zf + 3.0)])
        doors.append(dict(floor=fi, kind="core", width=Y_C[1] - Y_C[0],
                          height=3.0))
        walls = [(Y_S[1], "S")] + ([(Y_C[1], "N")] if Y_N else [])
        for yy, tag in walls:
            ops = []
            for i, xr in enumerate(XR):
                xm = mid(xr)
                w = 2.4 if (fi == 0 and tag == "S" and i == ent) else DOOR_W
                ops.append((xm - w / 2, xm + w / 2, zf, zf + DOOR_H))
                doors.append(dict(floor=fi, kind="room-" + tag, width=w,
                                  height=DOOR_H))
            boxes += wall_x(yy, yy + T_IN, X_CORE[1] + T_IN, L - T_OUT, zf, zc,
                            "partition", ops)
        for xr in XR[:-1]:
            for ys in (Y_S, Y_N):
                if ys:
                    boxes.append((xr[1], ys[0], zf, xr[1] + T_IN, ys[1], zc,
                                  "partition"))
        doors.append(dict(floor=fi, kind="ceiling", clear=zc - zf))
        if fi == 0:
            doors.append(dict(floor=0, kind="street",
                              width=1.8 if end_door else STREET_W,
                              height=STREET_H))
        if fi + 1 < nfl:
            rise = FL[fi + 1] - zf
            n = int(round(rise / 0.175))
            n1 = n // 2
            r = rise / n
            run = n1 * TREAD
            y_b = y_a + s * run
            xa = (0.55, 0.55 + STAIR_W)
            xb = (X_CORE[1] - 0.2 - STAIR_W, X_CORE[1] - 0.2)
            yy = lambda a, b: (min(a, b), max(a, b))
            for k in range(n1):
                ya, yb = yy(y_a + s * k * TREAD, y_a + s * (k + 1) * TREAD)
                boxes.append((xa[0], ya, zf, xa[1], yb, zf + (k + 1) * r,
                              "stair"))
            zl = zf + n1 * r
            wall = Dp - T_OUT if s > 0 else T_OUT
            ya, yb = yy(y_b, wall)
            boxes.append((xa[0], ya, zl - 0.2, xb[1], yb, zl, "stair"))
            for k in range(n - n1):
                ya, yb = yy(y_b - s * k * TREAD, y_b - s * (k + 1) * TREAD)
                boxes.append((xb[0], ya, zl - 0.2, xb[1], yb,
                              zl + (k + 1) * r, "stair"))
            stairs.append(dict(floor=fi, steps=n, riser=r, tread=TREAD,
                               width=STAIR_W, landing_depth=abs(wall - y_b),
                               rise=rise))
    boxes.append((0, 0, ROOF - SLAB, L, Dp, ROOF, "roof"))
    return dict(boxes=boxes, doors=doors, stairs=stairs, geom=g, FL=FL,
                ROOF=ROOF)


def check(L, Dp, nfl):
    import numpy as np
    L, Dp, ed = variant(L, Dp)
    Lo = layout(L, Dp, nfl, ed)
    g, FL, ROOF = Lo["geom"], Lo["FL"], Lo["ROOF"]
    Y_S, Y_C, Y_N, XR = g["Y_S"], g["Y_C"], g["Y_N"], g["X_ROOMS"]
    s, y_a = g["s"], g["y_a"]
    bad = []
    chk = lambda name, ok: ok or bad.append(name)
    chk("corridor>=2.4", Y_C[1] - Y_C[0] >= 2.4 - 1e-9)
    short = min([Y_S[1] - Y_S[0], g["RW"]] + ([Y_N[1] - Y_N[0]] if Y_N else []))
    chk("room short side>=3.5", short >= 3.5)
    chk("ceiling>=3.4", min(d["clear"] for d in Lo["doors"]
                            if d["kind"] == "ceiling") >= 3.4)
    chk("camera under ceiling", all(
        zf + 2.56 < (FL + [ROOF])[i + 1] - SLAB - 0.2 for i, zf in enumerate(FL)))
    for st in Lo["stairs"]:
        chk("stair riser/landing", st["riser"] <= RISER_MAX and
            st["landing_depth"] >= 1.6)
    chk("corridor run>=5.0 (4.3 camera + margin)",
        (L - T_OUT) - (X_CORE[1] + T_IN) >= 5.0)
    res = 0.1
    nx, ny = int(L / res), int(Dp / res)
    X, Y = np.meshgrid((np.arange(nx) + .5) * res, (np.arange(ny) + .5) * res,
                       indexing="ij")
    for fi, zf in enumerate(FL):
        blocked = np.zeros((nx, ny), bool)
        for (x0, y0, z0, x1, y1, z1, role) in Lo["boxes"]:
            if role in ("slab", "roof") or z1 <= zf + 0.3 or z0 >= zf + BODY_H:
                continue
            if role == "stair" and z0 <= zf + 0.3:
                continue
            blocked |= ((X > x0 - BODY_R) & (X < x1 + BODY_R) &
                        (Y > y0 - BODY_R) & (Y < y1 + BODY_R))
        free = (~blocked & (X > T_OUT + BODY_R) & (X < L - T_OUT - BODY_R) &
                (Y > T_OUT + BODY_R) & (Y < Dp - T_OUT - BODY_R))
        if fi > 0:
            hole = (X < X_CORE[1]) & ((Y >= y_a) if s > 0 else (Y <= y_a))
            free &= ~hole
        seed = (int((X_CORE[1] + 1.0) / res), int(sum(Y_C) / 2 / res))
        seen = np.zeros_like(free)
        stack = [seed] if free[seed] else []
        while stack:
            i, j = stack.pop()
            if seen[i, j]:
                continue
            seen[i, j] = True
            for a, b in ((i + 1, j), (i - 1, j), (i, j + 1), (i, j - 1)):
                if 0 <= a < nx and 0 <= b < ny and free[a, b] and not seen[a, b]:
                    stack.append((a, b))
        tg = {}
        for xi, xr in enumerate(XR):
            for tag, ys in (("S", Y_S), ("N", Y_N)):
                if ys:
                    tg[f"r{xi}{tag}"] = (sum(xr) / 2, sum(ys) / 2)
        tg["stair"] = (1.4, y_a - s * 0.6)      # arrival side of the hole
        if ed and fi == 0:
            tg["street"] = (T_OUT + 0.6, (y_a + Dp - T_OUT) / 2)
        miss = [k for k, (tx, ty) in tg.items() if not seen[int(tx / res),
                                                            int(ty / res)]]
        if miss:
            bad.append(f"floor{fi} unreachable {miss}")
    return bad


def to_plan(face, rect, boxes):
    x0, y0, x1, y1 = rect

    def mp(u, v):
        if face == "S":
            return x0 + u, y0 + v
        if face == "N":
            return x1 - u, y1 - v
        if face == "W":
            return x0 + v, y1 - u
        return x1 - v, y0 + u          # E
    out = []
    for (a, b, z0, c, d, z1, role) in boxes:
        p, q = mp(a, b), mp(c, d)
        out.append([round(min(p[0], q[0]), 3), round(min(p[1], q[1]), 3),
                    round(z0, 3), round(max(p[0], q[0]), 3),
                    round(max(p[1], q[1]), 3), round(z1, 3), role])
    return out


def lots():
    here = os.getcwd()
    tmp = tempfile.mkdtemp()
    try:
        os.chdir(tmp)
        ns = runpy.run_path(os.path.join(os.path.dirname(
            os.path.abspath(__file__)), "plan.py"))
    finally:
        os.chdir(here)
        shutil.rmtree(tmp, ignore_errors=True)
    kinds = {(b["i"], b["j"]): b["kind"] for b in ns["blocks"]}
    out = []
    for n, b in enumerate(ns["buildings"]):
        if kinds[tuple(b["block"])] != "market" or n in SKIP_LOTS:
            continue
        r = b["rect"]
        ew, ns_ = r[2] - r[0], r[3] - r[1]
        along, depth = (ew, ns_) if b["face"] in "SN" else (ns_, ew)
        out.append(dict(id=n, face=b["face"], rect=r, floors=b["floors"],
                        L=round(along, 2), Dp=round(depth, 2)))
    return out


COLORS = {"shell": (0.82, 0.78, 0.70, 1), "partition": (0.90, 0.88, 0.84, 1),
          "slab": (0.45, 0.40, 0.34, 1), "stair": (0.60, 0.50, 0.38, 1),
          "roof": (0.55, 0.28, 0.18, 1)}


def build(out_base, data):
    import bpy
    import bmesh
    bpy.ops.wm.read_factory_settings(use_empty=True)
    mats = {}
    for role, col in COLORS.items():
        m = bpy.data.materials.new("bones_" + role)
        m.use_nodes = True
        b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        b.inputs["Base Color"].default_value = col
        b.inputs["Roughness"].default_value = 0.9
        mats[role] = m
    for lot in data:
        coll = bpy.data.collections.new(f"Bones_shop{lot['id']}")
        bpy.context.scene.collection.children.link(coll)
        for role in COLORS:
            bm = bmesh.new()
            for (x0, y0, z0, x1, y1, z1, r) in lot["boxes"]:
                if r != role:
                    continue
                bmesh.ops.create_cube(bm, size=1.0)
                for v in bm.verts[-8:]:
                    v.co.x = x0 if v.co.x < 0 else x1
                    v.co.y = y0 if v.co.y < 0 else y1
                    v.co.z = z0 if v.co.z < 0 else z1
            me = bpy.data.meshes.new(f"b{lot['id']}_{role}")
            bm.to_mesh(me)
            bm.free()
            ob = bpy.data.objects.new(f"shop{lot['id']}_{role}", me)
            ob.data.materials.append(mats[role])
            coll.objects.link(ob)
    bpy.ops.wm.save_as_mainfile(filepath=out_base + ".blend")
    bpy.ops.export_scene.gltf(filepath=out_base + ".glb", export_format="GLB")
    print("wrote", out_base, len(data), "lots")


def run_all():
    rows = []
    for lot in lots():
        bad = check(lot["L"], lot["Dp"], lot["floors"])
        rows.append((lot, bad))
    return rows


if __name__ == "__main__":
    if "--check" in sys.argv:
        rows = run_all()
        fails = [(l, b) for l, b in rows if b]
        for l, b in rows:
            print(("FAIL" if b else "ok  "), f"shop-{l['id']}", l["face"],
                  f"{l['L']}x{l['Dp']}", f"{l['floors']}fl", b or "")
        print(f"{len(rows) - len(fails)}/{len(rows)} pass")
        sys.exit(1 if fails else 0)
    if "--emit" in sys.argv:
        outp = sys.argv[sys.argv.index("--emit") + 1]
        data = []
        for lot in lots():
            if check(lot["L"], lot["Dp"], lot["floors"]):
                continue                 # fails the space rules
            L2, D2, ed = variant(lot["L"], lot["Dp"])
            Lo = layout(L2, D2, lot["floors"], ed)
            if ed:   # rotate back to street frame: x = Dp' - v', y = u'
                Lo["boxes"] = [(D2 - d, a, z0, D2 - b, c, z1, r)
                               for (a, b, z0, c, d, z1, r) in Lo["boxes"]]
            data.append(dict(id=lot["id"], face=lot["face"], rect=lot["rect"],
                             floors=lot["floors"], L=lot["L"], Dp=lot["Dp"],
                             FL=Lo["FL"], roof=Lo["ROOF"],
                             boxes=to_plan(lot["face"], lot["rect"],
                                           Lo["boxes"])))
        with open(outp, "w") as f:
            json.dump(data, f)
        print("emitted", len(data), "lots")
    if "--" in sys.argv:
        a = sys.argv[sys.argv.index("--") + 1:]
        build(a[0], json.load(open(a[1])))
