"""Rig the static "Humano 01 Business" scan (apps/console/public/assets/catalog/humano-business.glb) with the same 28-bone
Mixamo template the Meshy characters (Elf, Jim) use, so tools/city3/bake_meshy.py can retarget Body Block's clip catalog onto it.

The scan has no skeleton and its source texture maps (Maps/*.jpg) are not in the repo, so this script also
  * paints flat region colours (suit, shirt, tie, skin, hair, shoes) as material slots chosen per face from the geometry;
  * fits the skeleton to the mesh by slicing it (hip/knee/ankle centres per leg, torso centroid per height);
  * weights vertices by distance to the nearest bone capsules (no heat-map solve: the hands are inside the pockets and the
    arms touch the jacket, which makes automatic weights fail);
  * straightens the stepped stance (one foot ahead) so the rest pose is symmetric like the other bodies.
The figure walks with its hands in its pockets: bake it with BAKE_FREEZE=Shoulder,Arm,Hand so the arm chain follows the spine.

Run:  tools/city3/blender_lock.sh -b --python tools/city3/rig_humano.py -- <out-rigged.glb> [preview-dir]
Then: BAKE_FREEZE=Shoulder,Arm,Hand tools/city3/blender_lock.sh -b --python tools/city3/bake_meshy.py -- <out-rigged.glb> apps/console/public/assets/cast-business.glb
Character faces -y in the source (Blender z up); character left = +x."""
import bpy, sys, math, os
from mathutils import Vector, Matrix

ARGS = sys.argv[sys.argv.index("--") + 1:]
OUT = ARGS[0]
PREVIEW = ARGS[1] if len(ARGS) > 1 else None
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "..", "apps", "console", "public", "assets", "catalog", "humano-business.glb")
KEEP = "Humano_01Business_01_30K_001"

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
M = next(o for o in meshes if o.name == KEEP)
for o in meshes:
    if o is not M: bpy.data.objects.remove(o, do_unlink=True)
for o in [o for o in bpy.data.objects if o.type == "EMPTY"]: bpy.data.objects.remove(o, do_unlink=True)
M.parent = None
bpy.context.view_layer.objects.active = M; M.select_set(True)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
me = M.data
zmin = min(v.co.z for v in me.vertices); xs = [v.co.x for v in me.vertices]
for v in me.vertices: v.co.z -= zmin                      # feet on z = 0
cx = (max(xs) + min(xs)) / 2
for v in me.vertices: v.co.x -= cx                       # centred on x = 0 (symmetry axis of the torso)
H = max(v.co.z for v in me.vertices)
print("height", round(H, 3))
V = [v.co.copy() for v in me.vertices]

def band(z0, z1, side=0, xlim=9.0):
    """Vertices with z in [z0, z1]; side +1/-1 keeps only that x sign (|x| > 0.015), |x| < xlim."""
    return [p for p in V if z0 <= p.z <= z1 and abs(p.x) < xlim and (side == 0 or (p.x * side > 0.015))]
def cen(pts): return Vector((sum(p.x for p in pts) / len(pts), sum(p.y for p in pts) / len(pts), sum(p.z for p in pts) / len(pts)))

# ---- joints (character left = +x; front = -y)
J = {}
for s, name in ((1, "Left"), (-1, "Right")):
    hip = cen(band(0.80, 0.90, s, 0.17)); knee = cen(band(0.46, 0.54, s)); ank = cen(band(0.07, 0.12, s))
    foot = band(0.0, 0.05, s)
    tip_y = min(p.y for p in foot)
    J[name + "UpLeg"] = Vector((s * 0.085, hip.y, 0.88))
    J[name + "Leg"] = Vector((knee.x, knee.y, 0.49))
    J[name + "Foot"] = Vector((ank.x, ank.y, 0.085))
    J[name + "ToeBase"] = Vector((ank.x, ank.y + (tip_y - ank.y) * 0.65, 0.03))
    J[name + "Toe_End"] = Vector((ank.x, tip_y + 0.01, 0.02))
torso = lambda z: cen(band(z - 0.03, z + 0.03, 0, 0.17))
J["Hips"] = Vector((0, torso(0.95).y, 0.95))
for nm, z in (("Spine", 1.08), ("Spine1", 1.22), ("Spine2", 1.36), ("Neck", 1.52), ("Head", 1.60)):
    J[nm] = Vector((0, torso(z).y, z))
