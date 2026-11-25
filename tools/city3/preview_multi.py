"""Auto-framed multi-view preview of any GLB / GLTF / .blend:
    blender -b --python preview_multi.py -- <src> [outdir] [view ...]
views: front back left right threequarter closeup structural top   (default: all but top)
-> <outdir>/view_<name>.png (RGBA) + <outdir>/preview.json
Run `python3 sheet.py <outdir>` next to flatten onto the sky and label one contact sheet.

Framing is MEASURED, not guessed. Each ortho view renders its own alpha silhouette and
ortho_scale / camera height are iterated until the subject fills FILL and is centred.
Scene bound_box is never trusted: rigged GLBs carry detached IK/control geometry that
inflates it (cast-skeleton-warrior.glb reports 2.57 m of bbox height for a ~2.2 m visible
silhouette), which is what clipped the head in the first version of this tool.

Calibration fact worth keeping: for a landscape frame Blender's ORTHO `ortho_scale` is the
HORIZONTAL coverage (a 2 m cube at ortho_scale 2.0 fills the width exactly and is clipped
vertically at 4:3), so a fit needs  ortho_scale >= extent_h * RESX/RESY.

Env: FILL=0.90 RESX=720 RESY=540 ITERS=6 VIEW_TRANSFORM=Standard CALRES=full|half
     ENGINE=BLENDER_EEVEE|BLENDER_WORKBENCH

KTX2 caveat: the world GLBs store 238 of 241 images as image/ktx2, which Blender's
importer cannot decode (`IMB_load_image_from_memory: unknown file-format`), so every
EEVEE view of them renders with missing textures. Use ENGINE=BLENDER_WORKBENCH for
those: it is ~10x faster and loses nothing that was actually going to appear. For a
true textured look, render in the browser instead (three.js decodes KTX2 natively).
Exit 1 if any view renders empty, or if a non-closeup view clips the silhouette.

A 33 MB world GLB costs ~17 s to import and ~13 s per render, so for those pass a shorter
view list (e.g. `front left threequarter structural`) or lower RESX/RESY."""
import bpy, json, math, os, sys
import numpy as np
from mathutils import Vector

try:                                    # unbuffered progress when stdout is redirected
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
a = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if not a:
    sys.exit(__doc__)
SRC = os.path.abspath(a[0])
STEM = os.path.splitext(os.path.basename(SRC))[0]
VIEWS_ALL = ("front", "back", "left", "right", "threequarter", "closeup", "structural", "top")
VIEWS = [v for v in a[1:] if v in VIEWS_ALL]
OUT = os.path.abspath(a[1]) if len(a) > 1 and a[1] not in VIEWS_ALL \
    else f"{HERE}/out/prevm_{STEM}"
VIEWS = VIEWS or ["front", "back", "left", "right", "threequarter", "closeup", "structural"]
FILL = float(os.environ.get("FILL", "0.90"))
RESX = int(os.environ.get("RESX", "720"))
RESY = int(os.environ.get("RESY", "540"))
ITERS = int(os.environ.get("ITERS", "6"))
ASPECT = RESX / RESY
# Calibration renders at the same resolution as the final views by default. Half-res is
# available via CALRES=half for very large scenes (a 33 MB world costs 13 s per render),
# but it measures ~10% small, so it is an opt-in, not the default.
if os.environ.get("CALRES", "full").lower() in ("half", "h", "0.5"):
    CRX, CRY = (RESX // 2, RESY // 2)
else:
    CRX, CRY = RESX, RESY
os.makedirs(OUT, exist_ok=True)

# ---------------------------------------------------------------- load the source
if SRC.lower().endswith((".blend", ".blend1")):
    bpy.ops.wm.open_mainfile(filepath=SRC)
else:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=SRC)
s = bpy.context.scene
# Workbench is the right engine for KTX2-textured worlds: Blender cannot decode KTX2, so
# EEVEE would pay ~1 min/render compiling shaders for maps that never load.
ENGINE = os.environ.get("ENGINE", "BLENDER_EEVEE").upper()
s.render.engine = ENGINE
s.render.resolution_x, s.render.resolution_y = RESX, RESY
s.render.resolution_percentage = 100
s.render.film_transparent = True                      # alpha = free silhouette measurement
s.render.image_settings.file_format = "PNG"
s.render.image_settings.color_mode = "RGBA"
try:
    s.view_settings.view_transform = os.environ.get("VIEW_TRANSFORM", "Standard")
