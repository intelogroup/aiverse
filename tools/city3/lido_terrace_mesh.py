"""Build the Lido terrace modules at meter scale, with their bases at Z=0."""

import math
from pathlib import Path
import sys

import bpy

out = Path(sys.argv[sys.argv.index("--") + 1])
out.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()


def material(name, rgb, roughness, metallic=0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*rgb, 1)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = mat.diffuse_color
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    return mat


aluminum = material("Lido | powder-coated petrol", (0.022, 0.115, 0.126), 0.44, 0.25)
timber = material("Lido | honey thermowood", (0.40, 0.21, 0.095), 0.56)
endgrain = material("Lido | warm thermowood", (0.34, 0.172, 0.071), 0.59)
concrete = material("Lido | warm mineral composite", (0.47, 0.43, 0.35), 0.83)
soil = material("Lido | soil", (0.086, 0.054, 0.029), 0.96)
leaves = [
    material("Lido | blue fescue", (0.16, 0.235, 0.125), 0.78),
    material("Lido | blue fescue tips", (0.29, 0.36, 0.18), 0.8),
]


def box(name, center, size, mat, bevel=0.008, pitch=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=center)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = size
    obj.rotation_euler.x = pitch
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    if bevel:
        round_edges = obj.modifiers.new("Rounded edges", "BEVEL")
        round_edges.width = bevel
        round_edges.segments = 2


def export(name):
    objects = list(bpy.context.scene.objects)
    for obj in objects:
        bpy.context.view_layer.objects.active = obj
        for modifier in list(obj.modifiers):
            bpy.ops.object.modifier_apply(modifier=modifier.name)
    bpy.ops.object.select_all(action="SELECT")
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    bpy.ops.export_scene.gltf(filepath=str(out / f"{name}.glb"), export_apply=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()


# Roof starts 2.60 m above its post bases. The placement generator supplies that lift.
for x in (-3.65, 0, 3.65):
    box("Roof purlin", (x, 0, 0.068), (0.13, 4.20, 0.136), aluminum)
for y in (-1.8, 1.8):
    box("Cross beam", (0, y, 0.06), (7.62, 0.15, 0.12), aluminum)
for i in range(23):
    y = (i - 11) * 0.177
    box("Shade batten", (0, y, 0.171), (7.78, 0.142, 0.07), timber if i % 3 else endgrain)
export("canopy")

box("Post", (0, 0, 1.30), (0.144, 0.144, 2.60), aluminum)
box("Base plate", (0, 0, 0.013), (0.24, 0.24, 0.026), aluminum)
export("post")

# Bench faces toward decreasing world Z. The two braces reach the ground, seat top is 0.46 m.
for x in (-0.97, 0.97):
    for y in (-0.21, 0.18):
        box("Bench upright", (x, y, 0.209), (0.069, 0.073, 0.418), aluminum)
    box("Bench seat bracket", (x, 0, 0.411), (0.087, 0.565, 0.043), aluminum)
    box("Backrest bracket", (x, -0.255, 0.627), (0.071, 0.062, 0.437), aluminum, pitch=0.11)
for i in range(5):
    box("Seat slat", (0, (i - 2) * 0.112, 0.44), (2.24, 0.101, 0.04), timber)
for i in range(3):
    box("Backrest slat", (0, -0.208 - i * 0.012, 0.604 + i * 0.105), (2.24, 0.038, 0.087), endgrain, pitch=0.11)
export("bench")

# A recessed soil bed surrounded by a mineral rim.
box("Planter body", (0, 0, 0.16), (1.19, 0.59, 0.32), concrete, 0.027)
for x in (-0.567, 0.567):
    box("Planter end", (x, 0, 0.34), (0.056, 0.59, 0.11), concrete)
for y in (-0.268, 0.268):
    box("Planter side", (0, y, 0.34), (1.12, 0.055, 0.11), concrete)
box("Soil", (0, 0, 0.321), (1.075, 0.472, 0.038), soil)
verts, faces = [], []
for clump_x in (-0.34, 0, 0.34):
    for i in range(24):
        angle = i * 2.399963
        dx, dy = math.cos(angle), math.sin(angle)
        reach = 0.052 + i % 7 * 0.019
        height = 0.185 + i % 5 * 0.039
        base_x, base_y = clump_x + dx * 0.045, dy * 0.042
        p = len(verts)
        verts.extend([
            (base_x - dy * 0.012, base_y + dx * 0.012, 0.34),
            (base_x + dy * 0.012, base_y - dx * 0.012, 0.34),
            (base_x + dx * reach * 0.53 + dy * 0.011, base_y + dy * reach * 0.53 - dx * 0.011, 0.34 + height * 0.68),
            (base_x + dx * reach * 0.53 - dy * 0.011, base_y + dy * reach * 0.53 + dx * 0.011, 0.34 + height * 0.68),
            (base_x + dx * reach, base_y + dy * reach, 0.34 + height),
        ])
        faces.extend([(p, p + 1, p + 2, p + 3), (p + 3, p + 2, p + 4)])
mesh = bpy.data.meshes.new("Fescue")
mesh.from_pydata(verts, [], faces)
mesh.update()
planting = bpy.data.objects.new("Fescue", mesh)
bpy.context.collection.objects.link(planting)
for mat in leaves:
    mesh.materials.append(mat)
for face in mesh.polygons:
    face.material_index = face.index % 2
export("planter")
