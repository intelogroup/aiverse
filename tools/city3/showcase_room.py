"""Render an archviz-quality still from an interior scene GLB: daylight sky, interior fill, magazine framing.

    tools/city3/blender_lock.sh -b --python tools/city3/showcase_room.py -- --glb <scene.gltf> --out shot.png \
        [--res 1600x900] [--samples 96] [--view hero|corner|wide] [--cam x,y,z] [--target x,y,z] [--lens 24] [--sun 35,-120]

No cameras or lights come inside the downloaded scenes, so this authors them: a physical sky + sun through the glazing,
a soft area fill from the room's open side, AgX view transform, and a 24 mm eye-height view that keeps verticals straight.
"""
import bpy, math, os, sys
from mathutils import Vector


def bbox(objs):
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    o = dict(zip(argv[::2], argv[1::2]))
    glb = os.path.abspath(o["--glb"])
    out = os.path.abspath(o.get("--out", "showcase.png"))
    res = o.get("--res", "1600x900")
    rx, ry = (int(v) for v in res.lower().split("x"))
    samples = int(o.get("--samples", 96))
    view = o.get("--view", "hero")
    lens = float(o.get("--lens", 24))
    sun = [float(v) for v in o.get("--sun", "38,-125").split(",")]

    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    bpy.ops.import_scene.gltf(filepath=glb)
    meshes = [ob for ob in bpy.data.objects if ob.type == "MESH"]
    if not meshes:
        raise SystemExit("no meshes in the scene")
    lo, hi = bbox(meshes)
    size = hi - lo
    centre = (lo + hi) / 2
    print(f"scene {size.x:.1f} x {size.y:.1f} x {size.z:.1f} m, floor at {lo.z:.2f}")

    # --dollhouse: archviz cutaway — drop ceilings and the walls between camera and room, shoot from outside at 3/4
    if "--find-camera" in argv and "view_cam" in dir():
        cam_loc, target = view_cam, view_target
    elif "--dollhouse" in argv:
        cut = lo.z + float(o.get("--cut", "2.85"))
        keep = []
        for ob in meshes:
            olo, ohi = bbox([ob])
            footprint = (ohi.x - olo.x) * (ohi.y - olo.y)
            whole = size.x * size.y
            is_ceiling = olo.z > cut
            is_near_wall = (ohi.y - olo.y) < 0.6 and (ohi.x - olo.x) > 0.5 * size.x and olo.y < centre.y - size.y * 0.25
            is_near_wall_x = (ohi.x - olo.x) < 0.6 and (ohi.y - olo.y) > 0.5 * size.y and olo.x > centre.x + size.x * 0.15
            if is_ceiling or is_near_wall or is_near_wall_x or footprint > 0.9 * whole and (ohi.z - olo.z) < 0.3:
                ob.hide_render = True
            else:
                keep.append(ob)
        meshes = keep
        if not meshes:
            raise SystemExit("dollhouse removed every mesh")
        lo, hi = bbox(meshes)
        centre = (lo + hi) / 2
        size = hi - lo
        print(f"dollhouse: kept {len(meshes)} meshes, cut at {cut:.2f}")

    # --find-camera: sample eye-height points on a grid, score what each can actually see with rays, take the best.
    # Far more reliable than guessing a corner of a bbox when the scene is an enclosed apartment.
    if "--find-camera" in argv:
        dg = bpy.context.evaluated_depsgraph_get()
        best = (None, -1.0, set())
        step = float(o.get("--step", "0.7"))
        eye_z = lo.z + 1.2
        while eye_z < hi.z - 0.6:
            y = lo.y + 0.7
            while y < hi.y - 0.7:
                x = lo.x + 0.7
                while x < hi.x - 0.7:
                    eye = Vector((x, y, eye_z))
                    floor = bpy.context.scene.ray_cast(dg, eye, Vector((0, 0, -1)), distance=2.0)
                    if not (floor[0] and 0.8 < (eye.z - floor[1].z) < 1.8):
                        x += step
                        continue
                    hits, objs, depth, nearest = 0, set(), 0.0, 99.0
                    for k in range(12):
                        az = k * math.pi / 6
                        r = bpy.context.scene.ray_cast(dg, eye, Vector((math.cos(az), math.sin(az), -0.1)).normalized(), distance=12.0)
                        if r[0]:
                            hits += 1
                            objs.add(r[4].name if r[4] else "?")
                            d = (r[1] - eye).length
                            depth += d
                            nearest = min(nearest, d)
                    # a roomy view: everything at arm's length is a failed photo, however much geometry it sees
                    if hits >= 11 and nearest > 2.2:
                        score = len(objs) * 2.0 + depth / hits + 0.4 * min(nearest, 8.0)
                        if score > best[1]:
                            best = (eye.copy(), score, objs)
                    x += step
                y += step
            eye_z += 0.45
        if best[0] is None:
            print("find-camera: no enclosed point found")
        else:
            cam_loc = best[0]
            acc, n = Vector((0, 0, 0)), 0
            for k in range(12):
                az = k * math.pi / 6
                r = bpy.context.scene.ray_cast(dg, cam_loc, Vector((math.cos(az), math.sin(az), -0.1)).normalized(), distance=12.0)
                if r[0]:
                    acc += r[1]; n += 1
            target = acc / max(n, 1)
            target.z = cam_loc.z - 0.12
            view_cam = cam_loc
            view_target = target
            print(f"find-camera: eye {tuple(round(v,2) for v in cam_loc)} targets {tuple(round(v,2) for v in target)} score {best[1]:.1f} objects {len(best[2])}")

    sc = bpy.context.scene
    # --- lighting: physical sky + sun, then a broad fill that stands in for bounced daylight
    world = sc.world or bpy.data.worlds.new("w")
    sc.world = world
    world.use_nodes = True
    nt = world.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    sky = nt.nodes.new("ShaderNodeTexSky")
    sky.sky_type = "MULTIPLE_SCATTERING"
    sky.sun_elevation = math.radians(sun[0])
    sky.sun_rotation = math.radians(sun[1])
    for attr, val in (("altitude", 120.0), ("air_density", 1.0), ("aerosol_density", 1.2), ("dust_density", 1.4)):
        if hasattr(sky, attr):
            setattr(sky, attr, val)
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Strength"].default_value = 0.30
    outn = nt.nodes.new("ShaderNodeOutputWorld")
    nt.links.new(sky.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], outn.inputs["Surface"])

    sun_data = bpy.data.lights.new("sun", "SUN")
    sun_data.energy = 2.2
    sun_data.angle = math.radians(2.5)
    sun_ob = bpy.data.objects.new("sun", sun_data)
    sc.collection.objects.link(sun_ob)
    travel = -(Vector((math.cos(math.radians(sun[0])) * math.cos(math.radians(sun[1])),
                       math.cos(math.radians(sun[0])) * math.sin(math.radians(sun[1])),
                       math.sin(math.radians(sun[0])))))
    sun_ob.rotation_euler = travel.to_track_quat("-Z", "Y").to_euler()
    # a big soft area light high on the open side reads as window bounce and kills the pitch-black corners
    fill = bpy.data.lights.new("fill", "AREA")
    fill.energy = 260.0
    fill.shape = "RECTANGLE"
    fill.size, fill.size_y = max(6.0, size.x * 0.7), max(4.0, size.z * 0.7)
    fill.color = (1.0, 0.96, 0.9)
    fill_ob = bpy.data.objects.new("fill", fill)
    sc.collection.objects.link(fill_ob)
    fill_ob.location = (centre.x, centre.y - size.y * 0.55, lo.z + size.z * 0.75)
    fill_ob.rotation_euler = (math.radians(62), 0, 0)

    # --- camera: eye height inside the volume, aimed at the room centre
    if "--find-camera" in argv and "view_cam" in dir():
        cam_loc, target = view_cam, view_target
    elif "--dollhouse" in argv:
        dist = max(size.x, size.y) * 1.15
        cam_loc = Vector((centre.x + dist * 0.55, centre.y - dist * 1.05, lo.z + size.z * 1.35))
        target = Vector((centre.x, centre.y, lo.z + size.z * 0.25))
    elif o.get("--cam"):
        cam_loc = Vector([float(v) for v in o["--cam"].split(",")])
    else:
        d = max(size.x, size.y) * 0.42
        cam_loc = Vector((centre.x - d * 0.75, centre.y - d * 0.95, lo.z + 1.55))
    target = Vector([float(v) for v in o["--target"].split(",")]) if o.get("--target") else Vector((centre.x, centre.y, lo.z + 1.05))
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = lens
    cam_data.sensor_width = 36
    if view == "wide":
        cam_data.lens = lens * 0.7
    if o.get("--aerial"):
        cam_data.lens = 35
        cam_loc = Vector((centre.x, centre.y - 0.01, hi.z + max(size.x, size.y) * 0.9))
        target = Vector((centre.x, centre.y, lo.z))
    cam = bpy.data.objects.new("cam", cam_data)
    sc.collection.objects.link(cam)
    cam.location = cam_loc
    cam.rotation_euler = (target - cam_loc).to_track_quat("-Z", "Y").to_euler()
    cam_data.shift_y = 0.06            # keep verticals upright without tilting the camera up
    sc.camera = cam
    print(f"camera {tuple(round(v, 1) for v in cam_loc)} -> {tuple(round(v, 1) for v in target)} lens {cam_data.lens:.0f}")

    # --- render: Cycles for real GI, denoised, AgX so the highlights roll off like the reference shots
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    sc.cycles.max_bounces = 6
    sc.cycles.diffuse_bounces = 4
    sc.cycles.glossy_bounces = 4
    sc.cycles.transmission_bounces = 6
    sc.cycles.use_adaptive_sampling = True
    sc.cycles.adaptive_threshold = 0.02
    sc.view_settings.view_transform = "AgX"
    sc.view_settings.look = "AgX - Medium High Contrast"
    sc.view_settings.exposure = -0.55
    sc.render.resolution_x, sc.render.resolution_y = rx, ry
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = "PNG"
    sc.render.film_transparent = False
    sc.render.filepath = out
    bpy.ops.render.render(write_still=True)
    print(f"rendered {out} at {rx}x{ry}, {samples} samples")


main()
