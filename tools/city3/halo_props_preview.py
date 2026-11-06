"""Preview row of every halo_props prop: blender -b --python halo_props_preview.py [-- <outdir>]
Writes props_<view>.png (EEVEE, low warm sun) and prints triangles per prop."""
import bpy, math, os, random, sys
from mathutils import Vector
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from mkit import *
from mkit import _principled
import kit, halo_props as HP
OUT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else f"{HERE}/out"
clear_blender()
palette_mat("palette"); palette_mat("led", emit=3.0); palette_mat("water", rough=0.03); glass_mat("shopglass")
def solid_mat(key, rgb, rough, metal):
    m, nt, b = _principled(key); b.inputs["Base Color"].default_value = (*rgb, 1.0); b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = metal
    MATS[key] = m; return m
solid_mat("gold", (0.93, 0.64, 0.3), 0.3, 1.0); solid_mat("chrome", (0.86, 0.88, 0.9), 0.22, 1.0); solid_mat("marble", (0.93, 0.9, 0.85), 0.45, 0.0)

TRIS = {}
def count(name, fn, *a, **k):
    t0 = kit.total(); fn(*a, **k); TRIS.setdefault(name, []).append(kit.total() - t0)
rng = random.Random(7)
pquad("palette", (-40, -45, 0), (60, -45, 0), (60, 12, 0), (-40, 12, 0), "sand", (0, 0, 1))           # ground (north half)
pquad("water", (-40, -80, -0.4), (60, -80, -0.4), (60, -45, -0.4), (-40, -45, -0.4), "water", (0, 0, 1))
pbox(-40, -46, 60, -45, -0.4, 0.0, "white")                                                             # quay edge
# row 1: cars (y = 0), every paint
for k, c in enumerate(["white", "tile_white", "alu", "cream", "navy", "teal", "red", "black"]):
    count("car", HP.car, -30 + k * 6.0, 0, 0, math.radians(90 + (k % 2) * 180 if k < 6 else 30), rng, color=c)
# row 2: small props (y = -10)
for k in range(4): count("parasol", HP.parasol, -30 + k * 4.5, -10, 0, rng)
count("kiosk", HP.kiosk, -6, -10, 0, rng)
for k in range(3): count("lounger", HP.lounger, 1 + k * 1.2, -10, 0, math.radians(90), rng)
count("bin", HP.bin, 7, -10, 0); count("bollard", HP.bollard, 8, -10, 0); count("bollard", HP.bollard, 9, -10, 0)
# row 3: same small props with halo.py's solid/glass materials (y = -20)
HP.use_halo_materials()
count("kiosk_halo", HP.kiosk, -6, -20, 0, rng); count("bin_halo", HP.bin, 0, -20, 0); count("bollard_halo", HP.bollard, 1, -20, 0)
for k in range(2): count("car_halo", HP.car, 5 + k * 6, -20, 0, math.radians(-60), rng)
# row 4: boats in the water (y = -58)
count("yacht", HP.yacht, -25, -55, -0.4, math.radians(0), rng, length=9.0)
count("yacht", HP.yacht, -8, -55, -0.4, math.radians(180), rng, length=14.0)
count("sailboat", HP.sailboat, 10, -55, -0.4, math.radians(0), rng, length=10.0)
count("sailboat", HP.sailboat, 26, -55, -0.4, math.radians(200), rng, length=8.0)
count("yacht", HP.yacht, 40, -64, -0.4, math.radians(30), rng, length=12.0)
realise({})
for n, v in TRIS.items(): print(f"TRIS {n}: {v}")

s = bpy.context.scene; s.render.engine = "BLENDER_EEVEE"; s.render.resolution_x = 1400; s.render.resolution_y = 860; s.eevee.taa_render_samples = 16
w = bpy.data.worlds.new("w"); w.use_nodes = True; w.node_tree.nodes["Background"].inputs[0].default_value = (0.62, 0.72, 0.9, 1); w.node_tree.nodes["Background"].inputs[1].default_value = 0.9; s.world = w
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN")); sun.data.energy = 4.0; sun.data.color = (1.0, 0.86, 0.68)
sun.rotation_euler = (math.radians(62), 0, math.radians(-50)); s.collection.objects.link(sun); s.view_settings.view_transform = "AgX"; s.view_settings.look = "AgX - Punchy"
def shot(tag, loc, tgt, lens=35):
    cd = bpy.data.cameras.new(tag); cam = bpy.data.objects.new(tag, cd); s.collection.objects.link(cam); cam.location = loc
    cam.rotation_euler = (Vector(tgt) - Vector(loc)).to_track_quat("-Z", "Y").to_euler(); cd.lens = lens; cd.clip_end = 2000
    s.camera = cam; s.render.filepath = f"{OUT}/props_{tag}.png"; bpy.ops.render.render(write_still=True); print("RENDERED", s.render.filepath)
views = sys.argv[sys.argv.index("--") + 2:] if "--" in sys.argv else []
V = {"overview": ((10, 30, 30), (5, -25, 0), 24), "cars": ((-12, 12, 2.2), (-12, 0, 0.6), 26), "cars_rear": ((-20, -9, 1.6), (-20, 0, 0.6), 30),
     "small": ((-14, -2, 3.5), (-12, -10, 1.0), 28), "halo": ((2, -11, 3.0), (2, -20, 0.8), 30), "boats": ((0, -38, 7), (5, -57, 1.5), 26),
     "boats_low": ((-15, -70, 2.0), (-15, -55, 2.0), 22), "top": ((-12, -2, 12), (-12, -8, 0), 30), "car_side": ((8.6, 6.0, 1.0), (12, 0, 0.7), 32), "car_34": ((-1.5, 5.5, 1.5), (-6, 0, 0.6), 30),
     "lounge": ((3.5, -6.5, 1.6), (2.2, -10, 0.4), 30), "yacht_top": ((-8, -45, 30), (-8, -55, 0), 30)}
for v in (views or list(V)): shot(v, *V[v])