except TypeError:
    pass
s.display.render_aa = "8"

# ---------------------------------------------------------------- scene census
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
if not meshes:
    print("FAIL no mesh objects in", SRC); sys.exit(1)
CENSUS = dict(src=SRC, src_bytes=os.path.getsize(SRC), res=[RESX, RESY],
              objects=len(bpy.data.objects), meshes=len(meshes),
              verts=sum(len(m.data.vertices) for m in meshes),
              polys=sum(len(m.data.polygons) for m in meshes),
              materials=len(bpy.data.materials), images=len(bpy.data.images),
              bones=sum(len(x.bones) for x in bpy.data.armatures),
              actions=len(bpy.data.actions))

lo = Vector((1e18,) * 3); hi = Vector((-1e18,) * 3)
for o in meshes:
    for c in o.bound_box:
        p = o.matrix_world @ Vector(c)
        lo = Vector((min(lo[i], p[i]) for i in range(3)))
        hi = Vector((max(hi[i], p[i]) for i in range(3)))
DIMS = hi - lo
print("CENSUS", json.dumps({k: CENSUS[k] for k in
                            ("objects", "meshes", "verts", "polys", "bones", "actions")}))
print("BBOX", [round(v, 3) for v in lo], [round(v, 3) for v in hi],
      "DIMS", [round(v, 3) for v in DIMS])
# ---------------------------------------------------------------- world, light, camera
w = bpy.data.worlds.new("w"); w.use_nodes = True
bgn = w.node_tree.nodes["Background"]
bgn.inputs[0].default_value = (0.62, 0.74, 0.9, 1); bgn.inputs[1].default_value = 1.0
s.world = w
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
sun.data.energy = 4.0; sun.rotation_euler = (math.radians(50), 0, math.radians(35))
s.collection.objects.link(sun)
cd = bpy.data.cameras.new("prevm"); cam = bpy.data.objects.new("prevm", cd)
s.collection.objects.link(cam); cd.clip_end = 20000
s.camera = cam

TMP = os.path.join(OUT, "_cal.png")
s.render.filepath = TMP


def aim(direction, target, dist):
    """Point the shared camera at `target`, viewed from `target + direction*dist`."""
    cam.location = target + Vector(direction).normalized() * dist
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()


def render(path):
    s.render.filepath = path
    bpy.ops.render.render(write_still=True)
    return os.path.getsize(path) if os.path.exists(path) else 0


def measure(path, rx=None, ry=None):
    """Silhouette stats from the rendered alpha, or None if nothing rendered."""
    rx, ry = rx or RESX, ry or RESY
    if not os.path.exists(path):
        return None
    im = bpy.data.images.load(path)
    buf = np.empty(len(im.pixels), dtype=np.float32)
    try:
        im.pixels.foreach_get(buf)
    except AttributeError:
        buf[:] = np.asarray(im.pixels[:], dtype=np.float32)
    bpy.data.images.remove(im)
    al = buf.reshape(-1, 4)[:, 3].reshape(ry, rx)
    m = al > (10 / 255)
    if not m.any():
        return None
    ys, xs = np.where(np.flipud(m))                    # row 0 = top of frame
    return dict(coverage=round(float(m.mean()), 4),
                w=round(float((xs.max() - xs.min() + 1) / rx), 3),
                h=round(float((ys.max() - ys.min() + 1) / ry), 3),
                cx=round(float((xs.min() + xs.max()) / 2 / rx - 0.5), 4),
                cy=round(float((ys.min() + ys.max()) / 2 / ry - 0.5), 4),
                clip_top=bool(ys.min() <= 1), clip_bot=bool(ys.max() >= ry - 2),
                clip_left=bool(xs.min() <= 1), clip_right=bool(xs.max() >= rx - 2))


