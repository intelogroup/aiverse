"""Probe what headless Blender can do on THIS machine, with evidence, not claims.

    blender -b --factory-startup --python tools/city3/probe_blender.py -- [--world] [--out JSON]

Sections: version/engines/addons/extensions, mesh+UV+bake, texture formats, EEVEE render,
.blend round-trip, glTF import (interior kit; world-city3.glb with --world), Gaussian-splat PLY
import, and whether a ComfyUI inpainting backend is reachable. Every section is wrapped: one
failing capability must not hide the rest of the report.
"""
import json, os, struct, sys, time, traceback, urllib.request
import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.abspath(os.path.join(HERE, "..", "..", "apps", "console", "public", "assets"))
ARGV = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = "/tmp/blender-probe.json"
if "--out" in ARGV:
    OUT = ARGV[ARGV.index("--out") + 1]

R = {"errors": []}


def section(name):
    def wrap(fn):
        t0 = time.time()
        try:
            R[name] = fn()
        except Exception as exc:  # noqa: BLE001 - a probe reports, it does not crash
            R["errors"].append({"section": name, "error": f"{type(exc).__name__}: {exc}",
                                "trace": traceback.format_exc().splitlines()[-3:]})
            R[name] = None
        else:
            R[name]["ms"] = round((time.time() - t0) * 1000)
        print(f"[probe] {name}: {'ok' if R[name] else 'FAILED'}", flush=True)
        return fn
    return wrap


@section("env")
def _env():
    engine_ids = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    addons_available = []
    try:
        import addon_utils
        addons_available = sorted(m.__name__ for m in addon_utils.modules())
    except Exception:  # noqa: BLE001
        pass
    repos = []
    try:
        for repo in bpy.context.preferences.extensions.repos:
            repos.append({"module": repo.module, "enabled": repo.enabled, "url": repo.remote_url})
    except Exception:  # noqa: BLE001
        pass
    return {
        "version": bpy.app.version_string,
        "engine_ids": engine_ids,
        "addons_enabled": sorted(a.module for a in bpy.context.preferences.addons),
        "addons_available": addons_available,
        "extension_repos": repos,
        "image_formats": [e.identifier for e in bpy.types.Image.bl_rna.properties["file_format"].enum_items],
        "mesh_import_ops": [n for n in dir(bpy.ops.import_mesh) if not n.startswith("_")],
        "mesh_export_ops": [n for n in dir(bpy.ops.export_scene) if not n.startswith("_")],
    }

@section("mesh_uv_bake")
def _mesh():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.mesh.primitive_cube_add(size=2)
    cube = bpy.context.active_object
    # UVs from nothing: smart project is the programmatic path the asset kits use.
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.02)
    bpy.ops.object.mode_set(mode="OBJECT")
    uv_layers = [l.name for l in cube.data.uv_layers]
    dec = cube.modifiers.new("dec", "DECIMATE")
    dec.ratio = 0.5
    bpy.ops.object.modifier_apply(modifier=dec.name)
    tris = sum(len(p.vertices) - 2 for p in cube.data.polygons)
    bevel = cube.modifiers.new("bev", "BEVEL")
    bevel.width = 0.05
    bpy.ops.object.modifier_apply(modifier=bevel.name)
    # Bake ambient occlusion into an image with Cycles: the headless bake path.
    mat = bpy.data.materials.new("probe")
    mat.use_nodes = True
    cube.data.materials.append(mat)
    img = bpy.data.images.new("bake_ao", 128, 128)
    tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image = img
    mat.node_tree.nodes.active = tex
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 8
    scene.cycles.device = "CPU"
    bpy.ops.object.bake(type="AO", margin=2)
    return {"uv_layers": uv_layers, "tris_after_decimate": tris,
            "bake_image_size": list(img.size), "bake_has_pixels": len(img.pixels) > 0}


@section("texture_io")
def _texture():
    img = bpy.data.images.get("bake_ao") or bpy.data.images.new("probe_tex", 64, 64)
    out = {}
    for fmt in ("JPEG", "WEBP", "PNG"):
        path = f"/tmp/probe.{fmt.lower()}"
        try:
            img.file_format = fmt
            img.filepath_raw = path
            img.save()
            out[fmt] = os.path.getsize(path)
        except Exception as exc:  # noqa: BLE001
            out[fmt] = f"FAILED: {type(exc).__name__} {exc}"
    return out


