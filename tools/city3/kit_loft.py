"""Build `modern-loft-interior.glb`: a modern living/dining/desk room as LIB_ assets.

Same contract as kit_interiors.py: one mesh per asset named `LIB_<key>`, origin at the bottom
centre, real metres, front toward glTF +Z. A room layout places the keys as instances.

Why a per-room library: `glbInteriors.tsx` loads `*-interior.glb` for a room whose layout names
it, so this furniture travels with the loft instead of growing the shared kit every shop room
must download.

    tools/city3/blender_lock.sh -b --python tools/city3/kit_loft.py -- \
        [--out GLB] [--manifest JSON] [--preview PNG]

Sources: `$PH_SRC` (default ~/Developer/city3-downloads/polyhaven-models), `<id>/<id>.gltf` +
textures, all CC0.
"""
import bpy, glob, json, math, os, sys
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
PH = os.environ.get("PH_SRC", os.path.expanduser("~/Developer/city3-downloads/polyhaven-models"))
TEXMAX = 1024
# Seen from 1-6 m, so 12k tris per piece is plenty; the shared kit's 24k would put a 25-piece
# room near 600k tris for detail nobody resolves at that distance.
BUDGET = 5000
# Pieces the eye lands on first (a sofa, a bed, a table) keep more geometry and a 1k map; everything
# else is a 3.5k / 512 px piece. Measured 2026-11-25: uniform 12k + 1k cost 20.4 MB for one room.
HERO = {"loft_sofa", "loft_bed", "loft_dining", "loft_tv", "loft_media"}


def budget_for(key):
    return 8000 if key in HERO else BUDGET


def texmax_for(key):
    return TEXMAX if key in HERO else 512

# key, polyhaven id, largest-dimension target (m), yaw. Poly Haven authors front = -Y in Blender,
# which the glTF exporter maps to +Z, so yaw 0 already faces the layout's +Z.
LOFT = [
    # living
    ("loft_sofa", "Sofa_01", 2.10, 0),
    ("loft_armchair", "modern_arm_chair_01", 0.95, 0),
    ("loft_lounge", "mid_century_lounge_chair", 0.95, 0),
    ("loft_coffee", "coffee_table_round_01", 1.00, 0),
    ("loft_side", "side_table_01", 0.52, 0),
    ("loft_side_tall", "side_table_tall_01", 0.45, 0),
    ("loft_tv", "television_02", 1.20, 0),
    ("loft_media", "modern_wooden_cabinet", 1.60, 0),
    ("loft_shelf", "wooden_bookshelf_worn", 1.05, 0),
    ("loft_mirror", "ornate_mirror_01", 0.95, 0),
    ("loft_pillows", "throw_pillows_01", 0.48, 0),
    ("loft_vase", "ceramic_vase_01", 0.30, 0),
    ("loft_plant", "potted_plant_04", 0.60, 0),
    ("loft_plant_small", "potted_plant_01", 0.55, 0),
    # light
    ("loft_ceiling", "modern_ceiling_lamp_01", 0.55, 0),
    ("loft_pendant", "hanging_industrial_lamp", 0.50, 0),
    # dining
    ("loft_dining", "dining_table", 1.60, 0),
    ("loft_dining_chair", "dining_chair_02", 0.85, 0),
    ("loft_bar_chair", "bar_chair_round_01", 0.78, 0),
    # desk: the laptop / seated-typing corner
    ("loft_desk", "metal_office_desk", 1.40, 0),
    ("loft_desk_lamp", "desk_lamp_arm_01", 0.55, 0),
    # kitchen corner
    ("loft_stove", "electric_stove", 0.60, 0),
    ("loft_counter", "drawer_cabinet", 1.20, 0),
    # bedroom
    ("loft_bed", "vintage_day_bed", 2.00, 0),
    ("loft_nightstand", "painted_wooden_nightstand", 0.50, 0),
]
FLAT = 0.8


