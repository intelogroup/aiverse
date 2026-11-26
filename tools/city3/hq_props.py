"""Procedural high-poly sources for the props that have no usable scan.

    blender -b --factory-startup --python tools/city3/hq_props.py -- [--out out/hq-src]

Why this exists: `lantern_hang`, `counter_2m` and `booth_2m` are 16-28 triangle boxes
in the shipped library, and every downloaded candidate for them is a whole *scene*
(`int-pendant-bell` is 9 x 9 x 33 m, `int-kitchen-island` 11.6 x 8.9 m), so rescaling
one is nonsense. Building them procedurally keeps the licence clean, the size exact
and the triangle count predictable -- these are furniture, not hero assets.

Each prop is authored at its pinned library dims, front = -Y (the library contract:
Blender -Y becomes glTF +Z), origin at bottom centre, real metres. `hq_library.py`
then imports these like any other source and re-checks the dims.

Detail budget, not tessellation: a counter reads better with a plinth, a recessed
panel run and a bevelled top than with 5,000 triangles of a flat box.
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = next((a.split("=", 1)[1] for a in ARGS if a.startswith("--out=")),
           os.path.join(HERE, "out/hq-src"))


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def bevel(ob, width=0.008, segments=2):
    if width <= 0:
        return
    mod = ob.modifiers.new("bev", "BEVEL")
    mod.width, mod.segments = width, segments
    mod.limit_method = "ANGLE"
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.modifier_apply(modifier=mod.name)


def box(c, s, bevel_w=0.008, name="part"):
    """Axis-aligned box from centre c and size s, optionally bevelled."""
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=c)
    ob = bpy.context.object
    ob.scale = s
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    ob.name = name
    bevel(ob, bevel_w)
    return ob


def cyl(c, r, h, verts=12, bevel_w=0.0, name="part"):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=h, vertices=verts, location=c)
    ob = bpy.context.object
    ob.name = name
    bevel(ob, bevel_w)
    return ob


def cone(c, r1, r2, h, verts=12, name="part"):
    bpy.ops.mesh.primitive_cone_add(radius1=r1, radius2=r2, depth=h, vertices=verts,
                                    location=c)
    ob = bpy.context.object
    ob.name = name
    return ob


def join(parts, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = ob.data.name = name
    return ob


def export(ob, path):
    bpy.ops.object.select_all(action="DESELECT")
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True,
                              export_apply=True, export_yup=True, export_animations=False)


def build_counter():
    """2.0 m bar counter: plinth, carcass, bevelled top, three recessed panels, kick rail.

    Authored 1.998 m wide on purpose: the layout packs counters on a 2.0 m pitch, so a
    2.1 m lip (the shipped asset) overlaps its neighbour by 0.10 m with coincident top
    faces. This override is the fixed width without waiting for a library rebuild.
    """
    w = 1.998
    parts = [
        box((0, 0, 0.03), (1.88, 0.84, 0.06), 0.0, "plinth"),
        box((0, 0, 0.555), (1.96, 0.90, 0.99), 0.012, "carcass"),
        box((0, 0, 1.085), (w, 1.14, 0.07), 0.008, "top"),
        box((0, -0.465, 0.11), (1.96, 0.03, 0.10), 0.0, "kick"),
    ]
    # three recessed front panels (one per 0.6 m bay)
    for i in (-1, 0, 1):
        parts.append(box((i * 0.63, -0.458, 0.575), (0.50, 0.02, 0.70), 0.006,
                         f"panel{i}"))
    return join(parts, "counter_2m")


def build_booth():
    """2.0 m window booth: plinth, upholstered seat, back cushion, two arms."""
    parts = [
        box((0, -0.50, 0.10), (1.96, 0.98, 0.20), 0.0, "plinth"),
        box((0, -0.52, 0.28), (2.0, 1.02, 0.24), 0.02, "seatbase"),
        box((0, -0.53, 0.475), (1.99, 1.0, 0.15), 0.03, "seatcushion"),
        box((0, -0.09, 0.755), (2.0, 0.18, 0.39), 0.03, "backcushion"),
        box((-0.985, -0.55, 0.55), (0.03, 0.95, 0.30), 0.01, "armL"),
        box((0.985, -0.55, 0.55), (0.03, 0.95, 0.30), 0.01, "armR"),
    ]
    return join(parts, "booth_2m")


def build_lantern():
    """0.4 m pendant lantern: cord, cap, 8-sided drum body, bottom finial."""
    parts = [
        cyl((0, 0, 0.80), 0.006, 0.90, 10, 0.0, "cord"),
        cone((0, 0, 0.365), 0.075, 0.018, 0.07, 12, "cap"),
        cyl((0, 0, 0.21), 0.20, 0.24, 8, 0.008, "drum"),
        cone((0, 0, 0.075), 0.035, 0.0, 0.05, 10, "finial"),
    ]
    return join(parts, "lantern_hang")


def tri_count(ob):
    ob.data.calc_loop_triangles()
    return len(ob.data.loop_triangles)


def main():
    os.makedirs(OUT, exist_ok=True)
    for key, fn in (("counter_2m", build_counter), ("booth_2m", build_booth),
                    ("lantern_hang", build_lantern)):
        reset()
        ob = fn()
        path = os.path.join(OUT, f"{key}.glb")
        export(ob, path)
        pts = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
        dims = [round(max(p[i] for p in pts) - min(p[i] for p in pts), 3) for i in range(3)]
        print(f"  {key:14s} tris {tri_count(ob):5d}  dims {dims}  "
              f"{os.path.getsize(path) // 1024} KB")
    print("ALL OK")


if __name__ == "__main__":
    main()

