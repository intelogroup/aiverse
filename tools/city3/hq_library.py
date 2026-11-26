"""Build a drop-in high-poly replacement library for the low-poly City 3 props.

    blender -b --factory-startup --python tools/city3/hq_library.py -- \
        --map tools/city3/out/hq-map.json [--out out/world-city3-hq.glb] [--dry]

Why an override library instead of editing world-city3-library.glb: the runtime's
`indexLibrary` keeps the FIRST node per key (`!out.has(key)`), so a library loaded
before the base one shadows a key without touching a layout JSON -- and without the
import->export round trip that was measured to drop 3 nodes / 4 materials / 6 images
from the shipped 8 MB library.

Map entry per key:
    "<key>": {"src": "<glb|gltf>", "budget": 2500, "yaw": 90}
`budget` is triangles AFTER decimation, sized from the instance count: chair_wood
has 382 instances, so a 16k scan becomes 6.4M tris while the whole world is 2.65M.
`yaw` turns the asset's front toward +Z (library contract) -- check it on a render,
do not assume it.

Target dims come from the pinned out/world-library-dims.json and are enforced per
axis, so collision boxes, seat anchors and layout placement stay valid.
Objects are named LIB_<key>, origin at bottom centre, real metres.
"""
import json
import os
import sys

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, default=None):
    for i, a in enumerate(ARGS):
        if a == "--" + name and i + 1 < len(ARGS):
            return ARGS[i + 1]
        if a.startswith("--" + name + "="):
            return a.split("=", 1)[1]
    return default


MAP = arg("map", f"{HERE}/out/hq-map.json")
OUT = arg("out", f"{HERE}/out/world-city3-hq.glb")
PINS = arg("pins", f"{HERE}/out/world-library-dims.json")
DRY = "--dry" in ARGS


def slim_images(max_px=256):
    """Cap every imported image so a 3-prop override does not outweigh the library.

    The first build shipped 11 MB for three props because each scan carried a 1k
    texture set; these are 0.4-2 m props seen from 1-3 m, so 256 px is plenty and
    the whole override lands near 1 MB.
    """
    for im in bpy.data.images:
        try:
            w, h = im.size
        except (TypeError, ValueError):
            continue
        if not w or not h or max(w, h) <= max_px:
            continue
        k = max_px / max(w, h)
        im.scale(max(1, round(w * k)), max(1, round(h * k)))


def tri_count(ob):
    ob.data.calc_loop_triangles()
    return len(ob.data.loop_triangles)


def import_join(path, node=None):
    """Import a source file and join every mesh into one object, transforms applied.

    `node` picks one subtree out of a multi-object file, which lets the base library
    itself be a source (LIB_wooden_bookshelf_worn -> LIB_shelf_goods): those props are
    already normalized, licensed and decimated to a budget, unlike the raw scans in
    city3-downloads, several of which are whole scenes (int-pendant-bell is 9 x 9 x 33 m).
    """
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    if node:
        root = bpy.data.objects.get(node)
        if root is None:
            cands = [o for o in bpy.data.objects if o.name.split(".")[0] == node]
            root = cands[0] if cands else None
        if root is None:
            raise SystemExit(f"node {node} not found in {path}")
        keep = {root} | set(root.children_recursive)
        for o in list(bpy.data.objects):
            if o not in keep:
                bpy.data.objects.remove(o, do_unlink=True)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        raise SystemExit(f"no meshes in {path}" + (f" under {node}" if node else ""))
    bpy.ops.object.select_all(action="DESELECT")
    for o in bpy.context.scene.objects:
        o.select_set(o.type in {"MESH", "EMPTY"})
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return ob


def decimate_to(ob, budget):
    """Collapse-decimate toward `budget` triangles (UVs preserved)."""
    before = tri_count(ob)
    if budget and before > budget:
        mod = ob.modifiers.new("dec", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = max(0.01, budget / before)
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return before, tri_count(ob)


def box(ob):
    bpy.context.view_layer.update()
    pts = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    return (Vector((min(p[i] for p in pts) for i in range(3))),
            Vector((max(p[i] for p in pts) for i in range(3))))


def fit(ob, target_dims, yaw):
    """Yaw, scale per axis to the pinned dims, then move origin to bottom centre.

    The yaw is baked with `mesh.transform`, not `rotation_euler`: a glTF import comes
    in QUATERNION mode, where assigning rotation_euler writes a field nobody reads
    (measured again here — a 90 deg chair yaw was a no-op until this changed).
    """
    if yaw:
        ob.data.transform(Matrix.Rotation(yaw * 3.141592653589793 / 180.0, 4, "Z"))
    lo, hi = box(ob)
    size = hi - lo
    ob.scale = [target_dims[i] / size[i] if size[i] > 1e-6 else 1.0 for i in range(3)]
    bpy.ops.object.select_all(action="DESELECT")
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    lo, hi = box(ob)
    ob.location = (-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -lo.z)
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    lo, hi = box(ob)
    return [round(float(v), 3) for v in (hi - lo)]


def main():
    if not os.path.exists(MAP):
        sys.exit(f"missing map {MAP}")
    pins = json.load(open(PINS))["props"]
    spec = json.load(open(MAP))
    rows, parts = [], []
    for key, cfg in spec.items():
        if key.startswith("_"):
            continue                       # map annotations
        node = "LIB_" + key
        if node not in pins:
            print(f"  SKIP {key}: not in {os.path.basename(PINS)}")
            continue
        want = pins[node]
        if DRY:
            print(f"  DRY  {key:18s} {os.path.basename(cfg['src']):28s} "
                  f"budget {cfg.get('budget')}  pin {want}")
            continue
        ob = import_join(cfg["src"], cfg.get("node"))
        before, after = decimate_to(ob, cfg.get("budget"))
        got = fit(ob, want, cfg.get("yaw", 0))
        slim_images(int(arg("tex", 256)))
        off = max(abs(got[i] - want[i]) / max(want[i], 1e-6) for i in range(3))
        if off > 0.005:
            raise SystemExit(f"{key}: fitted dims {got} vs pin {want} ({off * 100:.1f}% off) "
                             f"— collision boxes and anchors depend on this match")
        ob.name = ob.data.name = node
        part = os.path.join(os.path.dirname(OUT), f"_hq_{key}.glb")
        bpy.ops.object.select_all(action="DESELECT")
        ob.select_set(True)
        bpy.ops.export_scene.gltf(filepath=part, export_format="GLB", use_selection=True,
                                  export_apply=True, export_yup=True,
                                  export_animations=False, export_image_format="AUTO")
        parts.append(part)
        rows.append((key, before, after, got, want))
        print(f"  {key:18s} tris {before:6d} -> {after:6d}  dims {got} (pin {want})  "
              f"{os.path.getsize(part) // 1024} KB", flush=True)

    if DRY or not parts:
        print("DRY RUN" if DRY else "nothing to build")
        return
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for p in parts:
        bpy.ops.import_scene.gltf(filepath=p)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    print(f"HQ parts {len(meshes)}  tris {sum(tri_count(o) for o in meshes)}")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True,
                              export_apply=True, export_yup=True, export_animations=False,
                              export_image_format="AUTO",
                              export_meshopt_compression_enable=True)
    for p in parts:
        os.remove(p)
    print(f"WROTE {OUT}  {os.path.getsize(OUT) // 1024} KB")
    print("ALL OK")


if __name__ == "__main__":
    main()

