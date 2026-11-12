"""Bake Body Block's full clip catalog (53 clips, incl. EnteringCode) onto a Meshy-generated,
Mixamo-rigged GLB character by world-space rest-delta retarget (same method as
bake_cipher.py, but the target comes in as glTF and its stray non-skinned meshes —
Meshy ships a floating "Icosphere" alongside the character — are dropped first).
Used for Elf and Jim (cast-elf.glb, cast-jim.glb).
Run: tools/city3/blender_lock.sh -b --python tools/city3/bake_meshy.py -- <character.glb> <out.glb>"""
import bpy, sys, math, os
from mathutils import Matrix, Vector, Quaternion

SRC, OUT = sys.argv[sys.argv.index("--") + 1:][:2]
A = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "apps", "console", "public", "assets") + os.sep
TARGET_H = 1.30
bpy.ops.wm.read_factory_settings(use_empty=True)
# Pin 30 fps BEFORE importing the donor: the glTF importer converts clip times
# to frames at the scene fps, and bake_cipher.py's FBX-first import left the
# scene at Mixamo's 30 fps. At any other fps, clips whose length is a
# fractional frame at 30 fps (SittingTalking, 44.0833 s of keys) export a
# half-frame short and fail the catalog duration inventory.
bpy.context.scene.render.fps = 30
bpy.context.scene.render.fps_base = 1.0
bpy.ops.import_scene.gltf(filepath=SRC)
R = next(o for o in bpy.data.objects if o.type == "ARMATURE")
# Meshy rigs carry a stray non-skinned object (an "Icosphere") that is not part of
# the character: exclude every mesh without an Armature modifier from the bake,
# the height measurement and the export.
for o in [o for o in bpy.data.objects if o.type == "MESH" and not any(m.type == "ARMATURE" for m in o.modifiers)]:
    print("dropping stray non-skinned mesh:", o.name)
    bpy.data.objects.remove(o, do_unlink=True)
R_meshes = [o for o in bpy.data.objects if o.type == "MESH"]
before = set(bpy.data.objects); acts_before = set(bpy.data.actions)
bpy.context.scene.render.fps = 30  # the target import may have reset it
bpy.context.scene.render.fps_base = 1.0
bpy.ops.import_scene.gltf(filepath=A + "cast-bodyblock.glb")
B = next(o for o in bpy.data.objects if o.type == "ARMATURE" and o not in before)
B_meshes = [o for o in bpy.data.objects if o.type == "MESH" and o not in before]
bpy.context.view_layer.update()
for o in B_meshes: bpy.data.objects.remove(o, do_unlink=True)

# --- scale the character to 1.3 m total height (armature object scale; children follow)
pts = [m.matrix_world @ Vector(c) for m in R_meshes for c in m.bound_box]
H0 = max(p.z for p in pts) - min(p.z for p in pts); k = TARGET_H / H0
R.scale = R.scale * k; bpy.context.view_layer.update()
pts = [m.matrix_world @ Vector(c) for m in R_meshes for c in m.bound_box]
print("Character height", round(max(p.z for p in pts) - min(p.z for p in pts), 3), "scale factor", round(k, 5))

def norm(n): return n.replace("mixamorig_", "mixamorig:")
rb = {norm(b.name): b for b in R.pose.bones}; bb = {norm(b.name): b for b in B.pose.bones}
shared = [n for n in bb if n in rb]
print("shared bones", len(shared), "of BB", len(bb), "target", len(rb))

def wrot(obj, pb): return (obj.matrix_world @ pb.matrix).to_3x3().normalized()
def rest_wrot(obj, name): return (obj.matrix_world @ obj.data.bones[name].matrix_local).to_3x3().normalized()
Rrest = {n: rest_wrot(R, rb[n].name) for n in rb}; Brest = {n: rest_wrot(B, bb[n].name) for n in bb}

# facing check: toe vs heel direction of the left foot in world space
def fwd(obj, pbs):
    t = obj.matrix_world @ pbs["mixamorig:LeftToeBase"].head
    f = obj.matrix_world @ pbs["mixamorig:LeftFoot"].head
    return (t - f)
