"""Bake the Hawk Lane paths, bench, planting and lot-specific porch collider."""
from array import array
from math import cos, sin, tau
from pathlib import Path
from random import Random
import sys

import bpy

out = Path(sys.argv[sys.argv.index("--") + 1])
out.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()
rng = Random(350)
ground = 0.245


def material(name, color):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = mat.diffuse_color
    shader.inputs["Roughness"].default_value = 0.88
    return mat


gravel = material("Hawk Lane | pale gravel", (0.55, 0.49, 0.39))
image = bpy.data.images.new("Hawk Lane gravel grains", width=256, height=256)
pixels = array("f")
for _ in range(256 * 256):
    tone = rng.uniform(0.42, 0.88)
    pixels.extend((tone, tone * 0.93, tone * 0.81, 1))
image.pixels.foreach_set(pixels)
image.pack()
tex = gravel.node_tree.nodes.new("ShaderNodeTexImage")
tex.image = image
gravel.node_tree.links.new(tex.outputs["Color"], gravel.node_tree.nodes.get("Principled BSDF").inputs["Base Color"])
stone = material("Hawk Lane | landing stone", (0.33, 0.31, 0.27))
oak = material("Hawk Lane | oiled oak", (0.42, 0.218, 0.085))
metal = material("Hawk Lane | satin iron", (0.045, 0.053, 0.052))
earth = material("Hawk Lane | garden soil", (0.118, 0.075, 0.044))
foliage = [
    material("Hawk Lane | sedge", (0.17, 0.26, 0.086)),
    material("Hawk Lane | silver sedge", (0.29, 0.36, 0.16)),
    material("Hawk Lane | sage", (0.21, 0.29, 0.18)),
]