J["HeadTop_End"] = Vector((0, J["Head"].y, H))
for s, name in ((1, "Left"), (-1, "Right")):
    J[name + "Shoulder"] = Vector((s * 0.035, J["Spine2"].y, 1.49))
    J[name + "Arm"] = Vector((s * 0.205, J["Spine2"].y + 0.01, 1.47))
    J[name + "ForeArm"] = Vector((s * 0.31, J["Spine2"].y + 0.07, 1.15))
    J[name + "Hand"] = Vector((s * 0.215, J["Spine2"].y + 0.02, 0.93))
    J[name + "HandMiddle4"] = Vector((s * 0.20, J["Spine2"].y, 0.87))

BONES = [  # name, parent, head joint, tail joint
    ("Hips", None, "Hips", "Spine"), ("Spine", "Hips", "Spine", "Spine1"), ("Spine1", "Spine", "Spine1", "Spine2"),
    ("Spine2", "Spine1", "Spine2", "Neck"), ("Neck", "Spine2", "Neck", "Head"), ("Head", "Neck", "Head", "HeadTop_End"),
]
for n in ("Left", "Right"):
    BONES += [(n + "UpLeg", "Hips", n + "UpLeg", n + "Leg"), (n + "Leg", n + "UpLeg", n + "Leg", n + "Foot"),
              (n + "Foot", n + "Leg", n + "Foot", n + "ToeBase"), (n + "ToeBase", n + "Foot", n + "ToeBase", n + "Toe_End"),
              (n + "Shoulder", "Spine2", n + "Shoulder", n + "Arm"), (n + "Arm", n + "Shoulder", n + "Arm", n + "ForeArm"),
              (n + "ForeArm", n + "Arm", n + "ForeArm", n + "Hand"), (n + "Hand", n + "ForeArm", n + "Hand", n + "HandMiddle4")]
LEAF = {"HeadTop_End", "Toe_End", "HandMiddle4"}

arm_data = bpy.data.armatures.new("Armature"); A = bpy.data.objects.new("Armature", arm_data)
bpy.context.scene.collection.objects.link(A); bpy.context.view_layer.objects.active = A
bpy.ops.object.mode_set(mode="EDIT")
eb = arm_data.edit_bones
for name, parent, h, t in BONES:
    b = eb.new("mixamorig:" + name); b.head = J[h]; b.tail = J[t]
    if (b.tail - b.head).length < 0.02: b.tail = b.head + Vector((0, 0, 0.05))
    if t in LEAF: b.tail = b.head + (J[t] - J[h]).normalized() * max((J[t] - J[h]).length, 0.03)
for name, parent, h, t in BONES:
    if parent: eb["mixamorig:" + name].parent = eb["mixamorig:" + parent]
bpy.ops.object.mode_set(mode="OBJECT")

# ---- weights: inverse-distance to the nearest bone capsules (top 3), with a few region rules
segs = {"mixamorig:" + n: (J[h], J[t]) for n, p, h, t in BONES}
def dist_seg(p, a, b):
    ab = b - a; t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-9))); return (p - (a + ab * t)).length
M.vertex_groups.clear()
vg = {n: M.vertex_groups.new(name=n) for n in segs}
for v in me.vertices:
    p = v.co
    allowed = list(segs)
    if p.z > 1.58: allowed = ["mixamorig:Head", "mixamorig:Neck"]                       # head and neck move as one piece
    elif abs(p.x) < 0.10 and p.z > 0.95: allowed = [n for n in allowed if "Arm" not in n and "Hand" not in n and "Shoulder" not in n]
    elif p.z < 0.80: allowed = [n for n in allowed if "Leg" in n or "Foot" in n or "Toe" in n or n.endswith("Hips")]
    d = sorted(((dist_seg(p, *segs[n]), n) for n in allowed))[:3]
    w = [1.0 / (max(x, 1e-3) ** 4) for x, _ in d]; tot = sum(w)
    for (x, n), wi in zip(d, w): vg[n].add([v.index], wi / tot, "REPLACE")
M.parent = A; mod = M.modifiers.new("Armature", "ARMATURE"); mod.object = A

# ---- straighten the stance: bring the forward foot back level with the other (rotate the leg chain about the hip)
def pose_leg(side):
    up = A.pose.bones["mixamorig:%sUpLeg" % side]
    return up
ya = {n: J[n + "Foot"].y for n in ("Left", "Right")}
print("ankle y left/right", round(ya["Left"], 3), round(ya["Right"], 3))
fwd_side = "Left" if ya["Left"] < ya["Right"] else "Right"
back_side = "Right" if fwd_side == "Left" else "Left"
target_y = (ya["Left"] + ya["Right"]) / 2
for side in (fwd_side, back_side):
    pb = A.pose.bones["mixamorig:%sUpLeg" % side]
    hip = J[side + "UpLeg"]; ank = J[side + "Foot"]
    cur = math.atan2(ank.y - hip.y, hip.z - ank.z); want = math.atan2(target_y - hip.y, hip.z - ank.z)
    # rotate about the world x axis at the hip joint
    ang = want - cur
    bpy.context.view_layer.objects.active = A; bpy.ops.object.mode_set(mode="POSE")
    pb.rotation_mode = "XYZ"
    pb.rotation_euler = (-ang, 0, 0) if False else (ang, 0, 0)
    bpy.ops.object.mode_set(mode="OBJECT")
    # keep the foot flat: undo the foot's inherited tilt
    ft = A.pose.bones["mixamorig:%sFoot" % side]; ft.rotation_mode = "XYZ"; ft.rotation_euler = (-ang, 0, 0)
