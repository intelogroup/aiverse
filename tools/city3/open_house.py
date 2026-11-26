"""Open a solid-placed prebuilt house: cut its front door leaf out and derive interior collision (walls + furniture) from the mesh itself.

  tools/city3/blender_lock.sh -b --python tools/city3/open_house.py -- SRC.glb OUT_DIR --scale=1 [--cut=x0,x1,y0,y1,z0,z1[;...]]
      [--clear=x0,x1,z0,z1[;...]] [--doors] [--floor=auto|metres] [--res=0.1] [--slices=0.35,1.0,1.6] [--selftest]

Frame (what place_house.mjs builds, before its floor sink): metres, footprint centre at x/z 0, lowest point y 0, glTF axes (y up, +z = front).
Writes OUT_DIR/open.glb (the model in that frame at scale 1, door leaves removed: feed it to place_house.mjs with --scale=1) and
OUT_DIR/col_local.json {floor, size, top, boxes: [[cx, cz, hx, hz]], floor_boxes: [[cx, cz, hx, hz]]} in that frame: walls and furniture
(blocking up to `top` above the floor) and the walkable floor. place_house.mjs --colboxes=col_local.json bakes both into the house's shared,
always-loaded collision GLB in place of the closed shell.

Collision: the mesh is bisected at --slices metres above the floor; every slice segment is rasterised on a --res grid, the slices are
OR-ed (a wall or a sofa at any of those heights blocks), and the blocked cells are merged greedily into axis-aligned boxes. A --cut box
removes every loose part whose bounds lie wholly inside it (a closed door leaf, its frame-free panel), so the doorway is empty both to the
eye and to the slices. Rugs and floor trim sit under the lowest slice and never block."""
import sys
import json
import os

import bmesh
import bpy
import numpy as np
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
pos = [a for a in argv if not a.startswith("--")]
opt = dict(a[2:].split("=", 1) if "=" in a else (a[2:], "1") for a in argv if a.startswith("--"))


def raster_boxes(segs, x0, z0, nx, nz, res):
    """Segments [(ax, az, bx, bz)] -> blocked grid -> greedy boxes [(cx, cz, hx, hz)] in metres."""
    g = np.zeros((nz, nx), bool)
    for ax, az, bx, bz in segs:
        n = max(2, int(np.hypot(bx - ax, bz - az) / (res * 0.5)) + 1)
        t = np.linspace(0, 1, n)
        i = np.clip(((ax + (bx - ax) * t - x0) / res).astype(int), 0, nx - 1)
        j = np.clip(((az + (bz - az) * t - z0) / res).astype(int), 0, nz - 1)
        g[j, i] = True
    return g, greedy(g, x0, z0, res)


def fill_holes(m):
    """Cells not reachable from the border through ~m become True (the floor under a table or a sofa has no down-ray hit of its own)."""
    from collections import deque
    out = np.zeros_like(m)
    q = deque((j, i) for j in range(m.shape[0]) for i in (0, m.shape[1] - 1) if not m[j, i])
    q.extend((j, i) for i in range(m.shape[1]) for j in (0, m.shape[0] - 1) if not m[j, i])
    for p in q:
        out[p] = True
    while q:
        j, i = q.popleft()
        for a, b in ((j + 1, i), (j - 1, i), (j, i + 1), (j, i - 1)):
            if 0 <= a < m.shape[0] and 0 <= b < m.shape[1] and not m[a, b] and not out[a, b]:
                out[a, b] = True
                q.append((a, b))
    return ~out


def greedy(g, x0, z0, res):
    """Blocked grid -> greedy axis-aligned boxes [(cx, cz, hx, hz)] covering exactly the True cells."""
    boxes, used = [], np.zeros_like(g)
    nz, nx = g.shape
    for j in range(nz):
        i = 0
        while i < nx:
            if not g[j, i] or used[j, i]:
                i += 1
                continue
            i1 = i
            while i1 + 1 < nx and g[j, i1 + 1] and not used[j, i1 + 1]:
                i1 += 1
            j1 = j
            while j1 + 1 < nz and g[j1 + 1, i:i1 + 1].all() and not used[j1 + 1, i:i1 + 1].any():
                j1 += 1
            used[j:j1 + 1, i:i1 + 1] = True
            boxes.append(((x0 + (i + i1 + 1) * res / 2), (z0 + (j + j1 + 1) * res / 2), (i1 - i + 1) * res / 2, (j1 - j + 1) * res / 2))
            i = i1 + 1
    return boxes