def calibrate(direction):
    """Fit an ortho view by MEASUREMENT: render, read the alpha silhouette, solve, repeat.

    In ortho projection the subject's on-screen size is inversely proportional to
    ortho_scale, so the scale that lands exactly on the target is solved in closed form each
    pass instead of stepped toward  --  stepping oscillates forever on a subject whose aspect
    cannot reach FILL (a 26 m wide, 12 m tall building is width-bound at ~58% vertical fill).

    y_off < 0 means the subject sits HIGH in frame, so the camera must move UP to push it
    down (z -= y_off * vert_cov); that sign inverted diverges the loop.
    Returns (ortho_scale, centre_z, iterations, last_stats, bound).
    """
    centre = (lo + hi) / 2
    scale = max(DIMS) * 2.2                            # start generous: unclipped first pass
    z, st, bound = centre.z, None, "height"
    s.render.resolution_x, s.render.resolution_y = CRX, CRY
    try:
        for i in range(ITERS):
            cd.type = "ORTHO"; cd.ortho_scale = scale
            aim(direction, Vector((centre.x, centre.y, z)), max(DIMS) * 6)
            render(TMP)
            st = measure(TMP, CRX, CRY)
            if st is None:                             # pointed at nothing: back off
                scale *= 1.6
                continue
            if st["clip_top"] or st["clip_bot"] or st["clip_left"] or st["clip_right"]:
                scale *= 1.15                          # fine step: a clipped bbox is a lower bound
                continue
            z -= st["cy"] * scale * CRY / CRX          # re-centre vertically
            s_h = scale * st["h"] / FILL               # scale that hits FILL on height
            s_w = scale * st["w"] / 0.98               # scale that nearly fills the width
            bound = "width" if s_w > s_h else "height"
            new = max(s_h, s_w) * 1.02
            if abs(new - scale) / scale < 0.02 and abs(st["cy"]) < 0.02:
                return scale, z, i + 1, st, bound
            scale = new
    finally:
        s.render.resolution_x, s.render.resolution_y = RESX, RESY
    return scale, z, ITERS, st, bound
# ---------------------------------------------------------------- framing plan
def projected_w(direction):
    """Horizontal world extent of the bbox as seen from `direction`."""
    q = (-Vector(direction)).to_track_quat("-Z", "Y")
    right = q @ Vector((1, 0, 0))
    c0 = (lo + hi) / 2
    cs = [Vector((x, y, z)) for x in (lo.x, hi.x) for y in (lo.y, hi.y) for z in (lo.z, hi.z)]
    return max(abs((c - c0).dot(right)) for c in cs) * 2


def calibrate_persp(direction):
    """Same measure-then-solve loop for the perspective view.

    Seed = bounding-sphere fit with the narrower FOV (can never clip, but is loose for a
    tall thin rig: cast-skeleton-warrior.glb landed at 36% fill). Apparent size in
    perspective is proportional to 1/distance, so each pass solves  d *= h/FILL.
    Returns (distance, centre_z, iterations, last_stats) -- the re-centred z must be used
    by the final render, or the subject lands off-centre and clips.
    """
    d = (DIMS.length / 2) * 1.06 / math.sin(min(HFOV, VFOV) / 2)
    z = CAL_Z if "CAL_Z" in globals() else (lo.z + hi.z) / 2
    cvfov = 2 * math.atan((18.0 * CRY / CRX) / LENS)   # vertical FOV at calibration res
    st = None
    best = (d, z, None)
    s.render.resolution_x, s.render.resolution_y = CRX, CRY
    try:
        for i in range(6):
            cd.type = "PERSP"; cd.lens = LENS
            aim(direction, Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, z)), d)
            render(TMP)
            st = measure(TMP, CRX, CRY)
            if st is None:
                d *= 1.5
                continue
            if st["clip_top"] or st["clip_bot"] or st["clip_left"] or st["clip_right"]:
                d *= 1.12                              # fine step: 1.25 overshot past FILL
                continue
            z -= st["cy"] * 2 * d * math.tan(cvfov / 2)  # re-centre vertically
            best = (d, z, st)                          # remember a pair that WAS rendered
            if abs(st["h"] - FILL) < 0.03 and abs(st["cy"]) < 0.02:
                return d, z, i + 1, st
            d *= st["h"] / FILL
    finally:
        s.render.resolution_x, s.render.resolution_y = RESX, RESY
    # returning d after the last d*=... would hand back a distance that was never
    # rendered, so the fill we print would not match the image we ship.
    return best[0], best[1], 6, best[2]