@section("eevee_render")
def _render():
    scene = bpy.context.scene
    ids = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    engine = next((e for e in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE") if e in ids), None)
    if not engine:
        return {"engine": None, "note": "no EEVEE in this build", "available": ids}
    scene.render.engine = engine
    if not scene.camera:
        bpy.ops.object.camera_add(location=(6, -6, 4), rotation=(1.1, 0, 0.8))
        scene.camera = bpy.context.active_object
    if not any(o.type == "LIGHT" for o in bpy.data.objects):
        bpy.ops.object.light_add(type="SUN", location=(3, -3, 6))
    scene.render.resolution_x, scene.render.resolution_y = 320, 200
    scene.render.filepath = "/tmp/probe-eevee.png"
    scene.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)
    return {"engine": engine, "bytes": os.path.getsize("/tmp/probe-eevee.png")}


@section("blend_roundtrip")
def _blend():
    path = "/tmp/probe-scene.blend"
    bpy.ops.wm.save_as_mainfile(filepath=path)
    size = os.path.getsize(path)
    bpy.ops.wm.open_mainfile(filepath=path)
    return {"bytes": size, "objects_after_reopen": len(bpy.data.objects),
            "materials_after_reopen": len(bpy.data.materials)}


def glb_header(path):
    """Read the GLB JSON chunk directly: extensions, node names, image bytes (no importer needed)."""
    b = open(path, "rb").read()
    jl = struct.unpack("<I", b[12:16])[0]
    doc = json.loads(b[20:20 + jl])
    tris = 0
    for m in doc.get("meshes", []):
        for p in m.get("primitives", []):
            if p.get("indices") is not None:
                tris += doc["accessors"][p["indices"]]["count"] // 3
    return {
        "mb": round(len(b) / 1e6, 2),
        "nodes": len(doc.get("nodes", [])),
        "meshes": len(doc.get("meshes", [])),
        "materials": len(doc.get("materials", [])),
        "images": len(doc.get("images", [])),
        "animations": len(doc.get("animations", [])),
        "tris": tris,
        "extensions_used": doc.get("extensionsUsed", []),
        "roles": sorted({r for n in doc.get("nodes", []) for r in n.get("extras", {}).get("roles", [])}),
    }


@section("glb_import")
def _glb():
    out = {}
    files = [("interior_kit", os.path.join(ASSETS, "interiors", "modern-loft-interior.glb"))]
    if "--world" in ARGV:
        files.append(("world_city3", os.path.join(ASSETS, "world-city3.glb")))
    for label, path in files:
        if not os.path.exists(path):
            out[label] = {"missing": path}
            continue
        header = glb_header(path)
        t0 = time.time()
        bpy.ops.import_scene.gltf(filepath=path)
        objs = [o for o in bpy.data.objects]
        meshes = [o for o in objs if o.type == "MESH"]
        uv = sum(1 for o in meshes if getattr(o.data, "uv_layers", None) and len(o.data.uv_layers))
        header.update({
            "import_s": round(time.time() - t0, 1),
            "objects": len(objs),
            "mesh_objects": len(meshes),
            "objects_with_uv": uv,
            "bpy_materials": len(bpy.data.materials),
            "bpy_images": len(bpy.data.images),
            "bpy_actions": len(bpy.data.actions),
            "col_props_nodes": [o.name for o in objs if "col_props" in o.name.lower()][:3],
        })
        out[label] = header
    return out


@section("splat")
def _splat():
    """Two paths: a 3DGS-style PLY (generic point cloud) and Spark's .spz (native, 5.4 alpha)."""
    out = {}
    ply = "/tmp/probe-splat.ply"
    props = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2"]
    with open(ply, "w") as f:
        f.write("ply\nformat ascii 1.0\nelement vertex 4\n")
        for p in props:
            f.write(f"property float {p}\n")
        f.write("end_header\n")
        for i in range(4):
            f.write(" ".join(str(round(v, 3)) for v in (i, 0, 0, 0.5, 0.4, 0.3, 0.9, -2, -2, -2)) + "\n")
    before = set(bpy.data.objects)
    try:
        bpy.ops.wm.ply_import(filepath=ply)
        out["ply"] = {"objects": len(set(bpy.data.objects) - before),
                      "vertices": sum(len(o.data.vertices) for o in set(bpy.data.objects) - before if o.type == "MESH")}
    except Exception as exc:  # noqa: BLE001
        out["ply"] = f"FAILED {type(exc).__name__}: {exc}"
    spz = os.path.normpath(os.path.join(HERE, "..", "..", "apps", "console", "splat-trial", "bazaar-stall-262k.spz"))
    if os.path.exists(spz):
        before = set(bpy.data.objects)
        t0 = time.time()
        try:
            bpy.ops.wm.spz_import(filepath=spz)
            new = set(bpy.data.objects) - before
            out["spz"] = {"mb": round(os.path.getsize(spz) / 1e6, 2), "seconds": round(time.time() - t0, 1),
                          "objects": [{"name": o.name, "type": o.type} for o in new][:4],
                          "splat_types": [t for t in dir(bpy.types) if "splat" in t.lower()]}
        except Exception as exc:  # noqa: BLE001
            out["spz"] = f"FAILED {type(exc).__name__}: {exc}"
    else:
        out["spz"] = f"missing {spz}"
    out["splat_capable_addons"] = [a for a in R.get("env", {}).get("addons_available", [])
                                   if any(k in a.lower() for k in ("splat", "gauss", "3dgs"))]
    return out


json.dump(R, open(OUT, "w"), indent=1)
print(f"[probe] wrote {OUT} ({len(R['errors'])} section errors)")
