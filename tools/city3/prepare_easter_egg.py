"""Prepare the uploaded CC BY SciFi EasterEgg. Run via blender_lock.sh, one job at a time."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import zipfile

import bpy
import bmesh
from mathutils import Vector

HERE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, default=HERE / 'assets/scifi_easteregg/source.zip')
parser.add_argument('--output', type=Path, default=HERE.parents[1] / 'apps/console/public/assets/collectibles/scifi-easter-egg.glb')
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
bpy.ops.wm.read_factory_settings(use_empty=True)
with tempfile.TemporaryDirectory(prefix='aiverse-egg-') as directory:
    with zipfile.ZipFile(args.source) as archive:
        # Only the two known model files are inputs; never execute archive contents.
        for name in ('scene.gltf', 'scene.bin'):
            Path(directory, name).write_bytes(archive.read(name))
    bpy.ops.import_scene.gltf(filepath=str(Path(directory, 'scene.gltf')))
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    for obj in meshes:
        world = obj.matrix_world.copy()
        obj.parent = None
        obj.matrix_world = world
    for obj in list(bpy.data.objects):
        if obj.type != 'MESH': bpy.data.objects.remove(obj, do_unlink=True)
    bpy.ops.object.select_all(action='SELECT')
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    obj = bpy.context.object
    obj.name = 'SciFi EasterEgg'
    points = [obj.matrix_world @ Vector(p) for p in obj.bound_box]
    lo = Vector([min(p[i] for p in points) for i in range(3)])
    hi = Vector([max(p[i] for p in points) for i in range(3)])
    origin = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    factor = .5 / (hi.z - lo.z)
    for vertex in obj.data.vertices: vertex.co = (obj.matrix_world @ vertex.co - origin) * factor
    obj.matrix_world.identity()
    source_triangles = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    # Sketchfab split this continuous surface at vertex-color/chunk boundaries.
    # Weld coincident vertices before simplification so those boundaries cannot tear.
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=.000001)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()
    modifier = obj.modifiers.new('Browser triangle budget', 'DECIMATE')
    modifier.ratio = min(1., 10000 / source_triangles)
    modifier.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    # Simplification can move the lowest vertices slightly: re-seat the final base.
    final_lo = Vector([min(v.co[i] for v in obj.data.vertices) for i in range(3)])
    final_hi = Vector([max(v.co[i] for v in obj.data.vertices) for i in range(3)])
    final_origin = Vector(((final_lo.x + final_hi.x) / 2, (final_lo.y + final_hi.y) / 2, final_lo.z))
    final_scale = .5 / (final_hi.z - final_lo.z)
    for vertex in obj.data.vertices: vertex.co = (vertex.co - final_origin) * final_scale
    obj.data.update()
    bpy.context.view_layer.update()
    for face in obj.data.polygons: face.use_smooth = True
    obj['author'] = 'Cécile Amstad'
    obj['license'] = 'CC-BY-4.0'
    obj['source'] = 'https://sketchfab.com/3d-models/scifi-easteregg-f19c4de512794d64b00b3f5ceea62ca2'
    args.output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=str(args.output), export_format='GLB', use_selection=True, export_animations=False, export_extras=True)
    report = {
        'source_triangles': source_triangles,
        'triangles': sum(len(p.vertices) - 2 for p in obj.data.polygons),
        'height_m': .5,
        'dimensions_blender_m': list(obj.dimensions),
        'color_attributes': list(obj.data.color_attributes.keys()),
        'bytes': args.output.stat().st_size,
        'sha256': hashlib.sha256(args.output.read_bytes()).hexdigest(),
        'modifications': 'Joined source chunks, welded coincident seams, recalculated normals, normalized to 0.5 m tall with base at zero, simplified mesh; vertex colors retained.'
    }
    (HERE / 'assets/scifi_easteregg/prepared.json').write_text(json.dumps(report, indent=2) + '\n')
    print('EGG_PREPARED', json.dumps(report), flush=True)
# This machine can hang in PulseAudio shutdown after a successful export.
sys.stdout.flush()
sys.stderr.flush()
os._exit(0)
