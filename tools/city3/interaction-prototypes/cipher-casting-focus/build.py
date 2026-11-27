"""Author and audit Cipher's original quartz casting focus in Blender.

Run from the repo root with:
  tools/city3/blender_lock.sh --factory-startup -b --python-exit-code 1 \
    --python tools/city3/interaction-prototypes/cipher-casting-focus/build.py -- /tmp/cipher-focus

The output directory receives the standalone prop GLB, a posed Blender scene,
and recorded wrist transforms. The production cast is read-only.
"""
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

output = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
output.mkdir(parents=True, exist_ok=True)
cast = Path(__file__).resolve().parents[4] / "apps/console/public/assets/cast-cipher.glb"
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(cast))
scene = bpy.context.scene
rig = next(obj for obj in scene.objects if obj.type == "ARMATURE")
for track in list(rig.animation_data.nla_tracks):
    rig.animation_data.nla_tracks.remove(track)
action = bpy.data.actions["CastSpell"]
rig.animation_data.action = action
body = bpy.data.objects["Soldier_body"]

def hand():
    return rig.matrix_world @ rig.pose.bones["mixamorig:RightHand"].matrix

def cast_tree(actor, inverse):
    obj = actor.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = obj.to_mesh()
    mesh.calc_loop_triangles()
    transform = inverse @ obj.matrix_world
    tree = BVHTree.FromPolygons(
        [transform @ vertex.co for vertex in mesh.vertices],
        [tuple(face.vertices) for face in mesh.loop_triangles],
        all_triangles=True,
    )
    obj.to_mesh_clear()
    return tree

prop = []
bone = rig.pose.bones['mixamorig:RightHand']
shapes = {
    'gunmetal': (.11, .16, .2, 1),
    'leather': (.11, .066, .034, 1),
    'bronze': (.53, .28, .12, 1),
    'quartz': (.08, .87, .69, 1),
}
materials = {}
for name,color in shapes.items():
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = color
    shader.inputs['Metallic'].default_value = .75 if name in ('bronze','gunmetal') else .12
    if name == 'quartz':
        shader.inputs['Emission Color'].default_value = color
        shader.inputs['Emission Strength'].default_value = .55
    materials[name] = mat

def record(name, material):
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(materials[material])
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    prop.append(obj)
    return obj

def barrel(name, material, start, end, radius_start, radius_end, sides=24):
    axis = Vector(end)-Vector(start)
    bpy.ops.mesh.primitive_cone_add(vertices=sides, radius1=radius_start, radius2=radius_end, depth=axis.length,
        location=(Vector(end)+Vector(start))/2, rotation=axis.to_track_quat('Z','Y').to_euler())
    return record(name,material)

scene.frame_set(0)
skin = cast_tree(body,hand().inverted())
# Follow the back of the glove without driving the hand pose.
grid_size = 7
footprint = []
for row in range(grid_size):
    y = 3.35 + row * .85
    half_width = 2.45 - .45 * abs(row - 3) / 3
    footprint.extend((half_width * (column / 3 - 1), y) for column in range(grid_size))
envelope = [0.] * len(footprint)
for frame in range(56):
    scene.frame_set(frame)
    dorsal_skin = cast_tree(body, hand().inverted())
    for i,(x,y) in enumerate(footprint):
        hit, *_ = dorsal_skin.ray_cast(Vector((x,y,-30)),Vector((0,0,1)))
        envelope[i] = min(envelope[i], hit.z)
scene.frame_set(0)
bottom = [(x,y,z-.15) for (x,y),z in zip(footprint,envelope)]
vertices = bottom + [(x,y,z-1.05) for x,y,z in bottom]
count = len(bottom)
faces = []
for row in range(grid_size-1):
    for column in range(grid_size-1):
        first = row*grid_size+column
        face = (first,first+1,first+1+grid_size,first+grid_size)
        faces.append(face)
        faces.append(tuple(i+count for i in reversed(face)))
edge = [*range(grid_size),
        *(row*grid_size+grid_size-1 for row in range(1,grid_size)),
        *(count-1-column for column in range(1,grid_size)),
        *(row*grid_size for row in range(grid_size-2,0,-1))]
