"""Convert the user's static OBJ to an optimized, metre-scale GLB; run through blender52 only."""
import bpy, argparse, json, os, sys
from pathlib import Path
from mathutils import Vector

parser = argparse.ArgumentParser(description=__doc__)
city3 = Path(__file__).resolve().parent
parser.add_argument('--source', type=Path, default=city3 / 'assets/user_uploads/mira_maid')
parser.add_argument('--output', type=Path, default=city3.parents[1] / 'apps/console/public/assets/residents/mira-maid.glb')
parser.add_argument('--blend-output', type=Path)
args = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
source, out = args.source, args.output
out.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.wm.obj_import(filepath=str(next(source.glob('*.obj'))), forward_axis='NEGATIVE_Z', up_axis='Y')
objects = [o for o in bpy.context.scene.objects if o.type == 'MESH']
bpy.ops.object.select_all(action='DESELECT')
for obj in objects: obj.select_set(True)
bpy.context.view_layer.objects.active = objects[0]
if len(objects) > 1: bpy.ops.object.join()
obj = bpy.context.view_layer.objects.active
obj.name = 'Mira'
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
points = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
lo = Vector([min(p[i] for p in points) for i in range(3)])
hi = Vector([max(p[i] for p in points) for i in range(3)])
factor = 1.68 / (hi.z - lo.z)
center = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
for v in obj.data.vertices: v.co = (obj.matrix_world @ v.co - center) * factor
obj.matrix_world.identity()
source_triangles = sum(len(p.vertices)-2 for p in obj.data.polygons)
mod = obj.modifiers.new('Browser mesh budget', 'DECIMATE')
mod.ratio = min(1., 30000 / source_triangles)
mod.use_collapse_triangulate = True
bpy.ops.object.modifier_apply(modifier=mod.name)
for p in obj.data.polygons: p.use_smooth = True

mat = bpy.data.materials.new('Mira / supplied PBR')
mat.use_nodes = True
nodes = mat.node_tree.nodes
links = mat.node_tree.links
shader = nodes.get('Principled BSDF')
shader.inputs['Roughness'].default_value = .7
shader.inputs['Metallic'].default_value = 0
for suffix, socket in [('', 'Base Color'), ('_roughness', 'Roughness'), ('_metallic', 'Metallic'), ('_normal', None)]:
    small = source / f'texture_pbr_20250901{suffix}_1k.png'
    img = bpy.data.images.load(str(small if small.exists() else source / f'texture_pbr_20250901{suffix}.png'), check_existing=True)
    if tuple(img.size) != (1024, 1024): img.scale(1024, 1024)
    img.colorspace_settings.name = 'sRGB' if not suffix else 'Non-Color'
    img.pack()
    tex = nodes.new('ShaderNodeTexImage'); tex.image = img
    if socket: links.new(tex.outputs['Color'], shader.inputs[socket])
    else:
        normal = nodes.new('ShaderNodeNormalMap')
        links.new(tex.outputs['Color'], normal.inputs['Color'])
        links.new(normal.outputs['Normal'], shader.inputs['Normal'])
obj.data.materials.clear(); obj.data.materials.append(mat)
obj['residentName'] = 'Mira'
obj['animationStatus'] = 'Static OBJ source; no armature or animation'
if args.blend_output:
    args.blend_output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(args.blend_output))
bpy.ops.export_scene.gltf(filepath=str(out), export_format='GLB', use_selection=True, export_animations=False, export_extras=True)
report = {'name': 'Mira', 'source_triangles': source_triangles, 'triangles': sum(len(p.vertices)-2 for p in obj.data.polygons), 'dimensions_blender_m': list(obj.dimensions), 'texture_size': 1024, 'rigged': False, 'animated': False, 'bytes': out.stat().st_size}
out.with_suffix('.prepared.json').write_text(json.dumps(report, indent=2)+'\n')
print('MIRA_PREPARED', json.dumps(report), flush=True)
sys.stdout.flush(); sys.stderr.flush()
# This headless runtime can hang in PulseAudio shutdown after a successful export.
os._exit(0)
