"""Bake the Hawk Lane overlook's fitted railing and timber paving insert."""
from pathlib import Path
import sys

import bpy

out = Path(sys.argv[sys.argv.index("--") + 1])
textures = Path(__file__).parent / "assets" / "tea-floors"
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()


def material(name, color, roughness, metal=0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    pbr = mat.node_tree.nodes.get("Principled BSDF")
    pbr.inputs["Base Color"].default_value = mat.diffuse_color
    pbr.inputs["Roughness"].default_value = roughness
    pbr.inputs["Metallic"].default_value = metal
    return mat


oak = material("Overlook | oiled oak", (0.46, 0.28, 0.13), 0.65)
nodes = oak.node_tree.nodes
links = oak.node_tree.links
pbr = nodes.get("Principled BSDF")
for suffix in ("c", "n"):
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = bpy.data.images.load(str(textures / f"oak_wood_planks_{suffix}.jpg"))
    texture.image.pack()
    if suffix == "c":
        links.new(texture.outputs["Color"], pbr.inputs["Base Color"])
    else:
        texture.image.colorspace_settings.name = "Non-Color"
        normal = nodes.new("ShaderNodeNormalMap")
        normal.inputs["Strength"].default_value = 0.65
        links.new(texture.outputs["Color"], normal.inputs["Color"])
        links.new(normal.outputs["Normal"], pbr.inputs["Normal"])

steel = material("Overlook | satin charcoal steel", (0.047, 0.061, 0.064), 0.47, 0.55)
bolts = material("Overlook | stainless fasteners", (0.24, 0.25, 0.24), 0.45, 0.74)
edge = material("Overlook | board end seal", (0.117, 0.071, 0.039), 0.72)


def box(name, center, size, mat, bevel=0, offset=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=center)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    if mat is oak:
        uv = obj.data.uv_layers.active.data
        for face in obj.data.polygons:
            for i in face.loop_indices:
                x, y, z = obj.data.vertices[obj.data.loops[i].vertex_index].co
                t = y if abs(face.normal.z) > 0.5 else z
                uv[i].uv = (x / 1.55 + offset, t / 0.38 + offset)
    if bevel:
        mod = obj.modifiers.new("Edge radius", "BEVEL")
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


for x in (-5.6, -2.8, 0, 2.8, 5.6):
    box("Railing base plate", (x, 0, 0.009), (0.22, 0.18, 0.018), steel, 0.005)
    box("Railing post", (x, 0, 0.554), (0.083, 0.065, 1.09), steel, 0.009)
    for dx in (-0.073, 0.073):
        for y in (-0.051, 0.051):
            bpy.ops.mesh.primitive_cylinder_add(vertices=6, radius=0.011, depth=0.012, location=(x + dx, y, 0.023))
            bpy.context.object.name = "Anchor bolt"
            bpy.context.object.data.materials.append(bolts)
for i in range(4):
    x = -5.6 + 2.8 * i
    for h in (0.19, 1.043):
        box("Panel rail", (x + 1.4, 0, h), (2.80, 0.042, 0.037), steel, 0.004)
    for j in range(1, 20):
        box("Panel picket", (x + j * 0.14, 0, 0.61), (0.023, 0.025, 0.87), steel, 0.003)
box("Oak handrail", (0, 0, 1.117), (11.44, 0.11, 0.056), oak, 0.011)
export("overlook-railing")

box("Decking edge", (0, 0, 0.004), (6.22, 1.80, 0.008), edge, 0.003)
for i in range(12):
    box("Oak decking board", (0, (i - 5.5) * 0.1495, 0.0125),
        (6.22, 0.144, 0.025), oak, 0.003, offset=i * 0.137)
export("overlook-decking")