CAL_S, CAL_Z, CAL_IT, CAL_ST, CAL_B = calibrate((0, -1, 0))
if CAL_ST is None:
    print("FAIL calibration rendered nothing for", SRC); sys.exit(1)
print("CALIBRATED front ortho_scale=%.3f centre_z=%.3f iters=%d fill=%.1f%% bound=%s"
      % (CAL_S, CAL_Z, CAL_IT, CAL_ST["h"] * 100, CAL_B))
# The side axis is calibrated separately: one scale cannot serve both. A 26 m wide,
# 12 m tall building fitted on height alone clips in x, and fitted on width alone
# leaves ~60% vertical fill -- so each axis gets its own measured fit.
if {"left", "right"} & set(VIEWS):
    LS, LZ, LIT, LST, LB = calibrate((-1, 0, 0))
else:
    LS, LZ, LIT, LST, LB = CAL_S, CAL_Z, 0, None, CAL_B
if LST:
    print("CALIBRATED side  ortho_scale=%.3f centre_z=%.3f iters=%d fill=%.1f%% bound=%s"
          % (LS, LZ, LIT, LST["h"] * 100, LB))

CX, CY = (lo.x + hi.x) / 2, (lo.y + hi.y) / 2
CLOSE_S = CAL_S * 0.5
CLOSE_Z = (CAL_Z + CAL_S * RESY / RESX * FILL / 2) - CLOSE_S * RESY / RESX / 2
LENS = 50.0
HFOV = 2 * math.atan(18.0 / LENS)                        # sensor 36 mm, AUTO fit -> width
VFOV = 2 * math.atan((18.0 * RESY / RESX) / LENS)
# a sphere fit can never clip but is loose for a tall thin rig, so measure the distance too
if "threequarter" in VIEWS:
    PERSP_D, PERSP_Z, PIT, PST = calibrate_persp((0.85, -1, 0.45))
else:
    PERSP_D = (DIMS.length / 2) * 1.06 / math.sin(min(HFOV, VFOV) / 2)
    PERSP_Z, PIT, PST = CAL_Z, 0, None
if PST:
    print("CALIBRATED persp dist=%.3f centre_z=%.3f iters=%d fill=%.1f%%"
          % (PERSP_D, PERSP_Z, PIT, PST["h"] * 100))

PLAN = []           # (name, direction, mode, size, centre_z, engine, expect_crop)
for nm, d, s_, z_ in (("front", (0, -1, 0), CAL_S, CAL_Z), ("back", (0, 1, 0), CAL_S, CAL_Z),
                      ("left", (-1, 0, 0), LS, LZ), ("right", (1, 0, 0), LS, LZ)):
    PLAN.append((nm, d, "ortho", s_, z_, ENGINE, False))
PLAN.append(("threequarter", (0.85, -1, 0.45), "persp", PERSP_D, PERSP_Z, ENGINE, False))
PLAN.append(("closeup", (0.45, -1, 0.12), "ortho", CLOSE_S, CLOSE_Z, ENGINE, True))
PLAN.append(("structural", (0.0, -1, 0.0), "ortho", CAL_S, CAL_Z, "BLENDER_WORKBENCH", False))
PLAN.append(("top", (0, 0, 1), "ortho",
             max(projected_w((0, 0, 1)), projected_w((1, 0, 0)) * ASPECT) * 1.05,
             CAL_Z, ENGINE, False))
