"""Low-poly resident-traffic copy of car-concept.glb: one mesh per material, decimated to ~TARGET triangles.
The parked Bazaar car keeps the full model; resident cars (RemoteCar.tsx) use this one so eight of them do not cost 1.7 M triangles.
Run: tools/city3/blender_lock.sh -b --python tools/city3/lod_car.py -- <in.glb> <out.glb> [target_tris]"""
import bpy, sys, bmesh
argv = sys.argv[sys.argv.index("--") + 1:]
src, out = argv[0], argv[1]
TARGET = int(argv[2]) if len(argv) > 2 else 20000
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
# bake each object's world transform into its mesh, drop parents, then join per material
bpy.ops.object.select_all(action="DESELECT")
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
by_mat = {}
for o in meshes:
    key = o.material_slots[0].material.name if o.material_slots and o.material_slots[0].material else "none"
    by_mat.setdefault(key, []).append(o)
joined = []
for key, objs in by_mat.items():
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    joined.append(bpy.context.view_layer.objects.active)
def tris(o): return sum(len(p.vertices) - 2 for p in o.data.polygons)
total = sum(tris(o) for o in joined)
# Small parts (wheels, tyres, glass trim) are what read round: keep most of them; the big body panels carry the cut.
SMALL = 10000
small = [o for o in joined if tris(o) < SMALL]
big = [o for o in joined if tris(o) >= SMALL]
budget = TARGET - sum(tris(o) for o in small) * 0.85
big_total = sum(tris(o) for o in big)
big_ratio = max(0.02, min(1.0, budget / max(1, big_total)))
for o in joined:
    ratio = 0.85 if o in small else big_ratio
    bm = bmesh.new(); bm.from_mesh(o.data); bmesh.ops.triangulate(bm, faces=bm.faces); bm.to_mesh(o.data); bm.free()
    m = o.modifiers.new("lod", "DECIMATE"); m.ratio = ratio
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.modifier_apply(modifier="lod")
ratio = big_ratio
print("LOD", {"before": total, "after": sum(tris(o) for o in joined), "meshes": len(joined), "ratio": round(ratio, 3)})
bpy.ops.object.select_all(action="DESELECT")
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=False, export_apply=True)
