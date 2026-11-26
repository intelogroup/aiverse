"""Taste lab: a controlled modern interior, built from scratch, used to judge material + lighting recipes.

Walls, floor, ceiling, skirting, window and curtains are authored here (not imported), so the only variables are the
materials, the light, and the furniture. Everything is metric: the room is 7.2 x 5.4 x 3.0 m, one long wall is glazing.

    tools/city3/blender_lock.sh -b --python tools/city3/taste_lab.py -- --out shot.png [--res 1280x720] [--samples 64] \
        [--sun 24,-90] [--sofa <gltf>] [--wall plaster|white] [--night]

The source textures are Poly Haven CC0 sets under ~/Developer/city3-downloads/polyhaven-tex (2k).
"""
import bpy, glob, math, os, sys
from mathutils import Euler, Matrix, Vector

TEX = os.path.expanduser("~/Developer/city3-downloads/polyhaven-tex")
SF = os.path.expanduser("~/Developer/city3-downloads/sketchfab")
W, D, H = 7.2, 5.4, 3.0          # room interior, metres
T = 0.18                          # wall thickness


def img(tid, name):
    for p in (glob.glob(os.path.join(TEX, tid, f"{name}.jpg")) + glob.glob(os.path.join(TEX, tid, f"{name}.png"))):
        im = bpy.data.images.load(p, check_existing=True)
        return im
    return None