PLAN = [p for p in PLAN if p[0] in VIEWS]

# ---------------------------------------------------------------- render the views
sh = s.display.shading
sh.light = "STUDIO"
sh.color_type = os.environ.get("STRUCT_COLOR", "SINGLE")
sh.show_cavity = True
sh.cavity_type = "BOTH"
sh.show_object_outline = True
sh.background_type = "VIEWPORT"
sh.background_color = (0.62, 0.74, 0.9)

RESULT = {}
FAILS = []
for nm, direction, mode, size, zc, engine, expect_crop in PLAN:
    s.render.engine = engine
    target = Vector((CX, CY, CAL_Z if nm == "top" else zc))
    cd.type = "ORTHO" if mode == "ortho" else "PERSP"
    if mode == "ortho":
        cd.ortho_scale = size
        aim(direction, target, max(DIMS) * 4)
    else:
        cd.lens = 50.0
        aim(direction, target, size)                    # size = camera distance here
    path = os.path.join(OUT, f"view_{nm}.png")
    for attempt in range(2):
        if mode == "ortho":
            cd.ortho_scale = size
            aim(direction, target, max(DIMS) * 4)
        else:
            cd.lens = 50.0
            aim(direction, target, size)                # size = camera distance here
        nbytes = render(path)
        st = measure(path)
        if st is None:
            break
        clipped = [k for k in ("clip_top", "clip_bot", "clip_left", "clip_right") if st[k]]
        # Stop unless the shot is short on fill with horizontal room to grow: the
        # calibration pass only seeds this, so correcting once here guarantees the
        # shipped image matches FILL whatever the seed converged to.
        if (clipped or expect_crop or mode != "ortho" or st["w"] >= 0.90
                or abs(st["h"] - FILL) <= 0.06):
            break
        vc = size * RESY / RESX if mode == "ortho" else 2 * size * math.tan(VFOV / 2)
        target = Vector((target.x, target.y, target.z - st["cy"] * vc))
        size *= st["h"] / FILL
    RESULT[nm] = dict(file=os.path.basename(path), bytes=nbytes, stats=st,
                      expect_crop=expect_crop, attempts=attempt + 1)
    if st is None:
        print("  FAIL", nm, "rendered empty"); FAILS.append(nm); continue
    if clipped and not expect_crop:
        print("  FAIL", f"{nm} clips {clipped}"); FAILS.append(nm)
    else:
        print("  ok  ", f"{nm:12s} fill={st['h']*100:5.1f}% cov={st['coverage']*100:5.1f}% "
                        f"c=({st['cx']*100:+.1f}%,{st['cy']*100:+.1f}%) "
                        f"{'crop:'+','.join(clipped) if clipped else 'unclipped'} "
                        f"{nbytes // 1024} KB" + (" (corrected)" if attempt else ""))

s.render.engine = ENGINE
if os.path.exists(TMP):
    os.remove(TMP)
DOC = dict(census=CENSUS, bbox=dict(lo=[round(v, 3) for v in lo], hi=[round(v, 3) for v in hi]),
           dims=[round(v, 3) for v in DIMS], fill=FILL,
           calibration=dict(ortho_scale=round(CAL_S, 3), centre_z=round(CAL_Z, 3),
                            iterations=CAL_IT, bound=CAL_B, stats=CAL_ST,
                            side=dict(ortho_scale=round(LS, 3), centre_z=round(LZ, 3),
                                      iterations=LIT, bound=LB, stats=LST),
                            persp=dict(distance=round(PERSP_D, 3), centre_z=round(PERSP_Z, 3),
                                       iterations=PIT, stats=PST)),
           views=RESULT)
with open(os.path.join(OUT, "preview.json"), "w") as f:
    json.dump(DOC, f, indent=1)
print("WROTE", os.path.join(OUT, "preview.json"))
print("FAILED" if FAILS else "ALL OK", len(FAILS), "failures")
sys.exit(1 if FAILS else 0)

