"""Turn downloaded market-stall scans into the two City 3 bazaar stall variants.

    blender -b --factory-startup --python tools/city3/stall_assets.py -- \
        --map tools/city3/out/stall-map.json [--tex 512] [--dry]

Why two variants: the shipped bazaar is ONE 600-tri mesh instanced 80 times, so all
80 stalls are identical and 33 of them (the procedural fallbacks, see
bridge_bazaar.py `selected_stalls`) are bare post-and-rail frames with a two-triangle
awning sheet floating 3.5 m up and no counter. Alternating two downloaded stalls fixes
the bareness and the repetition, and their produce trays mean no counter is empty.

Map entry, per variant:
    "a": {"src": ".../scene.gltf", "budget": 2600, "height": 2.45,
          "yaw": 0, "drop_materials": ["Ground"]}

Sources are Sketchfab CC-BY (see `sources.py list`); credit them through
`python3 tools/city3/sources.py credit`. The downloads embed a 6 m ground plane and
2k normal/roughness maps weighing 30 MB; both are dropped here, leaving baseColour
only, capped at --tex -- these are 2.5 m props seen from 2-20 m in a 59 MB world.
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


MAP = arg("map", f"{HERE}/out/stall-map.json")
OUT = arg("out", f"{HERE}/out/stall-src")
TEX = int(arg("tex", 512))
DRY = "--dry" in ARGS
PI = 3.141592653589793


def tri_count(ob):
    ob.data.calc_loop_triangles()
    return len(ob.data.loop_triangles)


def box(ob):
    bpy.context.view_layer.update()
    pts = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    return (Vector((min(p[i] for p in pts) for i in range(3))),
            Vector((max(p[i] for p in pts) for i in range(3))))


def drop_by_material(prefixes):
    """Delete objects whose every material slot matches a dropped prefix.

    The Ground plane arrives as its own object carrying an 11 MB baseColour, so it
    has to go before the texture pass or it survives as an unused image.
    """
    gone = []
    for o in list(bpy.context.scene.objects):
        if o.type != "MESH" or not o.material_slots:
            continue
        names = [s.material.name for s in o.material_slots if s.material]
        if names and all(any(n.startswith(p) for p in prefixes) for n in names):
            gone.append(o.name)
            bpy.data.objects.remove(o, do_unlink=True)
    return gone


def strip_secondary_maps():
    """Unlink normal / metallic-roughness so only baseColour survives export."""
    stripped = 0
    for mat in bpy.data.materials:
        if not mat.use_nodes:
            continue
        bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf is None:
            continue
        for sock in ("Normal", "Metallic", "Roughness"):
            inp = bsdf.inputs.get(sock)
            if inp is not None and inp.is_linked:
                for link in list(inp.links):
                    mat.node_tree.links.remove(link)
                stripped += 1
        if bsdf.inputs.get("Roughness") and not bsdf.inputs["Roughness"].is_linked:
            bsdf.inputs["Roughness"].default_value = 0.78
        if bsdf.inputs.get("Metallic") and not bsdf.inputs["Metallic"].is_linked:
            bsdf.inputs["Metallic"].default_value = 0.0
    return stripped


def slim_images(max_px):
    for im in bpy.data.images:
        try:
            w, h = im.size
        except (TypeError, ValueError):
            continue
        if not w or not h or max(w, h) <= max_px:
            continue
        k = max_px / max(w, h)
        im.scale(max(1, round(w * k)), max(1, round(h * k)))


def import_scene(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    if not [o for o in bpy.context.scene.objects if o.type == "MESH"]:
        raise SystemExit(f"no meshes in {path}")


def join_meshes():
    """Join every mesh into one object, parent transforms baked in.

    The drop pass must run BEFORE this: after joining, a single object carries the
    Ground, BaseBody and produce materials together, so an `all slots match` test can
    never fire and the 6 m ground plane survives the whole pipeline (measured: a
    4.85 x 4.54 m 'footprint' on a 3.26 x 1.66 m stall).
    """
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    # glTF nests the mesh under rotation empties (Sketchfab_model -> Collada visual
    # scene group -> object); left parented, ob.scale writes local axes and a world-Z
    # height fit scales the wrong dimension.
    bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return ob


def decimate_to(ob, budget):
    before = tri_count(ob)
    if budget and before > budget:
        mod = ob.modifiers.new("dec", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = max(0.01, budget / before)
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return before, tri_count(ob)


def place(ob, height, yaw):
    """Uniform scale to `height` (proportions kept), origin at bottom centre.

    Per-axis fitting like hq_library.fit() would squash a canopy whose width:height
    ratio differs from the envelope. These scans measure 326 x 166 x 296 cm, so a
    uniform scale to 2.45 m lands at 2.70 x 1.38 m -- inside the shipped 3.12 x 1.64.
    """
    if yaw:
        ob.data.transform(Matrix.Rotation(yaw * PI / 180.0, 4, "Z"))
    lo, hi = box(ob)
    size = hi - lo
    f = height / size.z
    ob.scale = (f, f, f)
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
    spec = json.load(open(MAP))
    os.makedirs(OUT, exist_ok=True)
    rows = []
    for key, cfg in spec.items():
        if key.startswith("_"):
            continue
        if DRY:
            print(f"  DRY {key} {os.path.basename(cfg['src'])} "
                  f"budget {cfg.get('budget')} h {cfg.get('height')} yaw {cfg.get('yaw')}")
            continue
        ob = import_scene(cfg["src"]) or None
        dropped = drop_by_material(cfg.get("drop_materials", ["Ground"]))
        ob = join_meshes()
        stripped = strip_secondary_maps()
        before, after = decimate_to(ob, cfg.get("budget"))
        dims = place(ob, cfg.get("height", 2.45), cfg.get("yaw", 0))
        slim_images(TEX)
        if dims[0] > 3.05 or dims[1] > 1.62:
            raise SystemExit(f"{key}: footprint {dims} exceeds the shipped stall "
                             f"envelope 3.12 x 1.64 m -- it would intrude on the aisle")
        ob.name = ob.data.name = f"STALL_{key.upper()}"
        part = os.path.join(OUT, f"stall_{key}.glb")
        bpy.ops.object.select_all(action="DESELECT")
        ob.select_set(True)
        bpy.ops.export_scene.gltf(filepath=part, export_format="GLB", use_selection=True,
                                  export_apply=True, export_yup=True,
                                  export_animations=False, export_image_format="AUTO")
        rows.append({"key": key, "tris": after, "dims": dims,
                     "kb": os.path.getsize(part) // 1024,
                     "dropped": dropped, "stripped_links": stripped})
        print(f"  {key}: tris {before} -> {after}  dims {dims}  "
              f"{os.path.getsize(part) // 1024} KB  dropped {dropped}  "
              f"stripped {stripped} maps", flush=True)
    json.dump(rows, open(f"{OUT}/build.json", "w"), indent=1)
    print("ALL OK")


if __name__ == "__main__":
    main()