def _tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def _diffuse_only(obj):
    """Keep only the base-colour map: three maps per asset triples texture memory for detail unseen from the walk."""
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
    cands = sorted(glob.glob(os.path.join(PH, asset_id, "*.gltf")), key=lambda p: ("_1k" not in p, p))
    if not cands:
        raise FileNotFoundError(os.path.join(PH, asset_id, "*.gltf"))
    before, imgs = set(bpy.data.objects), set(bpy.data.images)
    bpy.ops.import_scene.gltf(filepath=cands[0])
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
    # A join invalidates captured references: clear the leftovers by name.
    for nm in new_names:
        o = bpy.data.objects.get(nm)
        if o is not None and o is not obj:
            bpy.data.objects.remove(o, do_unlink=True)

    raw = _tris(obj)
    budget = budget_for(key)
    if raw > budget:
        mod = obj.modifiers.new("dec", "DECIMATE")
        mod.ratio = max(0.02, budget / raw)
        mod.use_collapse_triangulate = True
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)

    dims = obj.dimensions
    obj.scale = (target / max(dims.x, dims.y, dims.z),) * 3
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if yaw:
        obj.rotation_euler = (0, 0, yaw)
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

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
    texmax = texmax_for(key)
    for img in set(bpy.data.images) - imgs:
        if img.size[0] > texmax:
            img.scale(texmax, max(1, int(img.size[1] * texmax / img.size[0])))
        img.pack()

    return {"key": key, "id": asset_id, "tris_raw": raw, "tris": _tris(obj),
            "dims": [round(d, 3) for d in obj.dimensions], "license": "CC0",
            "source": f"https://polyhaven.com/a/{asset_id}"}


def preview(path, assets):
    """Contact sheet, so scale and facing are judged from an image rather than counters."""
    coll = bpy.context.scene.collection
    ground = bpy.data.meshes.new("ground")
    ground.from_pydata([(-200, -200, 0), (200, -200, 0), (200, 200, 0), (-200, 200, 0)], [], [(0, 1, 2, 3)])
    g = bpy.data.objects.new("ground", ground)
    coll.objects.link(g)
    gmat = bpy.data.materials.new("ground_mat")
    gmat.use_nodes = True
    gmat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.20, 0.19, 0.17, 1)
    ground.materials.append(gmat)

    objs = sorted((bpy.data.objects[f"LIB_{a['key']}"] for a in assets), key=lambda o: -max(o.dimensions))
    cols, cell = 5, max(max(o.dimensions) for o in objs) + 0.75
    rows = (len(objs) + cols - 1) // cols
    for i, o in enumerate(objs):
        r, c = divmod(i, cols)
        o.location = ((c - (cols - 1) / 2) * cell, ((rows - 1) / 2 - r) * cell, 0)
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    lo = Vector([min(p[i] for p in pts) for i in range(3)])
    hi = Vector([max(p[i] for p in pts) for i in range(3)])
    centre = (lo + hi) / 2
    radius = max((p - centre).length for p in pts)
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = 50
    half = min(math.atan((cam_data.sensor_width / 2) / cam_data.lens),
               math.atan((cam_data.sensor_width / (1600 / 900) / 2) / cam_data.lens))
    cam = bpy.data.objects.new("cam", cam_data)
    coll.objects.link(cam)
    cam.location = centre + Vector((0.42, -0.92, 0.50)).normalized() * (radius / math.sin(half) * 1.12)
    cam.rotation_euler = (centre - cam.location).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cam
    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = 4.0
    so = bpy.data.objects.new("sun", sun)
    so.rotation_euler = (0.9, 0.2, 0.7)
    coll.objects.link(so)
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
    out = os.path.abspath(opts.get("--out", os.path.join(
        HERE, "..", "..", "apps", "console", "public", "assets", "interiors", "modern-loft-interior.glb")))
    manifest = os.path.abspath(opts.get("--manifest", os.path.join(HERE, "out", "modern-loft.json")))
    shot = opts.get("--preview")

    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    assets, tris = [], 0
    for key, asset_id, target, yaw in LOFT:
        a = load(key, asset_id, target, yaw)
        assets.append(a)
        tris += a["tris"]
        print(f"  {key:18s} {a['tris']:6d} tris  {a['dims']}")

    os.makedirs(os.path.dirname(out), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_image_format="JPEG",
                              export_image_quality=78, export_apply=True, export_yup=True, export_animations=False)
    os.makedirs(os.path.dirname(manifest), exist_ok=True)
    json.dump({"library": os.path.basename(out), "assets": assets,
               "total_tris": tris, "bytes": os.path.getsize(out)}, open(manifest, "w"), indent=1)
    print(f"wrote {out} ({os.path.getsize(out) / 1e6:.2f} MB, {tris} tris, {len(assets)} assets)")
    print(f"manifest {manifest}")
    if shot:
        preview(os.path.abspath(shot), assets)
        print(f"preview {shot}")


main()




