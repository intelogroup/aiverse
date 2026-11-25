"""Render a contact sheet from an exported LIB_ library GLB, and print what the file actually contains.

This reads the built artifact (not the Blender scene), so it doubles as an export check: names, node count, and
real-world dimensions come from the GLB the runtime will load.

    tools/city3/blender_lock.sh -b --python tools/city3/kit_preview.py -- --glb apps/console/public/assets/interior-kit.glb --out shot.png [--cols 4]
"""
import bpy, glob, json, math, os, sys
from mathutils import Vector


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    o = dict(zip(argv[::2], argv[1::2]))
    glb = os.path.abspath(o["--glb"])
    out = os.path.abspath(o.get("--out", "kit-preview.png"))
    cols = int(o.get("--cols", 4))

    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    bpy.ops.import_scene.gltf(filepath=glb)

    objs = [ob for ob in bpy.data.objects if ob.name.startswith("LIB_") and ob.type == "MESH"]
    objs.sort(key=lambda ob: ob.name)
    print(f"GLB: {len(objs)} LIB_ assets")
    for ob in objs:
        d = ob.dimensions
        print(f"  {ob.name[4:]:16s} dims {d.x:.2f} x {d.y:.2f} x {d.z:.2f} m")

    rows = (len(objs) + cols - 1) // cols
    cell = max(max(ob.dimensions) for ob in objs) + 0.8
    for i, ob in enumerate(objs):
        r, c = divmod(i, cols)
        ob.location = ((c - (cols - 1) / 2) * cell, ((rows - 1) / 2 - r) * cell, 0)

    bpy.context.view_layer.update()
    pts = [ob.matrix_world @ Vector(cnr) for ob in objs for cnr in ob.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    centre = (lo + hi) / 2

    coll = bpy.context.scene.collection
    gm = bpy.data.meshes.new("ground")
    gm.from_pydata([(-80, -80, 0), (80, -80, 0), (80, 80, 0), (-80, 80, 0)], [], [(0, 1, 2, 3)])
    g = bpy.data.objects.new("ground", gm)
    coll.objects.link(g)
    mat = bpy.data.materials.new("gm")
    mat.use_nodes = True
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.21, 0.20, 0.18, 1)
    gm.materials.append(mat)

    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = 45
    cam = bpy.data.objects.new("cam", cam_data)
    coll.objects.link(cam)
    # frame the sheet rectangle in both axes, then back off 15 %
    w, h = hi.x - lo.x, hi.y - lo.y
    half_h = math.atan((cam_data.sensor_width / 2) / cam_data.lens)
    half_v = math.atan(((cam_data.sensor_width * 9 / 16) / 2) / cam_data.lens)
    dist = max(w / (2 * math.tan(half_h)), h / (2 * math.tan(half_v))) * 1.15
    cam.location = centre + Vector((0.0, -1.0, 0.48)).normalized() * dist
    cam.rotation_euler = (centre - cam.location).to_track_quat('-Z', 'Y').to_euler()
    bpy.context.scene.camera = cam

    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 4.5
    sun.rotation_euler = (0.85, 0.15, 0.6)
    coll.objects.link(sun)
    world = bpy.context.scene.world or bpy.data.worlds.new("w")
    bpy.context.scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.38, 0.43, 0.5, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.8

    sc = bpy.context.scene
    for eng in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
        try:
            sc.render.engine = eng
            break
        except TypeError:
            continue
    sc.render.resolution_x, sc.render.resolution_y = 1600, 900
    sc.render.image_settings.file_format = "PNG"
    sc.render.filepath = out
    bpy.ops.render.render(write_still=True)
    print(f"dist {dist:.1f} m, centre ({centre.x:.1f}, {centre.y:.1f}) -> {out}")


main()