def pbr(name, tid, tint=(1, 1, 1, 1), flat=None, sat=None, val=None):
    """Principled material from a Poly Haven set: diffuse -> Base Color, nor_gl -> Normal, Rough.green -> Roughness.
    The tint is applied only when there is no diffuse map, so the photographed albedo is never double-tinted."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    d = img(tid, "diffuse")
    if flat is not None:
        b.inputs["Base Color"].default_value = (*flat, 1.0)
    elif d:
        tx = nt.nodes.new("ShaderNodeTexImage")
        tx.image = d
        src = tx.outputs["Color"]
        if sat is not None or val is not None:
            hs = nt.nodes.new("ShaderNodeHueSaturation")
            hs.inputs["Saturation"].default_value = 1.0 if sat is None else sat
            hs.inputs["Value"].default_value = 1.0 if val is None else val
            nt.links.new(src, hs.inputs["Color"])
            src = hs.outputs["Color"]
        nt.links.new(src, b.inputs["Base Color"])
    else:
        b.inputs["Base Color"].default_value = tint
    n = img(tid, "nor_gl")
    if n:
        tx = nt.nodes.new("ShaderNodeTexImage")
        tx.image = n
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.inputs["Strength"].default_value = 0.32
        nt.links.new(tx.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], b.inputs["Normal"])
    r = img(tid, "rough")
    if r:
        tx = nt.nodes.new("ShaderNodeTexImage")
        tx.image = r
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(tx.outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs["Green"], b.inputs["Roughness"])
    return m


def box(name, sx, sy, sz, loc, mat):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.object
    o.name = name
    o.scale = (sx, sy, sz)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(mat)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.cube_project(cube_size=2.2)
    bpy.ops.object.mode_set(mode="OBJECT")
    return o


def plane(name, sx, sy, loc, rot, mat, uv_scale=1.0):
    bpy.ops.mesh.primitive_plane_add(size=1, location=loc, rotation=rot)
    o = bpy.context.object
    o.name = name
    o.scale = (sx, sy, 1)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(mat)
    # world-scale the UVs so a 2k tile covers ~1.2 m, not the whole wall
    me = o.data
    uv = me.uv_layers.active or me.uv_layers.new()
    for loop in me.loops:
        u, v = uv.data[loop.index].uv
        uv.data[loop.index].uv = (u * sx / uv_scale, v * sy / uv_scale)
    return o


def build_room(wall_mat, floor_mat, ceil_mat):
    floor = plane("floor", W, D, (0, 0, 0), (0, 0, 0), floor_mat, uv_scale=1.15)
    ceil = plane("ceiling", W, D, (0, 0, H), (0, 0, 0), ceil_mat, uv_scale=1.4)
    # back wall, two side walls; the +Y wall is the glazed one, built as a frame with a big opening
    box("wall_back", W + 2 * T, T, H, (0, D / 2 + T / 2, H / 2), wall_mat)
    box("wall_left", T, D, H, (-W / 2 - T / 2, 0, H / 2), wall_mat)
    box("wall_right", T, D, H, (W / 2 + T / 2, 0, H / 2), wall_mat)
    # glazed wall: sill 0.35 m, head 2.55 m, two piers 0.55 m
    sill, head = 0.35, 2.55
    box("gle_sill", W, T, sill, (0, -D / 2 - T / 2, sill / 2), wall_mat)
    box("gle_head", W, T, H - head, (0, -D / 2 - T / 2, (H + head) / 2), wall_mat)
    for sx in (-1, 1):
        box(f"gle_pier_{sx}", 0.55, T, head - sill, (sx * (W / 2 - 0.275), -D / 2 - T / 2, (sill + head) / 2), wall_mat)
    # skirting: 9 cm shadow line that archviz shots lean on
    sk = bpy.data.materials.new("skirting")
    sk.use_nodes = True
    sk.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.82, 0.82, 0.80, 1)
    sk.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.45
    box("skirt_back", W, 0.02, 0.09, (0, D / 2 - 0.01, 0.045), sk)
    box("skirt_l", 0.02, D, 0.09, (-W / 2 + 0.01, 0, 0.045), sk)
    box("skirt_r", 0.02, D, 0.09, (W / 2 - 0.01, 0, 0.045), sk)
    # window frame + glass
    fr = bpy.data.materials.new("frame")
    fr.use_nodes = True
    fr.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.045, 0.045, 0.05, 1)
    fr.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.35
    box("frame_head", W - 1.1, 0.06, 0.06, (0, -D / 2 - 0.03, head), fr)
    box("frame_sill", W - 1.1, 0.06, 0.06, (0, -D / 2 - 0.03, sill), fr)
    for i in range(1, 3):
        box(f"mullion_{i}", 0.05, 0.06, head - sill, (-W / 2 + 0.55 + i * (W - 1.1) / 3, -D / 2 - 0.03, (sill + head) / 2), fr)
    glass = bpy.data.materials.new("glass")
    glass.use_nodes = True
    gb = glass.node_tree.nodes["Principled BSDF"]
    gb.inputs["Base Color"].default_value = (0.95, 0.97, 1.0, 1)
    gb.inputs["Roughness"].default_value = 0.02
    gb.inputs["Transmission Weight"].default_value = 1.0
    gb.inputs["IOR"].default_value = 1.45
    glass.blend_method = "BLEND" if hasattr(glass, "blend_method") else glass.blend_method
    g = box("glass", W - 1.1, 0.012, head - sill, (0, -D / 2 - 0.03, (sill + head) / 2), glass)
    g.visible_shadow = False
    return floor


def decorate():
    """The pieces archviz shots always have and that a bare box lacks: a rug grounding the seating, curtains softening the
    glazing, art giving the eye a second stop, and one warm practical at the end of the day cycle."""
    rug_mat = pbr("rug", "wool_boucle", flat=(0.55, 0.52, 0.47))
    p = plane("rug", 2.6, 3.6, (W / 2 - 1.95, 0.6, 0.006), (0, 0, 0), rug_mat, uv_scale=9.0)

    if os.environ.get("NO_CURTAIN"):
        return
    cur_mat = bpy.data.materials.new("curtain")
    cur_mat.use_nodes = True
    _cb = cur_mat.node_tree.nodes["Principled BSDF"]
    _cb.inputs["Base Color"].default_value = (0.74, 0.72, 0.68, 1)
    _cb.inputs["Roughness"].default_value = 0.92
    for sx in (-1, 1):
        c = plane(f"curtain_{sx}", 0.85, 2.35, (sx * (W / 2 - 0.62), -D / 2 + 0.16, 1.42), (math.radians(90), 0, 0), cur_mat, uv_scale=0.9)
        c.rotation_euler = (math.radians(90), math.radians(sx * 4), 0)

    # the last blank surface gets real content (defect 6): an authored abstract print,
    # muted to the room palette; flat fallback only if the file is missing
    art_path = os.path.expanduser(os.environ.get(
        "TASTE_ART", "~/Developer/city3-downloads/art/abstract_loft_01.png"))
    canvas = bpy.data.materials.new("art_canvas")
    canvas.use_nodes = True
    nt_c = canvas.node_tree
    _cb = nt_c.nodes["Principled BSDF"]
    _cb.inputs["Roughness"].default_value = 0.85
    if os.path.exists(art_path):
        _tx = nt_c.nodes.new("ShaderNodeTexImage")
        _tx.image = bpy.data.images.load(art_path, check_existing=True)
        nt_c.links.new(_tx.outputs["Color"], _cb.inputs["Base Color"])
    else:
        _cb.inputs["Base Color"].default_value = (0.55, 0.47, 0.40, 1)
    frame = bpy.data.materials.new("art_frame")
    frame.use_nodes = True
    frame.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.06, 0.06, 0.06, 1)
    frame.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.4
    box("art_frame", 0.035, 1.46, 1.06, (W / 2 - 0.02, 0.6, 1.75), frame)
    box("art_canvas", 0.02, 1.38, 0.98, (W / 2 - 0.045, 0.6, 1.75), canvas)

    # floor lamp: brass stem, linen shade, warm bulb — the classic warm accent in a daylight shot
    stem = bpy.data.materials.new("brass")
    stem.use_nodes = True
    stem.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.30, 0.23, 0.13, 1)
    stem.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value = 0.65
    stem.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.28
    base = bpy.data.meshes.new("lamp_base"); base.from_pydata(
        [(math.cos(a) * 0.19, math.sin(a) * 0.19, 0) for a in [i * math.pi / 12 for i in range(24)]], [], [list(range(24))])
    bo = bpy.data.objects.new("lamp_base", base); bpy.context.scene.collection.objects.link(bo); base.materials.append(stem)
    bo.location = (-W / 2 + 1.1, -D / 2 + 0.9, 0)
    box("lamp_stem", 0.035, 0.035, 1.55, (-W / 2 + 1.1, -D / 2 + 0.9, 0.78), stem)
    shade = bpy.data.materials.new("shade")
    shade.use_nodes = True
    shade.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.9, 0.86, 0.76, 1)
    shade.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9
    bpy.ops.mesh.primitive_cone_add(vertices=32, radius1=0.23, radius2=0.19, depth=0.34, location=(-W / 2 + 1.1, -D / 2 + 0.9, 1.62))
    sh = bpy.context.object; sh.name = "lamp_shade"; sh.data.materials.append(shade)
    _sb = shade.node_tree.nodes["Principled BSDF"]
    _sb.inputs["Emission Color"].default_value = (1.0, 0.78, 0.55, 1)
    _sb.inputs["Emission Strength"].default_value = 14.0
    warm = bpy.data.lights.new("warm_fill", "POINT")
    warm.energy = 110.0
    warm.color = (1.0, 0.78, 0.55)
    warm.shadow_soft_size = 0.18
    wo = bpy.data.objects.new("warm_fill", warm)
    bpy.context.scene.collection.objects.link(wo)
    wo.location = (-W / 2 + 1.1, -D / 2 + 0.9, 1.55)

    # 5) the city beyond the glass: massing blocks in haze, so the window reads as a place, not a gradient
    haze = bpy.data.materials.new("backdrop")
    haze.use_nodes = True
    _hb = haze.node_tree.nodes["Principled BSDF"]
    _hb.inputs["Base Color"].default_value = (0.26, 0.29, 0.34, 1)
    _hb.inputs["Roughness"].default_value = 1.0
    ground = plane("outside_ground", 400, 400, (0, -140, -0.05), (0, 0, 0), haze)
    import random
    random.seed(7)
    for i in range(18):
        bx = random.uniform(-90, 90)
        by = -D / 2 - random.uniform(28, 130)
        bh = random.uniform(9, 34)
        bw = random.uniform(8, 22)
        bd = random.uniform(8, 22)
        box(f"blk_{i}", bw, bd, bh, (bx, by, bh / 2), haze)


def import_gltf(path, target_width, loc, rot_z=0.0, name="sofa"):
    """Import furniture fitted per-axis to its placed bbox, floor-anchored at loc[2].

    The Sketchfab sources arrive with embedded node rotations the importer does not flatten:
    measured 2026-11-25, the L-sectional stood 2.6 m tall through the floor (MEASURE dz=2.600,
    floor_z=-1.227) because the scale was computed against axes the model's own nodes rotate away.
    So: right a tipped import first, scale the longest horizontal axis to target_width, shrink
    further if seat+back height or depth exceeds sane caps, then measure the bbox AFTER scale and
    rotation and recentre on it - the floor lands on loc[2] by construction, whatever the source
    rotates. tools/city3/taste_lab.py -- --measure prints the placed extents for verification.
    """
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before and o.type == "MESH"]
    if not new:
        return None
    root = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(root)
    for o in new:
        # re-parent WITHOUT dropping the world transform: `o.parent = root` alone leaves
        # matrix_parent_inverse at identity, so the placed piece uses local-space semantics
        # (measured 2026-11-25: the sofa rendered upright-but-unrotated and 0.17 m through
        # the back wall; the original tipped-through-floor bug is the same trap)
        mw = o.matrix_world.copy()
        o.parent = root
        o.matrix_parent_inverse = root.matrix_world.inverted()
        o.matrix_basis = mw

    def bbox():
        bpy.context.view_layer.update()
        pts = [o.matrix_world @ Vector(c) for o in root.children if o.type == "MESH" for c in o.bound_box]
        lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
        hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
        return lo, hi

    # raw bbox read straight off the fresh import - matrix_world is reliable pre-transform;
    # post-transform reads lag the depsgraph (measured: three placement passes all read stale)
    lo, hi = bbox()
    dx, dy, dz = hi.x - lo.x, hi.y - lo.y, hi.z - lo.z
    # a genuinely tipped import: vertical extent largest overall AND > 1.6 m (no piece of this
    # kit stands taller than a wardrobe); plain tall furniture (plants, tables) must not fire
    rx = math.radians(90.0) if (dz > max(dx, dy) and dz > 1.6) else 0.0
    s = target_width / max(dx, dy)
    if dz * s > 1.05:
        s = 1.05 / dz          # seat + back height
    if min(dx, dy) * s > 2.4:
        s = 2.4 / min(dx, dy)  # full L-section bbox cap (the chaise arm belongs); catches runaways
    root.scale = (s, s, s)
    root.rotation_euler = (rx, 0.0, rot_z)
    # analytic placement: transform the raw corners by R.S once - no depsgraph reads anywhere.
    # world = T . R . S . basis (parent_inverse is identity), so the placed box is exact.
    M0 = Euler((rx, 0.0, rot_z), "XYZ").to_matrix() @ Matrix.Diagonal((s, s, s))
    corners = [Vector((x, y, z)) for x in (lo.x, hi.x) for y in (lo.y, hi.y) for z in (lo.z, hi.z)]
    placed = [M0 @ c for c in corners]
    plo = Vector((min(p.x for p in placed), min(p.y for p in placed), min(p.z for p in placed)))
    phi = Vector((max(p.x for p in placed), max(p.y for p in placed), max(p.z for p in placed)))
    print(f"RAW {name}: lo=({lo.x:.3f},{lo.y:.3f},{lo.z:.3f}) hi=({hi.x:.3f},{hi.y:.3f},{hi.z:.3f})")
    print(f"FIT {name}: {phi.x - plo.x:.2f} x {phi.y - plo.y:.2f} x {phi.z - plo.z:.2f} m (s={s:.4f})")
    root.location = (loc[0] - (plo.x + phi.x) / 2, loc[1] - (plo.y + phi.y) / 2, loc[2] - plo.z)
    print(f"PLACE {name}: placed_center=({(plo.x + phi.x) / 2:.3f},{(plo.y + phi.y) / 2:.3f},{(plo.z + phi.z) / 2:.3f})"
          f" -> location=({root.location.x:.3f},{root.location.y:.3f},{root.location.z:.3f})")
    # wall clamp, analytic on the same corners (2 cm air; a sofa may kiss the wall, not sink
    # 0.17 m into it - which is exactly what the stale-read placement did)
    idx = {"x": 0, "y": 1}
    for axis, half in (("x", W / 2), ("y", D / 2)):
        i = idx[axis]
        hi_v = phi[i] + root.location[i]
        lo_v = plo[i] + root.location[i]
        if hi_v > half - 0.02:
            root.location[i] -= hi_v - (half - 0.02)
        if lo_v < -half + 0.02:
            root.location[i] += (-half + 0.02) - lo_v
    return root


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    o = dict(zip(argv[::2], argv[1::2]))
    out = os.path.abspath(o.get("--out", "taste.png"))
    rx, ry = (int(v) for v in o.get("--res", "1280x720").lower().split("x"))
    samples = int(o.get("--samples", 64))
    sun_el, sun_az = (float(v) for v in o.get("--sun", "22,-60").split(","))
    night = "--night" in o

    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)

    wall = pbr("wall", "white_stucco", flat=(0.80, 0.78, 0.74))
    floor_mat = pbr("floor", "herringbone_parquet", sat=0.55, val=0.86)
    ceil = pbr("ceiling", "white_stucco", tint=(0.92, 0.92, 0.90, 1))
    build_room(wall, floor_mat, ceil)
    decorate()

    # furniture: the high-poly modern sofa set, a coffee table, plant, mirror, tv
    placed = {}
    sofa_src = o.get("--sofa") or (glob.glob(os.path.expanduser("~/Developer/city3-downloads/sketchfab/sofa_modern_a/**/*.gltf"), recursive=True) + [None])[0]
    if sofa_src:
        root = import_gltf(sofa_src, 2.4, (W / 2 - 1.35, 1.05, 0.0), rot_z=math.radians(-90), name="sofa")
        if root:
            placed["sofa"] = root   # the gltf itself carries a node named "sofa"; measure must use the placed root
    kit = os.path.expanduser("~/Developer/city3-downloads/polyhaven-models")
    for key, src_id, w, loc, rz in (
            ("coffee_table", "coffee_table_round_01", 1.05, (0.75, -0.85, 0), 0),
            ("plant", "potted_plant_04", 0.6, (-W / 2 + 0.7, -D / 2 + 0.75, 0), 0),
            
            ("side_table", "side_table_01", 0.5, (W / 2 - 0.6, 2.0, 0), 0)):
        src = (glob.glob(os.path.join(kit, src_id, "*.gltf")) + [None])[0]
        if src:
            root = import_gltf(src, w, loc, rot_z=rz, name=key)
            if root:
                placed[key] = root

    # --measure: print the placed furniture's real-world footprint, no render (per-axis-fit evidence)
    if "--measure" in argv:
        bpy.context.view_layer.update()   # location is assigned last in import_gltf; force settled matrices
        for name_, root in placed.items():
            # world composed from authoritative properties (T.R.S.basis) - matrix_world reads
            # lag the depsgraph for freshly re-parented nodes, the properties do not
            M = (Matrix.Translation(root.location) @ Euler(root.rotation_euler).to_matrix().to_4x4()
                 @ Matrix.Diagonal(root.scale).to_4x4())
            pts, stack = [], [root]
            while stack:
                ob = stack.pop()
                stack += list(ob.children)
                if ob.type == "MESH":
                    m = M @ ob.matrix_basis
                    pts += [m @ Vector(c) for c in ob.bound_box]
            lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
            hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
            print(f"MEASURE {name_}: dx={hi.x - lo.x:.3f} dy={hi.y - lo.y:.3f} dz={hi.z - lo.z:.3f} "
                  f"floor_z={lo.z:.3f} at ({root.location.x:.3f},{root.location.y:.3f}) "
                  f"bbox lo=({lo.x:.3f},{lo.y:.3f}) hi=({hi.x:.3f},{hi.y:.3f})")
        return

    # lighting: sky through the glazing, sun raking in, soft fill from the room's open side
    sc = bpy.context.scene
    world = sc.world or bpy.data.worlds.new("w")
    sc.world = world
    world.use_nodes = True
    nt = world.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    sky = nt.nodes.new("ShaderNodeTexSky")
    sky.sky_type = "MULTIPLE_SCATTERING"
    sky.sun_elevation = math.radians(sun_el)
    sky.sun_rotation = math.radians(sun_az)
    for attr, val in (("altitude", 90.0), ("air_density", 1.0), ("aerosol_density", 1.1)):
        if hasattr(sky, attr):
            setattr(sky, attr, val)
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Strength"].default_value = 0.10 if night else 0.22
    outn = nt.nodes.new("ShaderNodeOutputWorld")
    nt.links.new(sky.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], outn.inputs["Surface"])

    sun_data = bpy.data.lights.new("sun", "SUN")
    sun_data.energy = 0.4 if night else 6.5
    sun_data.angle = math.radians(0.35)
    sun = bpy.data.objects.new("sun", sun_data)
    sc.collection.objects.link(sun)
    elev, az = math.radians(sun_el), math.radians(sun_az)
    travel = -Vector((math.cos(elev) * math.cos(az), math.cos(elev) * math.sin(az), math.sin(elev)))
    sun.rotation_euler = travel.to_track_quat("-Z", "Y").to_euler()

    fill = bpy.data.lights.new("fill", "AREA")
    fill.energy = 25.0 if night else 110.0
    fill.shape = "RECTANGLE"; fill.size, fill.size_y = 4.0, 2.4
    fill.color = (1.0, 0.95, 0.88)
    fill_ob = bpy.data.objects.new("fill", fill)
    sc.collection.objects.link(fill_ob)
    fill_ob.location = (0, -D / 2 + 0.6, 2.4)
    fill_ob.rotation_euler = (math.radians(-35), 0, 0)

    # hero camera: 24 mm, 1.5 m eye height, back corner looking across the sofa wall
    cam_data = bpy.data.cameras.new("cam"); cam_data.lens = 24; cam_data.sensor_width = 36
    cam = bpy.data.objects.new("cam", cam_data)
    sc.collection.objects.link(cam)
    cam.location = Vector((-2.9, 1.9, 1.45))
    target = Vector((1.45, -1.15, 0.95))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam_data.shift_y = 0.05
    if "--windowview" in argv:
        cam.location = Vector((-W / 2 + 0.9, D / 2 - 0.7, 1.45))
        cam.rotation_euler = (Vector((0, -D / 2, 1.0)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    if "--detail" in argv:
        # sofa-group close-up: the second judging angle of the pair (rounds of the taste lab)
        cam_data.lens = 30
        cam_data.shift_y = 0.0
        cam.location = Vector((0.2, 2.3, 1.2))
        cam.rotation_euler = (Vector((2.3, 0.5, 0.55)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    sc.camera = cam

    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    sc.cycles.max_bounces = 8
    sc.cycles.transmission_bounces = 8
    sc.view_settings.view_transform = "AgX"
    sc.view_settings.look = "AgX - Medium High Contrast"
    sc.view_settings.exposure = 0.0 if not night else 1.2
    sc.render.resolution_x, sc.render.resolution_y = rx, ry
    sc.render.image_settings.file_format = "PNG"
    sc.render.filepath = out
    bpy.ops.render.render(write_still=True)
    print(f"rendered {out}")


main()