def selftest():
    # an L of two walls and a free square: 2 boxes, covering exactly the wall cells, the room stays free
    g, b = raster_boxes([(0, 0, 2, 0), (0, 0, 0, 2)], -0.05, -0.05, 22, 22, 0.1)
    covered = np.zeros_like(g)
    for cx, cz, hx, hz in b:
        i0, i1 = int(round((cx - hx + 0.05) / 0.1)), int(round((cx + hx + 0.05) / 0.1))
        j0, j1 = int(round((cz - hz + 0.05) / 0.1)), int(round((cz + hz + 0.05) / 0.1))
        covered[j0:j1, i0:i1] = True
    assert (covered == g).all(), "boxes must cover exactly the blocked cells"
    assert len(b) == 2 and not g[10, 10], (len(b), g[10, 10])
    ring = np.zeros((7, 7), bool)
    ring[1, 1:6] = ring[5, 1:6] = ring[1:6, 1] = ring[1:6, 5] = True
    f = fill_holes(ring)
    assert f[3, 3] and f[1, 1] and not f[0, 0] and f.sum() == 25, f.sum()
    print("selftest PASS")


if "selftest" in opt:
    selftest()
    sys.exit(0)

src, out = pos[0], pos[1]
S, RES = float(opt.get("scale", 1)), float(opt.get("res", 0.1))
SLICES = [float(v) for v in opt.get("slices", "0.35,1.0,1.6").split(",")]
os.makedirs(out, exist_ok=True)
bpy.ops.wm.read_homefile(use_empty=True)
sc = bpy.context.scene
bpy.ops.import_scene.gltf(filepath=src)
meshes = [o for o in sc.objects if o.type == "MESH"]
# bake every transform and the scale into the vertices, so the frame below is plain metres
bpy.ops.object.select_all(action="DESELECT")
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
for o in meshes:
    o.scale = [v * S for v in o.scale]
    o.location = o.location * S
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
for o in [o for o in sc.objects if o.type != "MESH"]:
    bpy.data.objects.remove(o)
pts = np.array([v.co[:] for o in meshes for v in o.data.vertices])
lo, hi = pts.min(0), pts.max(0)
shift = Vector((-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]))   # Blender z up: footprint centre, lowest point 0
for o in meshes:
    o.data.transform(__import__("mathutils").Matrix.Translation(shift))
    o.data.update()
W, D, H = (hi - lo)
if "doors" in opt:   # list door-leaf-sized loose parts (thin, 1.7-2.6 m tall, 0.6-1.6 m wide) with a padded --cut box each, front-most first
    found = []
    for o in meshes:
        bm = bmesh.new()
        bm.from_mesh(o.data)
        seen = set()
        for v in bm.verts:
            if v.index in seen:
                continue
            part, stack = [], [v]
            seen.add(v.index)
            while stack:
                u = stack.pop()
                part.append(u.co.copy())
                for e in u.link_edges:
                    w = e.other_vert(u)
                    if w.index not in seen:
                        seen.add(w.index)
                        stack.append(w)
            p = np.array([(c.x, c.z, -c.y) for c in part])   # glTF frame
            a, b = p.min(0), p.max(0)
            dx, dy, dz = b - a
            if 1.7 <= dy <= 2.6 and a[1] < 1.5 and min(dx, dz) < 0.2 and 0.6 <= max(dx, dz) <= 1.6:
                found.append((b[2], o.name, a, b))
        bm.free()
    for _, name, a, b in sorted(found, key=lambda t: -t[0]):
        print(f"DOOR {name}: x {a[0]:.2f}..{b[0]:.2f} y {a[1]:.2f}..{b[1]:.2f} z {a[2]:.2f}..{b[2]:.2f}  "
              f"--cut={a[0]-.05:.2f},{b[0]+.05:.2f},{a[1]-.05:.2f},{b[1]+.05:.2f},{a[2]-.1:.2f},{b[2]+.1:.2f}")
    print(f"FRAME {W:.2f} x {D:.2f} x {H:.2f} m, {len(found)} door candidates")
    sys.exit(0)
# --cut boxes are given in the glTF frame (x, y up, z front); Blender is (x, -z, y)
removed = 0
for spec in [c for c in opt.get("cut", "").split(";") if c]:
    x0, x1, y0, y1, z0, z1 = map(float, spec.split(","))
    for o in meshes:
        bm = bmesh.new()
        bm.from_mesh(o.data)
        bm.verts.ensure_lookup_table()
        seen, kill = set(), []
        for v in bm.verts:
            if v.index in seen:
                continue
            part, stack = [], [v]
            seen.add(v.index)
            while stack:
                u = stack.pop()
                part.append(u)
                for e in u.link_edges:
                    w = e.other_vert(u)
                    if w.index not in seen:
                        seen.add(w.index)
                        stack.append(w)
            if all(x0 <= p.co.x <= x1 and y0 <= p.co.z <= y1 and z0 <= -p.co.y <= z1 for p in part):
                kill.extend(part)
        if kill:
            removed += len(kill)
            bmesh.ops.delete(bm, geom=kill, context="VERTS")
            bm.to_mesh(o.data)
        bm.free()
