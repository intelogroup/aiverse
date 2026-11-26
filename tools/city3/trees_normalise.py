"""Normalise downloaded Sketchfab trees for the world.
tools/city3/blender_lock.sh -b --python tools/city3/trees_normalise.py -- <dl_dir> <out_dir>   (then trees_kit.py)
Per tree dir (<dl>/<slug>/x/scene.gltf): import, drop non-mesh, apply transforms, join, trunk base to origin,
scale to TARGET height, images down to <=1024, export <out>/<slug>.glb. Prints a JSON stat line per tree,
then renders a Cycles contact sheet of all trees side by side next to a 1.8 m figure box."""
import bpy, sys, os, json, glob, math
from mathutils import Vector
DL, OUT = sys.argv[-2], sys.argv[-1]; os.makedirs(OUT, exist_ok=True)
H = {"oak": 12, "maple": 13, "elm_tree_29": 14, "elm_tree_25": 12, "_46": 11, "birch_11": 13, "birch_tree_4": 12,
     "_13": 7, "_14": 8, "sakura_tree": 7, "sakura_121": 6.5, "_41": 9, "_40": 9, "_44": 9,
     "spruce": 15, "fir": 13, "larch": 16, "poplar": 17, "willow": 10, "palm": 11}
def target(slug):
    return next(v for k, v in H.items() if k in slug)

stats = {}
for d in sorted(glob.glob(f"{DL}/*/")):
    slug = os.path.basename(d.rstrip("/"))
    src = glob.glob(f"{d}**/*.gltf", recursive=True) + glob.glob(f"{d}**/*.glb", recursive=True)
    if not src:
        print("SKIP", slug); continue
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src[0])
    for o in [o for o in bpy.data.objects if o.type == "MESH"]:
        mw = o.matrix_world.copy(); o.parent = None; o.matrix_world = mw
    junk = ("collider", "ground", "grass")   # birch_11 Collider, maple_54 Groundcover_Wood_Mix + grass plane
    for o in list(bpy.data.objects):
        if o.type != "MESH" or any(k in (s.material.name.lower() if s.material else "") for s in o.material_slots for k in junk) \
                or "collider" in o.name.lower():
            bpy.data.objects.remove(o)
    ms = [o for o in bpy.data.objects]
    for o in ms:
        o.select_set(True)
    bpy.context.view_layer.objects.active = ms[0]
    bpy.ops.object.make_single_user(object=True, obdata=True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)  # parents already removed -> world transform baked by importer? apply anyway
    if len(ms) > 1: bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    me = o.data
    vs = [v.co.copy() for v in me.vertices]
    zmin = min(v.z for v in vs); zmax = max(v.z for v in vs); h0 = zmax - zmin
    low = [v for v in vs if v.z < zmin + 0.05 * h0] or vs
    cx = sum(v.x for v in low) / len(low); cy = sum(v.y for v in low) / len(low)
    s = target(slug) / h0
    for v in me.vertices:
        v.co = Vector(((v.co.x - cx) * s, (v.co.y - cy) * s, (v.co.z - zmin) * s))
    me.update()
    for im in bpy.data.images:
        if im.size[0] > 1024 or im.size[1] > 1024:
            f = 1024 / max(im.size); im.scale(max(1, int(im.size[0] * f)), max(1, int(im.size[1] * f)))
    xs = [v.co.x for v in me.vertices]; ys = [v.co.y for v in me.vertices]
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    mats = [(m.name, m.blend_method if hasattr(m, "blend_method") else "", ) for m in me.materials if m]
    bpy.ops.export_scene.gltf(filepath=f"{OUT}/{slug}.glb", export_format="GLB", use_selection=False,
                              export_image_format="AUTO", export_apply=True)
    stats[slug] = {"h_src": round(h0, 3), "scale": round(s, 4), "H": target(slug), "crown": round(max(max(xs) - min(xs), max(ys) - min(ys)), 1),
                   "tris": tris, "mats": [m[0] for m in mats], "kb": os.path.getsize(f"{OUT}/{slug}.glb") // 1024}
    print("NORM", slug, json.dumps(stats[slug]), flush=True)
json.dump(stats, open(f"{OUT}/stats.json", "w"), indent=1)

# contact sheet: all normalised trees in a row, Cycles
bpy.ops.wm.read_factory_settings(use_empty=True)
x = 0.0
for slug in sorted(stats):
    bpy.ops.import_scene.gltf(filepath=f"{OUT}/{slug}.glb")
    objs = [ob for ob in bpy.context.selected_objects if ob.type == "MESH"]
    w = stats[slug]["crown"]
    x += w / 2 + 1
    for ob in objs: ob.location.x += x
    x += w / 2 + 1
bpy.ops.mesh.primitive_cube_add(size=1, location=(-1, 0, 0.9)); bpy.context.object.scale = (0.5, 0.3, 1.8)
bpy.ops.mesh.primitive_plane_add(size=1, location=(x / 2, 0, 0)); bpy.context.object.scale = (x + 10, 40, 1)
sc = bpy.context.scene; sc.render.engine = "CYCLES"
try:
    p = bpy.context.preferences.addons["cycles"].preferences; p.compute_device_type = "METAL"; p.get_devices()
    for dv in p.devices: dv.use = True
    sc.cycles.device = "GPU"
except Exception as e: print("GPU off", e)
sc.cycles.samples = 64; sc.cycles.use_denoising = True
sc.render.resolution_x, sc.render.resolution_y = 3200, 900
wd = bpy.data.worlds.new("w"); sc.world = wd; wd.use_nodes = True
bg = next(n for n in wd.node_tree.nodes if n.type == "BACKGROUND"); bg.inputs[0].default_value = (0.6, 0.72, 0.9, 1)
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN")); sun.data.energy = 4; sun.rotation_euler = (0.9, 0.1, 0.7); sc.collection.objects.link(sun)
cam = bpy.data.objects.new("c", bpy.data.cameras.new("c")); sc.collection.objects.link(cam); sc.camera = cam
cam.data.type = "ORTHO"; cam.data.ortho_scale = x + 4
cam.location = (x / 2, -100, 9); cam.rotation_euler = (math.radians(88), 0, 0)
sc.render.filepath = f"{OUT}/sheet.png"; bpy.ops.render.render(write_still=True)
print("SHEET", f"{OUT}/sheet.png", "order", sorted(stats))