for o in (R, B): o.animation_data_create()
B.animation_data.action = None; bpy.context.view_layer.update()
fr, fb = fwd(R, rb), fwd(B, bb); print("fwd target", [round(x, 2) for x in fr], "BB", [round(x, 2) for x in fb])
hipsR = (R.matrix_world @ rb["mixamorig:Hips"].head).z; hipsB = (B.matrix_world @ bb["mixamorig:Hips"].head).z
S = hipsR / hipsB; print("hips world height target", round(hipsR, 3), "BB", round(hipsB, 3), "scale", round(S, 3))
order = []
def walk(pb):
    order.append(pb)
    for c in pb.children: walk(c)
for pb in R.pose.bones:
    if pb.parent is None: walk(pb)
for pb in R.pose.bones: pb.rotation_mode = "QUATERNION"

bbacts = sorted([a for a in bpy.data.actions if a not in acts_before], key=lambda a: a.name)
print("actions in file", len(bbacts))
out_actions = []
scene = bpy.context.scene
Rinv_w = R.matrix_world.to_3x3().inverted()
hips_rest_arm = R.data.bones[rb["mixamorig:Hips"].name].matrix_local
for a in bbacts:
    B.animation_data.action = a
    f0, f1 = int(round(a.frame_range[0])), int(round(a.frame_range[1]))
    na = bpy.data.actions.new(a.name + "_R"); R.animation_data.action = na
    for f in range(f0, f1 + 1):
        scene.frame_set(f); bpy.context.view_layer.update()
        posed = {}   # name -> world rotation (3x3) of target bone after retarget
        for pb in order:
            n = norm(pb.name)
            if n in bb:
                d = wrot(B, bb[n]) @ Brest[n].inverted()      # world-space rotation delta of the BB bone
                Rw = d @ Rrest[n]
            else:
                Rw = posed[norm(pb.parent.name)] @ (Rrest[norm(pb.parent.name)].inverted() @ Rrest[n]) if pb.parent else Rrest[n]
            if pb.parent:
                p = norm(pb.parent.name); Lrest = Rrest[p].inverted() @ Rrest[n]
                basis = (posed[p] @ Lrest).inverted() @ Rw
            else:
                basis = Rrest[n].inverted() @ Rw if False else Rw
            posed[n] = Rw
            q = basis.to_quaternion() if pb.parent else (Rrest[n].inverted() @ Rw).to_quaternion()
            # basis rotation in bone-local space: for a parentless bone use rest-relative rotation
            pb.rotation_quaternion = q
            pb.keyframe_insert("rotation_quaternion", frame=f)
        hp = rb["mixamorig:Hips"]
        wbb = B.matrix_world @ bb["mixamorig:Hips"].head
        dw = (wbb - Vector((B.matrix_world @ B.data.bones[bb["mixamorig:Hips"].name].head_local))) * S
        d_arm = Rinv_w @ dw
        hp.location = R.data.bones[hp.name].matrix_local.to_3x3().inverted() @ d_arm
        hp.keyframe_insert("location", frame=f)
    out_actions.append((a.name, na)); na.use_fake_user = True
for a in list(bpy.data.actions):
    if a not in [x[1] for x in out_actions]: bpy.data.actions.remove(a)
for nm, na in out_actions: na.name = nm
out_actions = [x[1] for x in out_actions]
for im in bpy.data.images:
    if im.size[0] > 1024: im.scale(1024, 1024)
R.animation_data.action = out_actions[0]
bpy.ops.object.select_all(action="DESELECT")
bpy.data.objects.remove(B, do_unlink=True)
for o in [R] + R_meshes: o.select_set(True)
bpy.context.view_layer.objects.active = R
print("clips", len(out_actions), sorted(a.name for a in out_actions)[:5])
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_animations=True,
                          export_animation_mode="ACTIONS", export_force_sampling=True, export_optimize_animation_size=True, export_apply=False, export_skins=True)
print("exported", OUT)
