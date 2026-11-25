"""Build `interior-kit.glb`: the new interior props as LIB_ assets, in the same contract as world-city3-library.glb.

Contract (see apps/console/src/features/world/interiorBuild.ts): every asset is one mesh object named `LIB_<key>`, origin at the
bottom centre, real metres, front toward glTF +Z. A layout places those keys as instances; geometry and materials are shared.

Only assets NOT already in world-city3-library.glb are listed, so merging both libraries cannot shadow an existing key.

    tools/city3/blender_lock.sh -b --python tools/city3/kit_interiors.py -- [--out GLB] [--manifest JSON] [--preview PNG]

Sources: `$PH_SRC` (default ~/Developer/city3-downloads/polyhaven-models), each `<id>/<id>.gltf` + textures, CC0.
"""
import bpy, glob, json, math, os, sys
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
PH = os.environ.get("PH_SRC", os.path.expanduser("~/Developer/city3-downloads/polyhaven-models"))
TEXMAX = 1024          # interiors sit metres from the camera; 512 is too soft for furniture faces
BUDGET = 24000         # per asset; a sofa at 24k tris reads smooth and streams cheap

# key, polyhaven id, target size (m) applied to the asset's LARGEST dimension, yaw to turn its front toward +Z
# Poly Haven furniture is authored front = -Y in Blender, and the glTF exporter maps Blender -Y to +Z, so yaw 0 keeps that.
KIT = [
    ("sofa_settee",     "Sofa_01",               2.05,   0),
    ("bar_chair",       "bar_chair_round_01",    0.78,   0),
    ("mirror",          "ornate_mirror_01",      0.95,   0),
    ("pillows",         "throw_pillows_01",      0.48,   0),
    ("tv",              "television_02",         1.15,   0),
    ("coffee_table",    "coffee_table_round_01", 0.95,   0),
    ("side_table",      "side_table_01",         0.50,   0),
    ("cabinet_modern",  "modern_wooden_cabinet", 1.05,   0),
    ("vase_ceramic",    "ceramic_vase_01",       0.32,   0),
    ("plant_pot_1",     "potted_plant_01",       0.62,   0),
    ("plant_pot_4",     "potted_plant_04",       0.55,   0),
]
FLAT = 0.8  # constant roughness for every kit material


def _tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def _diffuse_only(obj):
    """Keep only the base-colour texture: three maps per asset triples texture memory for detail no one sees from the walk."""
    for slot in obj.material_slots:
        m = slot.material
        if not m or not m.use_nodes:
            continue
        nt = m.node_tree
        bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if not bsdf:
            continue
        keep = set()
        base = bsdf.inputs.get("Base Color")
        if base and base.is_linked:
            src = base.links[0].from_node
            while src and src.type != "TEX_IMAGE":
                ins = [x for x in src.inputs if x.is_linked]
                src = ins[0].links[0].from_node if ins else None
            if src:
                keep.add(src)
        for link in list(nt.links):
            if link.to_node is bsdf and link.to_socket.name in ("Normal", "Roughness", "Metallic"):
                nt.links.remove(link)
        for n in list(nt.nodes):
            if n.type == "TEX_IMAGE" and n not in keep:
                nt.nodes.remove(n)
            elif n.type in ("NORMAL_MAP", "SEPARATE_COLOR"):
                nt.nodes.remove(n)
        bsdf.inputs["Roughness"].default_value = FLAT
        bsdf.inputs["Metallic"].default_value = 0.0


def load(key, asset_id, target, yaw):
    # Poly Haven's download names the file either <id>.gltf or <id>_1k.gltf depending on the size variant requested
    cands = sorted(glob.glob(os.path.join(PH, asset_id, "*.gltf")), key=lambda p: ("_1k" not in p, p))
    if not cands:
        raise FileNotFoundError(os.path.join(PH, asset_id, "*.gltf"))
    src = cands[0]
    before, imgs = set(bpy.data.objects), set(bpy.data.images)
    bpy.ops.import_scene.gltf(filepath=src)
    new = [o for o in bpy.data.objects if o not in before]
    new_names = [o.name for o in new]
    meshes = [o for o in new if o.type == "MESH"]
    if not meshes:
        raise RuntimeError(f"{asset_id}: imported no meshes")
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.parent = None
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    # leftover empties / armatures from the import (a joined object no longer exists: look up by name, never by reference)
    for nm in new_names:
        o = bpy.data.objects.get(nm)
        if o is not None and o is not obj:
            bpy.data.objects.remove(o, do_unlink=True)

    raw = _tris(obj)
    if raw > BUDGET:
        mod = obj.modifiers.new("dec", "DECIMATE")
        mod.ratio = max(0.02, BUDGET / raw)
        mod.use_collapse_triangulate = True
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)

    # real-world size: uniform scale so the largest dimension hits the target
    dims = obj.dimensions
    k = target / max(dims.x, dims.y, dims.z)
    obj.scale = (k, k, k)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if yaw:
        obj.rotation_euler = (0, 0, yaw)
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # origin -> bottom centre
    vs = [v.co for v in obj.data.vertices]
    mn = Vector([min(v[i] for v in vs) for i in range(3)])
    mx = Vector([max(v[i] for v in vs) for i in range(3)])
    off = Vector(((mn.x + mx.x) / 2, (mn.y + mx.y) / 2, mn.z))
    for v in obj.data.vertices:
        v.co -= off
    obj.location = (0, 0, 0)
    obj.name = f"LIB_{key}"
    obj.data.name = f"LIB_{key}"

    _diffuse_only(obj)
    for img in set(bpy.data.images) - imgs:
        if img.size[0] > TEXMAX:
            img.scale(TEXMAX, max(1, int(img.size[1] * TEXMAX / img.size[0])))
        img.pack()

    final = obj.dimensions
    return {"key": key, "id": asset_id, "tris_raw": raw, "tris": _tris(obj),
            "dims": [round(d, 3) for d in final], "license": "CC0",
            "source": f"https://polyhaven.com/a/{asset_id}"}


