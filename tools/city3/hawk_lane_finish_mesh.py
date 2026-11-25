"""Fit downloaded Poly Haven scans to Hawk Lane's stepping trail and waterfront."""
from math import radians
from pathlib import Path
import sys

import bpy
from mathutils import Matrix, Vector

out = Path(sys.argv[sys.argv.index("--") + 1])


def clear():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()


def load(asset):
    clear()
    bpy.ops.import_scene.gltf(filepath=str(out / asset / f"{asset}_1k.gltf"))
    return [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]


def export(name, objs):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objs:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(filepath=str(out / f"{name}.glb"), use_selection=True, export_apply=True)


def fit_stone(asset, object_name, output, size):
    stone, = [obj for obj in load(asset) if obj.name == object_name]
    world = stone.matrix_world.copy()
    stone.parent = None
    stone.matrix_world = Matrix.Identity(4)
    stone.data.transform(world)
    points = [v.co.copy() for v in stone.data.vertices]
    lo = Vector(tuple(min(p[i] for p in points) for i in range(3)))
    hi = Vector(tuple(max(p[i] for p in points) for i in range(3)))
    center = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    scale = Matrix.Diagonal(Vector((*[size[i] / (hi[i] - lo[i]) for i in range(3)], 1)))
    stone.data.transform(scale @ Matrix.Translation(-center))
    # The UVs and source PBR maps stay attached to the scan.
    bpy.context.view_layer.objects.active = stone
    mod = stone.modifiers.new("Scan reduction", "DECIMATE")
    mod.ratio = min(1, 4400 / len(stone.data.polygons))
    bpy.ops.object.modifier_apply(modifier=mod.name)
    export(output, [stone])


fit_stone("rock_09", "rock_09_LOD0", "flagstone-long", (0.91, 0.72, 0.087))
fit_stone("namaqualand_stones_01", "namaqualand_stones_01_d", "flagstone-round", (1.02, 0.80, 0.095))
fit_stone("namaqualand_stones_01", "namaqualand_stones_01_a", "flagstone-small", (0.83, 0.69, 0.080))

parts = load("wooden_crate_01")
points = [obj.matrix_world @ v.co for obj in parts for v in obj.data.vertices]
bottom = min(v.z for v in points)
lid = next(obj for obj in parts if "lid" in obj.name)
seat = max((lid.matrix_world @ v.co).z for v in lid.data.vertices) - bottom
base = [obj.matrix_world.copy() for obj in parts]
stack = []
for obj, matrix in zip(parts, base):
    obj.parent = None
    obj.matrix_world = Matrix.Translation(Vector((0, 0, -bottom))) @ matrix
    copy = obj.copy()
    bpy.context.collection.objects.link(copy)
    copy.matrix_world = (
        Matrix.Translation(Vector((0.015, -0.005, seat)))
        @ Matrix.Rotation(radians(-6), 4, "Z") @ Matrix.Scale(0.74, 4) @ obj.matrix_world
    )
    stack.append(copy)

export("waterfront-crates", parts + stack)
