#!/usr/bin/env python3
"""Pilot B: one real building blockout with enclosed interiors, sized for the
tall cast (Tea House lesson: 1.5 m corridors / 1.0 m doors read as a closed box
under the 4.3 m back / 2.56 m up follow camera).

Target lot: shop-46, plan rect [-98.5,-122.5,-72.5,-110.5] (26 x 12 m, 3
floors, street on the south side). Local frame: x east 0..26, y north 0..12
(y=0 is the street wall), z up. layout() is pure python so the same numbers
feed the Blender build and the checks.

Run (from repo root):
  python3 tools/city3/pilotb_building.py --check
  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
      --python tools/city3/pilotb_building.py -- tools/city3/out/pilotb_shop46
"""
import json
import sys

W, D = 26.0, 12.0
T_OUT, T_IN = 0.35, 0.15
FLOORS = [0.0, 4.2, 8.0]        # slab tops; ground >=4.0, upper >=3.6
ROOF_Z = 11.8
SLAB = 0.25                      # slab thickness (below each level)
# y bands (clear): south rooms | corridor | north rooms
Y_S = (T_OUT, T_OUT + 4.3)                  # 0.35 .. 4.65
Y_C = (Y_S[1] + T_IN, Y_S[1] + T_IN + 2.4)  # 4.80 .. 7.20
Y_N = (Y_C[1] + T_IN, D - T_OUT)            # 7.35 .. 11.65
# x: stair core, then 3 rooms
X_CORE = (T_OUT, T_OUT + 4.0)               # 0.35 .. 4.35
RW = (W - T_OUT - (X_CORE[1] + T_IN) - 2 * T_IN) / 3.0   # 6.95
X_ROOMS = []
x = X_CORE[1] + T_IN
for _ in range(3):
    X_ROOMS.append((x, x + RW))
    x += RW + T_IN
DOOR_W, DOOR_H = 1.4, 2.8
STREET_W, STREET_H = 1.8, 3.0
WIN_W, WIN_H, WIN_SILL = 1.6, 1.6, 1.0
STAIR_W, TREAD, RISER_MAX = 1.6, 0.30, 0.18
BODY_R, BODY_H = 0.4, 1.8


def wall_x(y0, y1, x0, x1, z0, z1, role, openings=()):
    """Wall running along x between x0..x1, thickness y0..y1. openings are
    (a, b, zlo, zhi) in x. Returns boxes (x0,y0,z0,x1,y1,z1,role)."""
    out, cur = [], x0
    for a, b, zlo, zhi in sorted(openings):
        if a > cur:
            out.append((cur, y0, z0, a, y1, z1, role))
        if zlo > z0:
            out.append((a, y0, z0, b, y1, zlo, role))
        if zhi < z1:
            out.append((a, y0, zhi, b, y1, z1, role))
        cur = b
    if cur < x1:
        out.append((cur, y0, z0, x1, y1, z1, role))
    return out


def _wall_y(x0, x1, y0, y1, z0, z1, role, openings):
    """Wall running along y (thickness x0..x1); openings are (a, b, zlo, zhi)
    in y."""
    out, cur = [], y0
    for a, b, zlo, zhi in sorted(openings):
        if a > cur:
            out.append((x0, cur, z0, x1, a, z1, role))
        if zlo > z0:
            out.append((x0, a, z0, x1, b, zlo, role))
        if zhi < z1:
            out.append((x0, a, zhi, x1, b, z1, role))
        cur = b
    if cur < y1:
        out.append((x0, cur, z0, x1, y1, z1, role))
    return out