def preview(path, assets):
    """A 3/4 contact sheet so scale and facing are judged from an image, not from counters."""
    coll = bpy.context.scene.collection
    ground = bpy.data.meshes.new("ground")
    ground.from_pydata([(-200, -200, 0), (200, -200, 0), (200, 200, 0), (-200, 200, 0)], [], [(0, 1, 2, 3)])
    g = bpy.data.objects.new("ground", ground)
    coll.objects.link(g)
    mat = bpy.data.materials.new("ground_mat")
    mat.use_nodes = True
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.20, 0.19, 0.17, 1)
    ground.materials.append(mat)

    objs = [bpy.data.objects[f"LIB_{a['key']}"] for a in assets]
    objs.sort(key=lambda o: -max(o.dimensions))
    cols = 4
    rows = (len(objs) + cols - 1) // cols
    cell = max(max(o.dimensions) for o in objs) + 0.75
    for i, o in enumerate(objs):
        r, c = divmod(i, cols)
        o.location = ((c - (cols - 1) / 2) * cell, ((rows - 1) / 2 - r) * cell, 0)
    # frame the whole sheet: fit the bounding sphere to the narrower field of view
    pts = [o.matrix_world @ Vector(corner) for o in objs for corner in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    centre = (lo + hi) / 2
    radius = max((p - centre).length for p in pts)
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = 50
    sensor = cam_data.sensor_width          # 36 mm, sensor fit AUTO
    aspect = 1600 / 900
    half_h = math.atan((sensor / 2) / cam_data.lens)
    half_v = math.atan((sensor / aspect / 2) / cam_data.lens)
    dist = radius / math.sin(min(half_h, half_v)) * 1.12
    cam = bpy.data.objects.new("cam", cam_data)
    coll.objects.link(cam)
    cam.location = centre + Vector((0.42, -0.92, 0.50)).normalized() * dist
    cam.rotation_euler = (centre - cam.location).to_track_quat('-Z', 'Y').to_euler()
    bpy.context.scene.camera = cam
    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = 4.0
    so = bpy.data.objects.new("sun", sun)
    so.rotation_euler = (0.9, 0.2, 0.7)
    coll.objects.link(so)
    world = bpy.data.worlds.new("w") if not bpy.context.scene.world else bpy.context.scene.world
    bpy.context.scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.35, 0.40, 0.48, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.7
    sc = bpy.context.scene
    for eng in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
        try:
            sc.render.engine = eng
            break
        except TypeError:
            continue
    sc.render.resolution_x, sc.render.resolution_y = 1600, 900
    sc.render.filepath = path
    sc.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    opts = dict(zip(argv[::2], argv[1::2]))
    out = opts.get("--out", os.path.join(HERE, "..", "..", "apps", "console", "public", "assets", "interior-kit.glb"))
    out = os.path.abspath(out)
    manifest = opts.get("--manifest", os.path.join(HERE, "out", "interior-kit.json"))
    shot = opts.get("--preview")

    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    assets = []
    for key, asset_id, target, yaw in KIT:
        assets.append(load(key, asset_id, target, yaw))
        print(f"  {key:15s} {assets[-1]['tris']:6d} tris  {assets[-1]['dims']}")

    os.makedirs(os.path.dirname(out), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_image_format="JPEG",
                              export_image_quality=85, export_apply=True, export_yup=True)
    os.makedirs(os.path.dirname(manifest), exist_ok=True)
    json.dump({"library": "interior-kit.glb", "assets": assets}, open(manifest, "w"), indent=1)
    print(f"wrote {out} ({os.path.getsize(out) / 1e6:.2f} MB) and {manifest}")
    if shot:
        preview(os.path.abspath(shot), assets)
        print(f"preview {shot}")


main()
