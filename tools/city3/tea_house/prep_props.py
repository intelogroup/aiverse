"""Blender (via blender_lock.sh): decimate Poly Haven CC0 furniture to a tri budget; geometry + material names only
(textures are rebuilt at 512 px by bridge_tea_props.py).
  blender_lock.sh -b --python tools/city3/tea_house/prep_props.py -- <polyhaven/models dir> <out dir>"""
import bpy, sys, os, json
SRC, OUT = sys.argv[-2], sys.argv[-1]
os.makedirs(OUT, exist_ok=True)
TARGET = {"chinese_tea_table": 1000, "chinese_stool": 600, "chinese_armchair": 1200, "chinese_sofa": 704,
          "chinese_console_table": 1500, "wooden_bookshelf_worn": 1500, "painted_wooden_table": 600,
          "painted_wooden_chair_01": 724, "painted_wooden_bench": 630, "vintage_day_bed": 1200,
          "painted_wooden_nightstand": 470, "sofa_02": 1200, "side_table_01": 600, "mid_century_lounge_chair": 1500,
          "modern_coffee_table_01": 800, "round_wooden_table_02": 800, "planter_box_01": 800}
report = {}
for pid, target in TARGET.items():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    gl = [f for f in os.listdir(os.path.join(SRC, pid)) if f.endswith(".gltf")][0]
    bpy.ops.import_scene.gltf(filepath=os.path.join(SRC, pid, gl))
    ms = [o for o in bpy.data.objects if o.type == "MESH"]
    for o in ms: o.select_set(True)
    bpy.context.view_layer.objects.active = ms[0]
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.data.calc_loop_triangles(); n0 = len(ob.data.loop_triangles)
    if n0 > target:
        md = ob.modifiers.new("d", "DECIMATE"); md.ratio = target / n0; md.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier="d")
    ob.data.calc_loop_triangles(); n1 = len(ob.data.loop_triangles)
    bpy.ops.object.select_all(action="DESELECT"); ob.select_set(True)
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, pid + ".glb"), export_format="GLB", use_selection=True,
                              export_image_format="NONE", export_yup=True, export_apply=True)
    report[pid] = {"before": n0, "after": n1, "mats": [s.material.name for s in ob.material_slots]}
json.dump(report, open(os.path.join(OUT, "report.json"), "w"), indent=1)
print("PREP_DONE", json.dumps({k: (v["before"], v["after"]) for k, v in report.items()}))
