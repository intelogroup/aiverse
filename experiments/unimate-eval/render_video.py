import bpy, math, os
from mathutils import Vector

GLB = os.path.expanduser("~/workspace/.build-tmp/unimate-test/repo/outputs/samples/go2/animated/unitree_go2-an_object_trots_forward-rep_0-0.glb")
OUT = os.path.expanduser("~/workspace/.build-tmp/unimate-test/frames")
os.makedirs(OUT, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

scene = bpy.context.scene
arm = next(o for o in scene.objects if o.type == 'ARMATURE')
root_bone = arm.pose.bones[0].name
print("ROOT_BONE:", root_bone, "| frames:", scene.frame_start, scene.frame_end)

def root_pos(f):
    scene.frame_set(f)
    return arm.matrix_world @ arm.pose.bones[root_bone].head

f0, f1 = scene.frame_start, scene.frame_end
p0, p1 = root_pos(f0), root_pos(f1)
mid = (p0 + p1) / 2
travel = p1 - p0
print("TRAVEL:", tuple(round(v, 2) for v in travel), "len", round(travel.length, 2))

# Ground
bpy.ops.mesh.primitive_plane_add(size=60, location=(mid.x, mid.y, 0))
ground = bpy.context.active_object
gmat = bpy.data.materials.new("ground")
gmat.use_nodes = True
gmat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.32, 0.34, 0.38, 1)
ground.data.materials.append(gmat)

# Lighting: sun + world
sun_data = bpy.data.lights.new("sun", 'SUN')
sun_data.energy = 3.0
sun = bpy.data.objects.new("sun", sun_data)
scene.collection.objects.link(sun)
sun.rotation_euler = (math.radians(50), 0, math.radians(30))
world = bpy.data.worlds.new("W") if not bpy.data.worlds else bpy.data.worlds[0]
scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.85, 0.88, 0.92, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0

# Camera: 3/4 view of the path midpoint, pulled back to cover travel + body
side = Vector((-travel.y, travel.x, 0))
if side.length < 0.01:
    side = Vector((1, 0, 0))
side.normalize()
dist = max(4.0, travel.length * 0.95)
cam_pos = mid + side * dist + Vector((0, 0, dist * 0.55)) + Vector((travel.x, travel.y, 0)) * 0.1
cam_data = bpy.data.cameras.new("cam")
cam = bpy.data.objects.new("cam", cam_data)
scene.collection.objects.link(cam)
cam.location = cam_pos
direction = mid - cam_pos
cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
scene.camera = cam

scene.render.engine = 'CYCLES'
scene.cycles.samples = 16
scene.cycles.device = 'CPU'
scene.cycles.use_denoising = False
scene.render.resolution_x = 640
scene.render.resolution_y = 360
scene.render.fps = 24
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = os.path.join(OUT, "f_")
if os.environ.get("START_FRAME"):
    scene.frame_start = int(os.environ["START_FRAME"])
bpy.ops.render.render(animation=True)
print("RENDER_DONE", f0, f1)
