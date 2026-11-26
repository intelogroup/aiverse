"""Deep-access proof: the shipped world GLB -> edits -> textures -> .blend -> subset export,
plus whether a Gaussian-splat point cloud renders in EEVEE.

    blender -b --factory-startup --python tools/city3/probe_world_deep.py

Writes /tmp/world-deep.json plus /tmp/world-texture.{webp,jpg,png} and /tmp/splat-render.png.
"""
import json, os, sys, time, traceback
import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.abspath(os.path.join(HERE, "..", "..", "apps", "console", "public", "assets"))
OUT = "/tmp/world-deep.json"
R = {"errors": []}


def step(name):
    def wrap(fn):
        t0 = time.time()
        try:
            R[name] = fn() or {}
        except Exception as exc:  # noqa: BLE001
            R["errors"].append({"step": name, "error": f"{type(exc).__name__}: {exc}",
                                "trace": traceback.format_exc().splitlines()[-3:]})
            R[name] = None
        if R.get(name) is not None:
            R[name]["ms"] = round((time.time() - t0) * 1000)
        print(f"[deep] {name}: {'ok' if R.get(name) is not None else 'FAILED'}", flush=True)
        return fn
    return wrap


@step("open_world")
def _open():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    t0 = time.time()
    bpy.ops.import_scene.gltf(filepath=os.path.join(ASSETS, "world-city3.glb"))
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    tris = sum(sum(len(p.vertices) - 2 for p in m.data.polygons) for m in meshes)
    return {"seconds": round(time.time() - t0, 1), "objects": len(bpy.data.objects),
            "meshes": len(meshes), "tris_bpy": tris,
            "collections": [c.name for c in bpy.data.collections][:6],
            "materials": len(bpy.data.materials), "images": len(bpy.data.images)}


@step("edit_mesh")
def _edit():
    """Pick the heaviest mesh, tag it, decimate it: per-object access inside the world."""
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    heavy = max(meshes, key=lambda o: len(o.data.polygons))
    before = sum(len(p.vertices) - 2 for p in heavy.data.polygons)
    heavy["deep_probe_tag"] = "touched-by-headless"          # custom property: must survive .blend
    dec = heavy.modifiers.new("dec", "DECIMATE")
    dec.ratio = 0.5
    bpy.context.view_layer.objects.active = heavy
    bpy.ops.object.modifier_apply(modifier=dec.name)
    after = sum(len(p.vertices) - 2 for p in heavy.data.polygons)
    return {"object": heavy.name, "tris_before": before, "tris_after": after,
            "uv_layers": [l.name for l in heavy.data.uv_layers],
            "materials": [s.material.name for s in heavy.material_slots if s.material][:3],
            "custom_prop_set": heavy.get("deep_probe_tag")}


@step("extract_texture")
def _texture():
    """Find an image the world itself uses and write it out at 512 px in three formats."""
    used = None
    for mat in bpy.data.materials:
        if not mat.use_nodes:
            continue
        for n in mat.node_tree.nodes:
            if n.type == "TEX_IMAGE" and n.image and n.image.size[0] >= 512:
                used = (mat.name, n.image)
                break
        if used:
            break
    if not used:
        return {"found": False}
    mat_name, img = used
    if img.size[0] > 512:
        img.scale(512, max(1, int(img.size[1] * 512 / img.size[0])))
    out = {"material": mat_name, "image": img.name, "size": list(img.size)}
    for fmt, ext in (("WEBP", "webp"), ("JPEG", "jpg"), ("PNG", "png")):
        path = f"/tmp/world-texture.{ext}"
        img.file_format = fmt
        img.filepath_raw = path
        img.save()
        out[fmt] = os.path.getsize(path)
    return out

@step("blend_roundtrip")
def _blend():
    """Save the imported world as a .blend, reopen it, and read the custom property back."""
    path = "/tmp/world-deep.blend"
    t0 = time.time()
    bpy.ops.wm.save_as_mainfile(filepath=path)
    save_s = round(time.time() - t0, 1)
    size = os.path.getsize(path)
    bpy.ops.wm.open_mainfile(filepath=path)
    tagged = [o.name for o in bpy.data.objects if o.get("deep_probe_tag")]
    return {"mb": round(size / 1e6, 1), "save_s": save_s,
            "objects_after_reopen": len(bpy.data.objects),
            "images_after_reopen": len(bpy.data.images),
            "tag_found": len(tagged), "tag_survived": tagged[:2]}


@step("export_subset")
def _export():
    """Export one logical group back out as GLB: the loop a content pass needs."""
    group = [o for o in bpy.data.objects if o.type == "MESH" and o.name.startswith("shell_bazaar")]
    if not group:
        group = [o for o in bpy.data.objects if o.type == "MESH"][:10]
    bpy.ops.object.select_all(action="DESELECT")
    for o in group:
        o.select_set(True)
    bpy.context.view_layer.objects.active = group[0]
    path = "/tmp/world-subset.glb"
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True,
                              export_image_format="WEBP", export_yup=True)
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in group)
    return {"objects": len(group), "tris": tris, "bytes": os.path.getsize(path),
            "names": [o.name for o in group][:3]}


@step("splat_render")
def _splat_render():
    """Does EEVEE render an imported .spz point cloud, or nothing?"""
    spz = os.path.normpath(os.path.join(HERE, "..", "..", "apps", "console", "splat-trial",
                                        "bazaar-stall-262k.spz"))
    if not os.path.exists(spz):
        return {"missing": spz}
    for o in list(bpy.data.objects):
        if o.type == "POINTCLOUD":
            bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.wm.spz_import(filepath=spz)
    cloud = next(o for o in bpy.data.objects if o.type == "POINTCLOUD")
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 480, 270
    scene.render.filepath = "/tmp/splat-render.png"
    scene.render.image_settings.file_format = "PNG"
    if not scene.camera:
        bpy.ops.object.camera_add(location=(0, -6, 1.2), rotation=(1.45, 0, 0))
        scene.camera = bpy.context.active_object
    if not any(o.type == "LIGHT" for o in bpy.data.objects):
        bpy.ops.object.light_add(type="SUN", location=(2, -4, 6))
    scene.world = scene.world or bpy.data.worlds.new("W")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs[1].default_value = 0.5
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load("/tmp/splat-render.png")
    px = list(img.pixels)
    rgb = [px[i] for i in range(0, len(px), 4)]
    nonblack = sum(1 for v in rgb if v > 0.02) / max(1, len(rgb))
    return {"bytes": os.path.getsize("/tmp/splat-render.png"), "engine": scene.render.engine,
            "mean_luma": round(sum(rgb) / max(1, len(rgb)), 4),
            "fraction_nonblack": round(nonblack, 3),
            "points": len(cloud.data.points) if hasattr(cloud.data, "points") else None,
            "verdict": "splats contribute pixels" if nonblack > 0.05 else "point cloud renders nothing"}


json.dump(R, open(OUT, "w"), indent=1)
print(f"[deep] wrote {OUT} ({len(R['errors'])} errors)")