def layout():
    boxes, doors, stairs = [], [], []
    levels = FLOORS + [ROOF_Z]
    mid = lambda r: (r[0] + r[1]) / 2.0
    for fi, zf in enumerate(FLOORS):
        zc = levels[fi + 1] - SLAB          # underside of the slab above
        h_clear = zc - zf
        # --- slabs (top at level z, SLAB thick); stair opening above ground
        z_top = zf
        if fi == 0:
            boxes.append((0, 0, -0.5, W, D, 0.0, "slab"))
        else:
            # stair opening: core x, y >= 6.0 (see flights below)
            boxes.append((0, 0, z_top - SLAB, W, 6.0, z_top, "slab"))
            boxes.append((X_CORE[1] + T_IN * 0, 6.0, z_top - SLAB, W, D,
                          z_top, "slab"))
            boxes.append((0, 6.0, z_top - SLAB, X_CORE[0], D, z_top, "slab"))
        # --- outer shell: south (street) wall, north, west, east
        so = []
        if fi == 0:
            xm = mid(X_ROOMS[1])
            so.append((xm - STREET_W / 2, xm + STREET_W / 2, 0.0, STREET_H))
        for xr in X_ROOMS:
            xm = mid(xr)
            if fi == 0 and xr is X_ROOMS[1]:
                continue
            so.append((xm - WIN_W / 2, xm + WIN_W / 2, zf + WIN_SILL,
                       zf + WIN_SILL + WIN_H))
        no = [(mid(xr) - WIN_W / 2, mid(xr) + WIN_W / 2, zf + WIN_SILL,
               zf + WIN_SILL + WIN_H) for xr in X_ROOMS]
        boxes += wall_x(0, T_OUT, 0, W, zf, zc, "shell", so)
        boxes += wall_x(D - T_OUT, D, 0, W, zf, zc, "shell", no)
        boxes += _wall_y(0, T_OUT, 0, D, zf, zc, "shell", [])
        # east end of corridor: tall window so the corridor has daylight
        boxes += _wall_y(W - T_OUT, W, 0, D, zf, zc, "shell",
                         [(Y_C[0] + 0.2, Y_C[1] - 0.2, zf + 0.8, zf + 3.0)])
        # --- core wall (x 4.35..4.5) with a 2.4 wide opening to the corridor
        boxes += _wall_y(X_CORE[1], X_CORE[1] + T_IN, T_OUT, D - T_OUT, zf, zc,
                         "partition", [(Y_C[0], Y_C[1], zf, zf + 3.0)])
        doors.append(dict(floor=fi, kind="core", axis="y",
                          at=(X_CORE[1] + T_IN / 2, mid(Y_C)),
                          width=Y_C[1] - Y_C[0], height=3.0))
        # --- corridor walls (y partitions) with doors to each room
        for yy, ys, tag in ((Y_S[1], Y_S, "S"), (Y_C[1], Y_N, "N")):
            ops = []
            for xr in X_ROOMS:
                xm = mid(xr)
                w = 2.4 if (fi == 0 and tag == "S" and xr is X_ROOMS[1]) \
                    else DOOR_W
                ops.append((xm - w / 2, xm + w / 2, zf, zf + DOOR_H))
                doors.append(dict(floor=fi, kind="room-" + tag, axis="x",
                                  at=(xm, yy + T_IN / 2), width=w,
                                  height=DOOR_H))
            boxes += wall_x(yy, yy + T_IN, X_CORE[1] + T_IN, W - T_OUT, zf, zc,
                            "partition", ops)
        # --- room dividers (x partitions) both sides
        for xr in X_ROOMS[:2]:
            xp = xr[1]
            for ys in (Y_S, Y_N):
                boxes.append((xp, ys[0], zf, xp + T_IN, ys[1], zc,
                              "partition"))
        doors.append(dict(floor=fi, kind="ceiling", clear=h_clear))
        if fi == 0:
            doors.append(dict(floor=0, kind="street", axis="x",
                              at=(mid(X_ROOMS[1]), T_OUT / 2),
                              width=STREET_W, height=STREET_H))
        # --- stairs: switchback in the core, up to the next level
        if fi + 1 < len(FLOORS):
            rise = FLOORS[fi + 1] - zf
            n = int(round(rise / 0.175))
            n1 = n // 2
            r = rise / n
            tw = TREAD
            run = n1 * tw
            y_a = 6.0
            y_b = y_a + run
            xa = (0.55, 0.55 + STAIR_W)
            xb = (X_CORE[1] - 0.2 - STAIR_W, X_CORE[1] - 0.2)
            for k in range(n1):          # flight 1: +y, z rises from zf
                boxes.append((xa[0], y_a + k * tw, zf, xa[1],
                              y_a + (k + 1) * tw, zf + (k + 1) * r, "stair"))
            zl = zf + n1 * r
            boxes.append((xa[0], y_b, zl - 0.2, xb[1], D - T_OUT, zl, "stair"))
            for k in range(n - n1):      # flight 2: -y, arrives at y_a, z=next
                yk = y_b - k * tw
                boxes.append((xb[0], yk - tw, zl - 0.2, xb[1], yk,
                              zl + (k + 1) * r, "stair"))
            stairs.append(dict(floor=fi, steps=n, riser=r, tread=tw,
                               width=STAIR_W, landing_y=(y_b, D - T_OUT),
                               landing_depth=D - T_OUT - y_b,
                               flight1=(xa, y_a, y_b), flight2=(xb, y_b, y_a),
                               rise=rise, slab_open_y=(y_a, D)))
    # roof slab
    boxes.append((0, 0, ROOF_Z - SLAB, W, D, ROOF_Z, "roof"))
    return dict(boxes=boxes, doors=doors, stairs=stairs)


