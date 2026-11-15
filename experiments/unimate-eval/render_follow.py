import bpy, math, os
from mathutils import Vector

GLB = os.path.expanduser("~/workspace/.build-tmp/unimate-test/repo/outputs/samples/go2/animated/unitree_go2-an_object_trots_forward-rep_0-0.glb")
OUT = os.path.expanduser("~/workspace/.build-tmp/unimate-test/frames_follow")
os.makedirs(OUT, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)
scene = bpy.context.scene
arm = next(o for o in scene.objects if o.type == 'ARMATURE')
root_bone = arm.pose.bones[0].name

def root_pos(f):
    scene.frame_set(f)
    bpy.context.view_layer.update()
    return arm.matrix_world @ arm.pose.bones[root_bone].head

F0, F1 = 1, 60
p_start, p_end = root_pos(F0), root_pos(F1)
travel = p_end - p_start
travel.z = 0
print("TRAVEL:", tuple(round(v, 2) for v in travel))

# Ground follows the path extent
mid = (p_start + p_end) / 2
bpy.ops.mesh.primitive_plane_add(size=80, location=(mid.x, mid.y, 0))
ground = bpy.context.active_object
gmat = bpy.data.materials.new("ground")
gmat.use_nodes = True
gmat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.32, 0.34, 0.38, 1)
ground.data.materials.append(gmat)

sun_data = bpy.data.lights.new("sun", 'SUN')
sun_data.energy = 3.0
sun = bpy.data.objects.new("sun", sun_data)
scene.collection.objects.link(sun)
sun.rotation_euler = (math.radians(50), 0, math.radians(30))

world = bpy.data.worlds[0] if bpy.data.worlds else bpy.data.worlds.new("W")
scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.85, 0.88, 0.92, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0

cam_data = bpy.data.cameras.new("cam")
cam = bpy.data.objects.new("cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

# Follow offset: side + back + up, in world axes relative to travel direction
fwd = travel.normalized() if travel.length > 0.01 else Vector((0, -1, 0))
side = Vector((-fwd.y, fwd.x, 0))
OFFSET = side * 2.4 - fwd * 1.6 + Vector((0, 0, 1.15))

scene.render.engine = 'CYCLES'
scene.cycles.samples = 16
scene.cycles.device = 'CPU'
scene.cycles.use_denoising = False
scene.render.resolution_x = 640
scene.render.resolution_y = 360
scene.render.image_settings.file_format = 'PNG'

for f in range(F0, F1 + 1):
    p = root_pos(f)
    cam.location = p + OFFSET
    cam.rotation_euler = (p - cam.location).to_track_quat('-Z', 'Y').to_euler()
    scene.render.filepath = os.path.join(OUT, "f_%04d.png" % f)
    bpy.ops.render.render(write_still=True)
print("FOLLOW_RENDER_DONE")