bpy.context.view_layer.update()
# bake the straightened pose into the mesh and make it the rest pose
bpy.context.view_layer.objects.active = M
bpy.ops.object.modifier_apply(modifier="Armature")
bpy.context.view_layer.objects.active = A; bpy.ops.object.mode_set(mode="POSE")
bpy.ops.pose.armature_apply(selected=False); bpy.ops.object.mode_set(mode="OBJECT")
M.modifiers.new("Armature", "ARMATURE").object = A
V = [v.co.copy() for v in me.vertices]
ank = {s: cen([p for p in V if 0.07 <= p.z <= 0.12 and p.x * (1 if s == "Left" else -1) > 0.015]) for s in ("Left", "Right")}
print("after straighten: ankle y", round(ank["Left"].y, 3), round(ank["Right"].y, 3))

# ---- flat region colours as material slots, chosen per face
def mat(name, rgb, rough=0.8):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = (*rgb, 1); b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = 0
    m.diffuse_color = (*rgb, 1)   # workbench previews use this
    return m
SLOTS = [("biz_suit", (0.035, 0.05, 0.11), 0.75), ("biz_shirt", (0.82, 0.83, 0.86), 0.7), ("biz_tie", (0.30, 0.03, 0.05), 0.5),
         ("biz_skin", (0.62, 0.42, 0.33), 0.6), ("biz_hair", (0.10, 0.06, 0.04), 0.6), ("biz_shoes", (0.02, 0.018, 0.016), 0.35)]
me.materials.clear()
for n, c, r in SLOTS: me.materials.append(mat(n, c, r))
head_c = cen(band(1.62, 1.78, 0, 0.12))
for poly in me.polygons:
    c = poly.center; nrm = poly.normal
    k = 0                                                                  # suit
    front = nrm.y < -0.35
    if c.z < 0.085: k = 5
    elif c.z > 1.54:
        k = 4 if (c.z > 1.77 or (c.z > 1.66 and c.y > head_c.y + 0.015) or (c.z > 1.70 and abs(c.x) > 0.075 and c.y > head_c.y - 0.03)) else 3
        if c.z < 1.60: k = 3 if abs(c.x) < 0.07 else 0                      # neck skin; the collar and shoulder tops are jacket
    elif front and 1.08 < c.z < 1.54:
        half = 0.012 + 0.075 * (c.z - 1.08) / 0.45                        # the jacket's V opens wider toward the collar
        if abs(c.x) < half: k = 2 if abs(c.x) < 0.022 and c.z < 1.49 else 1
    poly.material_index = k
bpy.ops.object.shade_smooth()

if PREVIEW:
    os.makedirs(PREVIEW, exist_ok=True)
    sc = bpy.context.scene; sc.render.engine = "BLENDER_WORKBENCH"; sc.display.shading.light = "STUDIO"; sc.display.shading.color_type = "MATERIAL"
    sc.render.image_settings.media_type = "IMAGE"; sc.render.image_settings.file_format = "PNG"; sc.render.resolution_x = 700; sc.render.resolution_y = 900
    cam = bpy.data.objects.new("c", bpy.data.cameras.new("c")); sc.collection.objects.link(cam); sc.camera = cam; cam.data.type = "ORTHO"; cam.data.ortho_scale = 2.3
    A.show_in_front = True; A.data.display_type = "STICK"
    for name, loc, rot in (("front", (0, -6, 0.93), (math.pi / 2, 0, 0)), ("side", (6, 0, 0.93), (math.pi / 2, 0, math.pi / 2)), ("head", (0, -3, 1.65), (math.pi / 2, 0, 0))):
        cam.location = loc; cam.rotation_euler = rot; cam.data.ortho_scale = 0.9 if name == "head" else 2.3
        sc.render.filepath = os.path.join(PREVIEW, name + ".png"); bpy.ops.render.render(write_still=True)

bpy.ops.object.select_all(action="DESELECT"); A.select_set(True); M.select_set(True); bpy.context.view_layer.objects.active = A
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_animations=False, export_skins=True)
print("wrote", OUT, "bones", len(A.pose.bones))