print(f"CUT removed {removed} vertices")
# place_house.mjs centres on the bounds of open.glb, i.e. after the cut: re-centre if the cut took an extreme part, or every box would shift
pts = np.array([v.co[:] for o in meshes for v in o.data.vertices])
lo, hi = pts.min(0), pts.max(0)
re = Vector((-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]))
if re.length > 0.005:
    print(f"RECENTRE after cut by {tuple(round(v, 3) for v in re)}")
    for o in meshes:
        o.data.transform(__import__("mathutils").Matrix.Translation(re))
        o.data.update()
W, D, H = (hi - lo)

dg = bpy.context.evaluated_depsgraph_get()
if opt.get("floor", "auto") == "auto":   # the most common hit height of down rays over the footprint interior
    hits = []
    for a in np.linspace(-W / 2, W / 2, 16)[1:-1]:
        for b in np.linspace(-D / 2, D / 2, 16)[1:-1]:
            ok, loc, *_ = sc.ray_cast(dg, Vector((a, b, 2.6)), Vector((0, 0, -1)))
            if ok:
                hits.append(round(loc.z, 2))
    vals, cnt = np.unique(hits, return_counts=True)
    FLOOR = float(vals[cnt.argmax()])
else:
    FLOOR = float(opt["floor"])

segs = []
for h in SLICES:
    co, no = Vector((0, 0, FLOOR + h)), Vector((0, 0, 1))
    for o in meshes:
        bm = bmesh.new()
        bm.from_mesh(o.data)
        r = bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=co, plane_no=no)
        for e in r["geom_cut"]:
            if isinstance(e, bmesh.types.BMEdge):
                a, b = e.verts[0].co, e.verts[1].co
                segs.append((a.x, -a.y, b.x, -b.y))   # glTF x, z
        bm.free()
nx, nz = int(np.ceil(W / RES)) + 2, int(np.ceil(D / RES)) + 2
grid, boxes = raster_boxes(segs, -W / 2 - RES, -D / 2 - RES, nx, nz, RES)
# --clear=x0,x1,z0,z1[;...]: free those cells. A real 0.9 m door is narrower than the navmesh needs (body 0.4 m + 5 cm margin each side,
# 0.15 m voxels): clear ~1.3 m across the jambs so routes pass; the frame stays visible and a body may brush it
if opt.get("clear"):
    for spec in opt["clear"].split(";"):
        x0, x1, z0, z1 = map(float, spec.split(","))
        i0, i1 = int((x0 + W / 2 + RES) / RES), int(np.ceil((x1 + W / 2 + RES) / RES))
        j0, j1 = int((z0 + D / 2 + RES) / RES), int(np.ceil((z1 + D / 2 + RES) / RES))
        grid[max(0, j0):j1, max(0, i0):i1] = False
    boxes = greedy(grid, -W / 2 - RES, -D / 2 - RES, RES)
top = max(SLICES) + 0.4
# walkable floor: down rays started under the ceiling that land within 0.15 m of the floor height; holes under furniture filled
floor = np.zeros_like(grid)
for j in range(nz):
    for i in range(nx):
        a, b = -W / 2 - RES + (i + 0.5) * RES, -D / 2 - RES + (j + 0.5) * RES
        ok, loc, *_ = sc.ray_cast(dg, Vector((a, -b, FLOOR + 1.2)), Vector((0, 0, -1)))
        floor[j, i] = ok and abs(loc.z - FLOOR) < 0.15
floor = fill_holes(floor)
fboxes = greedy(floor, -W / 2 - RES, -D / 2 - RES, RES)
r3 = lambda v: round(float(v), 3)
col = dict(floor=round(FLOOR, 3), size=[round(float(W), 2), round(float(H), 2), round(float(D), 2)], res=RES, slices=SLICES, top=round(top, 2),
           boxes=[[r3(cx), r3(cz), r3(hx), r3(hz)] for cx, cz, hx, hz in boxes], floor_boxes=[[r3(cx), r3(cz), r3(hx), r3(hz)] for cx, cz, hx, hz in fboxes])
json.dump(col, open(f"{out}/col_local.json", "w"))
np.save(f"{out}/grid.npy", grid)
np.save(f"{out}/floor.npy", floor)
bpy.ops.export_scene.gltf(filepath=f"{out}/open.glb", export_format="GLB", export_yup=True, export_apply=True)
print(f"OPEN {os.path.basename(os.path.dirname(src))}: {W:.2f} x {D:.2f} x {H:.2f} m, floor {FLOOR:.2f}, {len(segs)} slice segments, "
      f"{int(grid.sum())} blocked cells, {len(boxes)} boxes, {int(floor.sum())} floor cells in {len(fboxes)} boxes")
