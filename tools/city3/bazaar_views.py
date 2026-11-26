"""Curated camera views of the City 3 bazaar, for looking at the stalls.

    blender -b --python tools/city3/bazaar_views.py -- [<world.glb>] [<outdir>] [view ...]
    views: aisle | hero | close | quad | wide | lanterns        (default: all)
    ENGINE=BLENDER_EEVEE|BLENDER_WORKBENCH   RESX/RESY   LENS

The bazaar is 80 stalls on a 9 m grid between x,z = +/-17 and +/-54, with the fountain
at the origin. These cameras are placed where a person would stand: eye height 1.65 m,
inside the aisle, or 2.5 m back from a single stall. glTF is Y-up and Blender imports
it Z-up, so every position below is written in glTF (x, y, z) and converted once --
`to_blender(x, y, z) -> (x, -z, y)` -- which is the mapping that has caught two
sign errors in this repo already (see docs/procedural-city/03-blender-gltf-lessons.md).

KTX2 caveat: the world's other 106 images are KTX2 and Blender cannot decode them, so
only the two new stalls (PNG/JPEG) show colour under EEVEE. That is not a defect in
the stalls -- it is the reason the browser preview stays the final texture check.
"""
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
_pos = [a for a in ARGS if not a.startswith("-") and a not in
        ("aisle", "hero", "close", "top", "lanterns")]
GLB = f"{HERE}/../../apps/console/public/assets/world-city3.glb"
OUT = "/tmp/bazaar_views"
for a in _pos:                       # first positional may be the GLB, then the outdir
    if a.endswith((".glb", ".gltf")):
        GLB = a
    elif not OUT or OUT == "/tmp/bazaar_views":
        OUT = a
WANT = [a for a in ARGS if a in ("aisle", "hero", "close", "top", "lanterns")]
if not WANT:
    WANT = ["hero", "close", "pair", "aisle", "quad", "wide", "lanterns"]
ENGINE = os.environ.get("ENGINE", "BLENDER_EEVEE")
RESX = int(os.environ.get("RESX", 1280))
RESY = int(os.environ.get("RESY", 800))


def to_blender(x, y, z):
    """glTF metres -> Blender metres (the importer's Y-up -> Z-up permute)."""
    return Vector((x, -z, y))


# name -> (camera glTF position, target glTF position, lens mm)
VIEWS = {
    # standing in the aisle between the x=17 and x=26 rows, looking down the row
    "aisle": ((13.4, 1.65, 50.0), (20.0, 1.35, 22.0), 24),
    # 3.6 m three-quarter on one stall: the composition the probe liked best (stall 56
    # of 209 cells at 3.5-5.8 m, no tree or pot inside 3 m)
    "hero": ((13.9, 1.65, 57.4), (17.3, 1.15, 53.9), 32),
    # right at one stall's counter
    "close": ((15.4, 1.55, 57.2), (17.3, 1.00, 53.8), 30),
    # above the south-east quadrant, 45 degrees down
    "top": ((26.0, 46.0, 42.0), (26.01, 0.0, 42.01), 50),
    # looking up at the lanterns under a canopy
    "lanterns": ((17.0, 1.30, 55.4), (17.0, 2.70, 53.4), 22),
}


def probe(views):
    """Cast a grid of rays through each camera and print what is actually in frame.

    A render is only inspectable by eye; a hit census is inspectable in a terminal and
    cannot be fooled by lighting. Each cell is the first object a ray meets, with its
    distance, so `hero` reading `STALL_A x14, cloth` means the stall fills a quarter of
    the frame from 2.6 m -- which is the claim the picture is supposed to support.
    """
    import numpy as np
    from mathutils import Vector as V
    depsgraph = bpy.context.evaluated_depsgraph_get()
    s = bpy.context.scene
    for name in views:
        loc, tgt, lens = VIEWS[name]
        cam_loc = to_blender(*loc)
        cam_rot = (to_blender(*tgt) - cam_loc).to_track_quat("-Z", "Y")
        # Blender sensor is 36 mm wide; derive the frustum half-angles from the lens
        hx = 18.0 / lens
        hy = hx * (RESY / RESX)
        right = cam_rot @ V((1, 0, 0))
        up = cam_rot @ V((0, 1, 0))
        fwd = cam_rot @ V((0, 0, -1))
        cells, counts, dists = [], {}, {}
        for j in range(11):                     # top row first, like a picture
            row = []
            for i in range(19):
                u = (i / 18.0 * 2 - 1) * hx
                v = (1 - j / 10.0 * 2) * hy
                d = (fwd + right * u + up * v).normalized()
                hit, point, _n, _i, obj, _m = s.ray_cast(depsgraph, cam_loc, d)
                if not hit:
                    row.append(".")
                    continue
                key = obj.name.split(".")[0]
                row.append(key[:1].upper() if key.startswith(("STALL", "SK")) else
                           ("#" if key in ("cobble", "palette") else "o"))
                counts[key] = counts.get(key, 0) + 1
                d = dists.setdefault(key, [])
                d.append(((point - cam_loc).length, point.y))
            cells.append("".join(row))
        print(f"\n== {name}  camera {loc} -> {tgt}  {lens}mm")
        for row in cells:
            print("   " + row)
        for key, n in sorted(counts.items(), key=lambda kv: -kv[1])[:8]:
            dist = [a for a, _b in dists[key]]
            ys = [b for _a, b in dists[key]]
            print(f"   {key:26s} {n:3d} cells  {min(dist):5.2f}..{max(dist):5.2f} m"
                  f"  hit y {min(ys):4.2f}..{max(ys):4.2f}")


def main():
    os.makedirs(OUT, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=GLB)
    if "--probe" in ARGS or os.environ.get("PROBE"):
        bpy.context.view_layer.update()
        probe(WANT)
        return
    s = bpy.context.scene
    s.render.engine = ENGINE
    s.render.resolution_x, s.render.resolution_y = RESX, RESY
    if ENGINE == "BLENDER_WORKBENCH":
        sh = s.display.shading
        sh.light, sh.color_type = "STUDIO", "TEXTURE"
        sh.show_shadows = sh.show_cavity = True
    else:
        s.eevee.taa_render_samples = 16
        w = bpy.data.worlds.new("w")
        w.use_nodes = True
        bg = w.node_tree.nodes["Background"]
        bg.inputs[0].default_value = (0.55, 0.70, 0.92, 1)
        bg.inputs[1].default_value = 1.0
        s.world = w
        sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
        sun.data.energy = 3.5
        sun.rotation_euler = (0.91, 0, 0.61)
        s.collection.objects.link(sun)
        s.view_settings.view_transform = "AgX"
    for name in WANT:
        loc, tgt, lens = VIEWS[name]
        cd = bpy.data.cameras.new(name)
        cd.lens, cd.clip_end = lens, 4000
        cam = bpy.data.objects.new(name, cd)
        s.collection.objects.link(cam)
        cam.location = to_blender(*loc)
        cam.rotation_euler = (to_blender(*tgt) - cam.location).to_track_quat("-Z", "Y").to_euler()
        s.camera = cam
        s.render.filepath = os.path.join(OUT, f"{name}.png")
        bpy.ops.render.render(write_still=True)
        print("RENDERED", s.render.filepath)


if __name__ == "__main__":
    main()