faces.extend((a,b,b+count,a+count) for a,b in zip(edge,edge[1:]+edge[:1]))
pad_mesh = bpy.data.meshes.new('Palm saddle geometry')
pad_mesh.from_pydata(vertices,[],faces)
pad = bpy.data.objects.new('Contoured leather glove saddle',pad_mesh)
scene.collection.objects.link(pad)
pad.data.materials.append(materials['leather'])
prop.append(pad)
barrel('Octagonal focus housing','gunmetal',(0,5.9,-3.55),(0,5.9,-4.95),2.15,2.32,sides=8)
barrel('Machined bronze rim','bronze',(0,5.9,-4.94),(0,5.9,-5.5),2.32,1.96,sides=8)
barrel('Quartz core','quartz',(0,5.9,-5.48),(0,5.9,-6.85),1.78,.81,sides=8)
barrel('Quartz crown','quartz',(0,5.9,-6.85),(0,5.9,-7.12),.81,.49,sides=8)
for x in (-1.7,1.7):
    for y in (3.85,7.9):
        hit, *_ = skin.ray_cast(Vector((x,y,-30)),Vector((0,0,1)))
        barrel('Bronze rivet','bronze',(x,y,hit.z-.8),(x,y,hit.z-1.53),.42,.29,sides=10)

scale = hand().to_scale().x
for obj in prop:
    obj.parent = rig
    obj.parent_type = 'BONE'
    obj.parent_bone = bone.name
    obj.matrix_parent_inverse = Matrix.Translation((0,-bone.length,0))

for obj in prop:
    obj.data.calc_loop_triangles()
def local_tree(obj):
    return BVHTree.FromPolygons([v.co for v in obj.data.vertices],
        [tuple(t.vertices) for t in obj.data.loop_triangles],all_triangles=True)
prop_trees = {o.name:local_tree(o) for o in prop}
actors = (body, bpy.data.objects["Soldier_head"])
steps = math.ceil(action.frame_range[1] * 20)
min_gap = math.inf
max_gap = 0.
max_socket_error = 0.
for i in range(steps+1):
    frame = action.frame_range[1]*i/steps
    scene.frame_set(int(frame), subframe=frame % 1)
    wrist = hand()
    inverse = wrist.inverted()
    for obj in prop:
        error = (obj.matrix_world.translation - wrist.translation).length
        max_socket_error = max(max_socket_error, error)
    for actor in actors:
        tree = cast_tree(actor, inverse)
        for name, part in prop_trees.items():
            assert not tree.overlap(part), f"{name} intersects {actor.name} at {frame:.3f}"
        if actor == body:
            for vertex in list(pad.data.vertices)[:count]:
                gap = tree.find_nearest(vertex.co)[3] * scale
                min_gap = min(min_gap, gap)
                max_gap = max(max_gap, gap)
assert max_gap < .003, f"Glove saddle gap {max_gap:.4f} m exceeds 3 mm"
assert max_socket_error < .0001, f"Wrist mount error {max_socket_error:.4f} m"
print(f"PASS {steps+1} samples, saddle gap {min_gap*1000:.3f}–{max_gap*1000:.3f} mm")

# Dump independent Blender reference transforms for the Three.js calibration test.
coordinates = Matrix.Rotation(-math.pi/2, 4, "X")
reference = []
for frame in (0, 8, 16, 24, 32, 40, 48, 55):
    scene.frame_set(frame)
    mount = coordinates @ hand() @ Matrix.Scale(1/scale, 4) @ coordinates.inverted()
    reference.append({
        "time": frame/scene.render.fps,
        "worldFromProp": [mount[row][col] for col in range(4) for row in range(4)],
    })
(output / "socket-samples.json").write_text(json.dumps(reference, indent=2) + "\n")

scene.frame_set(24)
scene.frame_start = 0
scene.frame_end = 55
bpy.ops.wm.save_as_mainfile(filepath=str(output / "cipher-casting-focus.blend"))

# Export only the original prop, in metres, with the wrist as local origin.
bpy.ops.object.select_all(action="DESELECT")
for obj in prop:
    obj.parent = None
    obj.matrix_world = Matrix.Identity(4)
    for vertex in obj.data.vertices:
        vertex.co *= scale
    obj.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(output / "cipher-casting-focus.glb"), use_selection=True)