# ----------------------------- checks (pure numpy) -------------------------
def check(verbose=True):
    import numpy as np
    L = layout()
    res = []

    def rule(name, ok, val):
        res.append((name, bool(ok), val))

    corridor = Y_C[1] - Y_C[0]
    rule("corridor clear >= 2.4", corridor >= 2.4 - 1e-9, round(corridor, 2))
    rule("room short side >= 3.5",
         min(Y_S[1] - Y_S[0], Y_N[1] - Y_N[0], RW) >= 3.5,
         round(min(Y_S[1] - Y_S[0], Y_N[1] - Y_N[0], RW), 2))
    dw = [d["width"] for d in L["doors"] if "width" in d and
          d["kind"].startswith("room")]
    rule("room doors >= 1.4 x 2.8", min(dw) >= 1.4 and DOOR_H >= 2.8,
         (round(min(dw), 2), DOOR_H))
    rule("street door >= 1.8", STREET_W >= 1.8, STREET_W)
    ceil = [d["clear"] for d in L["doors"] if d["kind"] == "ceiling"]
    rule("ceiling clear >= 3.4 (ground 3.95)", min(ceil) >= 3.4,
         [round(c, 2) for c in ceil])
    rule("storey ground >= 4.0, upper >= 3.6",
         FLOORS[1] - FLOORS[0] >= 4.0 and FLOORS[2] - FLOORS[1] >= 3.6,
         [FLOORS[1] - FLOORS[0], FLOORS[2] - FLOORS[1]])
    for s in L["stairs"]:
        rule(f"stair f{s['floor']} width>=1.6 tread>=.28 riser<=.18 landing>=1.6",
             s["width"] >= 1.6 and s["tread"] >= 0.28 and
             s["riser"] <= RISER_MAX and s["landing_depth"] >= 1.6,
             (s["width"], s["tread"], round(s["riser"], 3),
              round(s["landing_depth"], 2)))
        # headroom: slab above flight 1 is open for y >= slab_open_y[0]; flight
        # 1 starts at y=6.0, so no slab sits over any step
        rule(f"stair f{s['floor']} headroom (slab opens over flight 1)",
             s["slab_open_y"][0] <= s["flight1"][1] + 1e-9, s["slab_open_y"])

    # --- reachability with a 0.8 m wide body, per floor, on a 0.1 m grid
    boxes = L["boxes"]
    res_ = 0.1
    nx, ny = int(W / res_), int(D / res_)
    gx = (np.arange(nx) + 0.5) * res_
    gy = (np.arange(ny) + 0.5) * res_
    X, Y = np.meshgrid(gx, gy, indexing="ij")
    for fi, zf in enumerate(FLOORS):
        blocked = np.zeros((nx, ny), bool)
        for (x0, y0, z0, x1, y1, z1, role) in boxes:
            if role in ("slab", "roof"):
                continue
            # obstacle to a walker standing on this floor: overlaps z span
            # [zf+0.3 (step-up), zf+BODY_H] (stairs are walked, not blocked,
            # when they start on this floor's level)
            if z1 <= zf + 0.3 or z0 >= zf + BODY_H:
                continue
            if role == "stair" and z0 <= zf + 0.3:
                continue
            blocked |= ((X > x0 - BODY_R) & (X < x1 + BODY_R) &
                        (Y > y0 - BODY_R) & (Y < y1 + BODY_R))
        # outside the building
        free = ~blocked & (X > T_OUT + BODY_R) & (X < W - T_OUT - BODY_R) & \
            (Y > T_OUT + BODY_R) & (Y < D - T_OUT - BODY_R)
        # above the ground floor the core area y>=6 has no slab: not standable
        if fi > 0:
            free &= ~((X < X_CORE[1]) & (Y >= 6.0))
        # flood fill from the corridor centre
        seed = (int((X_CORE[1] + 1.0) / res_), int(((Y_C[0] + Y_C[1]) / 2) / res_))
        seen = np.zeros_like(free)
        stack = [seed] if free[seed] else []
        while stack:
            i, j = stack.pop()
            if seen[i, j]:
                continue
            seen[i, j] = True
            for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                a, b = i + di, j + dj
                if 0 <= a < nx and 0 <= b < ny and free[a, b] and not seen[a, b]:
                    stack.append((a, b))
        targets = {}
        for xi, xr in enumerate(X_ROOMS):
            for tag, ys in (("S", Y_S), ("N", Y_N)):
                targets[f"room{xi}{tag}"] = ((xr[0] + xr[1]) / 2,
                                             (ys[0] + ys[1]) / 2)
        targets["stair-arrival"] = (1.4 if fi == 0 else 1.4, 5.5)
        bad = [k for k, (tx, ty) in targets.items()
               if not seen[int(tx / res_), int(ty / res_)]]
        rule(f"floor {fi}: all 6 rooms + stair foot reachable, 0.8 m body",
             not bad, bad or "ok")
    # --- follow-camera: 4.3 m behind, 2.56 m above feet, walking +x
    cam_bad = []
    for fi, zf in enumerate(FLOORS):
        zc = (FLOORS + [ROOF_Z])[fi + 1] - SLAB
        if zf + 2.56 >= zc - 0.2:
            cam_bad.append((fi, "ceiling"))
    rule("follow camera (2.56 m up) clears ceiling on every floor",
         not cam_bad, cam_bad or "ok")
    # camera run-up: corridor length behind body once past x = 4.5 + 4.3
    run = (W - T_OUT) - (X_CORE[1] + T_IN)
    rule("corridor run >= 4.3 behind body + walking room", run >= 4.3 + 8,
         round(run, 1))
    ok = all(r[1] for r in res)
    if verbose:
        for n, o, v in res:
            print(("PASS " if o else "FAIL ") + n, v)
        print("ALL PASS" if ok else "FAILURES")
    return ok