def mesh(name, vertices, faces, mat, uv=False):
    data = bpy.data.meshes.new(name)
    data.from_pydata(vertices, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    data.materials.append(mat)
    if uv:
        layer = data.uv_layers.new()
        for loop in data.loops:
            x, y, _ = vertices[loop.vertex_index]
            layer.data[loop.index].uv = (x / 0.46, y / 0.46)
    return obj


def surface(name, corners, mat=gravel):
    # Clockwise in glTF x/z becomes counterclockwise in Blender x/y.
    return mesh(name, [(x, -z, y) for x, z, y in corners], [(0, 1, 2, 3)], mat, uv=True)


def strip(name, sections):
    for i, ((z0, x0, x1), (z1, x2, x3)) in enumerate(zip(sections, sections[1:])):
        surface(f"{name} {i+1}", [(x0, z0, ground), (x1, z0, ground), (x3, z1, ground), (x2, z1, ground)])


def cube(name, center, size, mat, bevel=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=center)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new("Soft edges", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        bpy.ops.object.modifier_apply(modifier=mod.name)


def export(name):
    bpy.ops.object.select_all(action="SELECT")
    bpy.context.view_layer.objects.active = bpy.context.selected_objects[0]
    bpy.ops.object.join()
    bpy.context.object.name = name
    bpy.ops.export_scene.gltf(filepath=str(out / f"{name}.glb"), export_apply=True)
    bpy.ops.object.delete()


strip("Hedge walk", [(-138.22, 24.86, 45.40), (-139.43, 24.86, 45.40)])
strip("Tree walk", [
    (-139.43, 31.60, 33.90), (-140.22, 31.82, 33.76), (-144.6, 31.82, 33.56),
    (-149.45, 31.68, 33.50), (-150.15, 30.55, 34.60), (-151.95, 30.28, 34.87),
    (-152.52, 30.85, 34.30),
])
strip("Porch side walk", [(-140.46, 42.65, 47.00), (-141.49, 42.65, 47.00)])
strip("Landing apron", [(-140.46, 40.83, 42.65), (-140.68, 40.83, 42.65)])
ramp = [(40.83, -140.68, ground), (42.65, -140.68, ground),
        (42.65, -141.43, 0.52), (40.83, -141.43, 0.52)]
surface("Stone ramp", ramp, stone)
# Close the visible near and side edges down to the existing lawn.
for i in (0, 1, 3):
    x0, z0, y0 = ramp[i]
    x1, z1, y1 = ramp[(i + 1) % 4]
    vertices = [(x0, -z0, ground - 0.02), (x1, -z1, ground - 0.02), (x1, -z1, y1), (x0, -z0, y0)]
    mesh("Stone edge", vertices, [(0, 1, 2, 3)], stone)
export("walks")

for x in (-0.79, 0.79):
    for y in (-0.18, 0.17):
        cube("Bench leg", (x, y, 0.214), (0.075, 0.075, 0.428), metal, 0.008)
    cube("Bench rail", (x, 0, 0.414), (0.095, 0.54, 0.046), metal, 0.008)
    cube("Back upright", (x, 0.235, 0.62), (0.061, 0.068, 0.47), metal, 0.007)
for i in range(5):
    cube("Seat slat", (0, (i - 2) * 0.106, 0.44), (2.02, 0.096, 0.04), oak, 0.009)
for y in (0.61, 0.72, 0.83):
    cube("Back slat", (0, 0.207, y), (2.02, 0.039, 0.087), oak, 0.009)
export("bench")

rim = [(cos(i * tau / 32), sin(i * tau / 32)) for i in range(32)]
rim_vertices = [(0.675 * x, 0.34 * y, 0) for x, y in rim]
rim_vertices += [(0.625 * x, 0.30 * y, 0.024) for x, y in rim]
rim_faces = [(i, (i + 1) % 32, (i + 1) % 32 + 32, i + 32) for i in range(32)]
mesh("Mulch bed", rim_vertices, [*rim_faces, tuple(range(32, 64))], earth)
verts, faces = [], []
for x, y in [(-0.37, -0.13), (-0.22, 0.13), (0.03, -0.06), (0.32, 0.12), (0.40, -0.13)]:
    for i in range(28):
        a = i * 2.399963
        dx, dy = cos(a), sin(a)
        length = rng.uniform(0.09, 0.25)
        h = rng.uniform(0.17, 0.42)
        p = len(verts)
        root = 0.023
        verts.extend([(x - dy * 0.02, y + dx * 0.02, root), (x + dy * 0.02, y - dx * 0.02, root),
                      (x + dx * length * 0.52 + dy * 0.016, y + dy * length * 0.52 - dx * 0.016, root + h * 0.8),
                      (x + dx * length * 0.52 - dy * 0.016, y + dy * length * 0.52 + dx * 0.016, root + h * 0.8),
                      (x + dx * length, y + dy * length, root + h)])
        faces.extend([(p, p+1, p+2, p+3), (p+3, p+2, p+4)])
plants = mesh("Sedge clumps", verts, faces, foliage[0])
for mat in foliage[1:]:
    plants.data.materials.append(mat)
for face in plants.data.polygons:
    face.material_index = face.index // 2 % len(foliage)
export("planting")

# Only the neighboring lot uses these collision shapes. The rest of its original
# closed hull stays in place behind the porch and beside its two ends.
def collider(name, x0, x1, z0, z1, y0, y1):
    cube(name, ((x0 + x1) / 2 - 46.2, -148.2 - (z0 + z1) / 2, (y0 + y1) / 2),
         (x1 - x0, z1 - z0, y1 - y0), stone)


collider("Rear hull", 36.452, 55.948, -155.935, -143.94, -0.05, 8.889)
collider("West hull", 36.452, 38.54, -143.94, -141.93, -0.05, 8.889)
collider("East hull", 44.95, 55.948, -143.94, -140.465, -0.05, 8.889)
collider("Porch deck", 38.54, 44.95, -143.94, -141.93, -0.05, 0.894)
collider("Upper tread", 40.837, 42.645, -141.93, -141.69, -0.05, 0.747)
collider("Lower tread", 40.837, 42.645, -141.69, -141.43, -0.05, 0.603)
# A continuous slope keeps the navmesh connected across the two shallow treads.
# Sampled at each stair nosing. The ground end overlaps the street walk surface.
for corners in [ramp, [(40.837, -141.43, 0.603), (42.645, -141.43, 0.603),
                       (42.645, -141.93, 0.894), (40.837, -141.93, 0.894)]]:
    mesh("Stair walking surface", [(x - 46.2, -z - 148.2, y) for x, z, y in corners], [(0, 1, 2, 3)], stone)
export("porch-collision")
