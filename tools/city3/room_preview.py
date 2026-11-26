"""Compose rooms from layout JSON + the library GLB, and export them as GLBs.

    blender -b --factory-startup --python tools/city3/room_preview.py -- \\
        [--rooms shop-44,press | --all] [--index out/interiors/index.json] \\
        [--lib apps/console/public/assets/world-city3-library.glb] [--out out/rooms]

Why: every room in the shipped world is a layout JSON plus instanced library
nodes, so a room has no GLB of its own. Without one you cannot render it, dim it,
or diff it -- you can only audit the JSON and hope. This composes the room the way
the runtime does: linked duplicates of the LIB_ nodes at the layout's coordinates
and rotY, which keeps one mesh datablock per asset (fast, and the export is one
node per instance).

Space conversion (docs 03): layout props are three.js `[key, x, y, z, rotY, scale]`,
Blender is (x, y_up -> z, depth -> -z). So Blender = (x, -z, y) and the layout's
rotY is a Blender rotation about Z by the same angle.

Then preview one with the existing measured-framing tool:
    ENGINE=BLENDER_WORKBENCH blender -b --factory-startup --python \\
        tools/city3/preview_multi.py -- out/rooms/shop-44.glb /tmp/pv front threequarter
"""
import json
import math
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(f"{HERE}/../..")
ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, default=None):
    for i, a in enumerate(ARGS):
        if a == "--" + name and i + 1 < len(ARGS):
            return ARGS[i + 1]
        if a.startswith("--" + name + "="):
            return a.split("=", 1)[1]
    return default


INDEX = arg("index", f"{HERE}/out/interiors/index.json")
LIBS = [p for p in arg("lib", f"{ROOT}/apps/console/public/assets/world-city3-library.glb").split(",") if p]
OUT = arg("out", f"{HERE}/out/rooms")
ALL = "--all" in ARGS
WANT = [r for r in (arg("rooms") or "").split(",") if r]


def load_library(paths):
    """Import one or more libraries; FIRST wins per key, as the runtime's indexLibrary does.

    `--lib a.glb,b.glb` lets an override library (world-city3-hq.glb) shadow a base
    key without editing either file or any layout JSON.
    """
    bpy.ops.wm.read_factory_settings(use_empty=True)
    lib = {}
    for p in paths:
        bpy.ops.import_scene.gltf(filepath=p)
        for o in bpy.data.objects:
            if o.name.startswith("LIB_"):
                lib.setdefault(o.name[4:], o)
    return lib


def clone_tree(src, col):
    """Copy `src` and its whole subtree into `col`, preserving local transforms.

    Six LIB_ nodes (tea_cake, tea_chair, tea_lantern, tea_menu, tea_service,
    tea_table) carry no mesh of their own -- the geometry hangs off children -- so
    copying just the node would export an empty. The root keeps its world transform
    for the layout to overwrite; children keep their parent-relative one.
    """
    c = src.copy()
    col.objects.link(c)
    for ch in src.children:
        cc = clone_tree(ch, col)
        cc.parent = c
        cc.matrix_parent_inverse = ch.matrix_parent_inverse.copy()
        cc.matrix_basis = ch.matrix_basis.copy()
    return c


def compose(room, props, lib):
    """Instantiate one room's props; returns (instances, missing_keys)."""
    col = bpy.data.collections.new(room["id"])
    bpy.context.scene.collection.children.link(col)
    made, missing = [], []
    for p in props:
        key, x, y, z, rot, scale = p[:6]
        src = lib.get(key)
        if src is None:
            missing.append(key)
            continue
        inst = clone_tree(src, col)             # shares mesh/materials with the library
        inst.name = f"{room['id']}:{key}"
        inst.location = (x, -z, y)
        inst.rotation_mode = "XYZ"
        inst.rotation_euler = (0.0, 0.0, rot)
        inst.scale = (scale, scale, scale)
        made.append(inst)
    # Drop the library originals: instances keep the mesh datablocks alive, and
    # leaving them in would export all 76 assets stacked at the origin.
    keep = {o.name for o in made} | {c.name for i in made for c in i.children_recursive}
    for o in list(bpy.data.objects):
        if o.name not in keep:
            bpy.data.objects.remove(o, do_unlink=True)
    return made, missing



def export(room_id, path):
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_yup=True,
                              export_apply=True, export_image_format="JPEG",
                              export_animations=False, use_selection=False)


def main():
    idx = json.load(open(INDEX))
    want = {r["id"]: r for r in idx} if ALL else {r["id"]: r for r in idx if r["id"] in WANT}
    if not want:
        sys.exit("usage: room_preview.py -- --rooms shop-44,press | --all [--out DIR]")
    lib = load_library(LIBS)
    os.makedirs(OUT, exist_ok=True)
    print(f"LIB {', '.join(os.path.basename(x) for x in LIBS)}  {len(lib)} LIB_ nodes  "
          f"ROOMS {len(want)}")
    for rid, room in want.items():
        bpy.ops.wm.read_factory_settings(use_empty=True)
        lib = load_library(LIBS)              # fresh scene per room: instances must not leak
        lay = json.load(open(f"{HERE}/out/interiors/{rid}.json"))
        props = lay.get("props", [])
        made, missing = compose(room, props, lib)
        path = os.path.join(OUT, f"{rid}.glb")
        export(rid, path)
        print(f"  {rid:10s} props {len(props):4d} instanced {len(made):4d} "
              f"missing {len(missing)}  {os.path.getsize(path) // 1024} KB"
              + (f"  MISSING {sorted(set(missing))}" if missing else ""))
    print("ALL OK")


if __name__ == "__main__":
    main()