# ----------------------------- Blender build -------------------------------
COLORS = {"shell": (0.82, 0.78, 0.70, 1), "partition": (0.90, 0.88, 0.84, 1),
          "slab": (0.45, 0.40, 0.34, 1), "stair": (0.60, 0.50, 0.38, 1),
          "roof": (0.55, 0.28, 0.18, 1)}


def build(out_base):
    import bpy
    import bmesh
    bpy.ops.wm.read_factory_settings(use_empty=True)
    L = layout()
    mats = {}
    for role, col in COLORS.items():
        m = bpy.data.materials.new("pb_" + role)
        m.use_nodes = True
        bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        bsdf.inputs["Base Color"].default_value = col
        bsdf.inputs["Roughness"].default_value = 0.9
        mats[role] = m
    coll = bpy.data.collections.new("Shop46_Bones")
    bpy.context.scene.collection.children.link(coll)
    for role in COLORS:
        bm = bmesh.new()
        for (x0, y0, z0, x1, y1, z1, r) in L["boxes"]:
            if r != role:
                continue
            bmesh.ops.create_cube(bm, size=1.0)
            vs = bm.verts[-8:]
            for v in vs:
                v.co.x = x0 if v.co.x < 0 else x1
                v.co.y = y0 if v.co.y < 0 else y1
                v.co.z = z0 if v.co.z < 0 else z1
        me = bpy.data.meshes.new("pb_" + role)
        bm.to_mesh(me)
        bm.free()
        ob = bpy.data.objects.new("Shop46_" + role, me)
        ob.data.materials.append(mats[role])
        coll.objects.link(ob)
    bpy.ops.wm.save_as_mainfile(filepath=out_base + ".blend")
    bpy.ops.export_scene.gltf(filepath=out_base + ".glb", export_format="GLB")
    with open(out_base + ".json", "w") as f:
        json.dump({k: L[k] for k in ("doors", "stairs")}, f, default=list,
                  indent=1)
    print("wrote", out_base)


if __name__ == "__main__":
    if "--check" in sys.argv:
        sys.exit(0 if check() else 1)
    if "--" in sys.argv:
        build(sys.argv[sys.argv.index("--") + 1])
