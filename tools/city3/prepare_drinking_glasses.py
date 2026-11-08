"""Prepare the user's Verres OBJ as two reusable, thin-walled glass sets.

Run through blender_lock.sh --python prepare_drinking_glasses.py -- --source Verres.obj.
Only geometry is imported; the source's offline-renderer materials are replaced with glTF PBR.
"""
import argparse
import json
import os
from pathlib import Path
import sys

import bpy
import bmesh
from mathutils import Vector


def prepare(source, output):
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    bpy.ops.wm.obj_import(filepath=str(source), use_split_groups=True, use_split_objects=True)
    bpy.context.view_layer.update()
    originals = {o.name: o for o in bpy.context.scene.objects if o.type == 'MESH'}
    mat = bpy.data.materials.new('Drinkware_Clear_Glass')
    mat.use_nodes = True
    mat.use_backface_culling = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    shader = nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (.97, .995, .985, 1)
    shader.inputs['Metallic'].default_value = 0
    shader.inputs['Roughness'].default_value = .075
    shader.inputs['Transmission Weight'].default_value = 1
    shader.inputs['IOR'].default_value = 1.5
    volume = nodes.new('ShaderNodeVolumeAbsorption')
    volume.inputs['Color'].default_value = (.92, 1, .96, 1)
    volume.inputs['Density'].default_value = .3
    links.new(volume.outputs['Volume'], nodes.get('Material Output').inputs['Volume'])
    from io_scene_gltf2.blender.com.material_helpers import create_settings_group
    # Blender 5.2 inlines materials unless the settings node has Occlusion; inlining drops Thickness.
    settings = create_settings_group('glTF Material Output')
    group = nodes.new('ShaderNodeGroup')
    group.node_tree = settings
    group.inputs['Occlusion'].default_value = 1
    group.inputs['Thickness'].default_value = .0015

    def make_set(name, items):
        verts, faces, report = [], [], []
        for source_name, x, y, height in items:
            original = originals[source_name]
            points = [original.matrix_world @ v.co for v in original.data.vertices]
            lo = Vector([min(v[i] for v in points) for i in range(3)])
            hi = Vector([max(v[i] for v in points) for i in range(3)])
            center = Vector(((lo.x + hi.x)/2, (lo.y + hi.y)/2, lo.z))
            scale = height/(hi.z-lo.z)
            start = len(verts)
            verts += [tuple((v-center)*scale+Vector((x,y,0))) for v in points]
            faces += [tuple(start+i for i in p.vertices) for p in original.data.polygons]
            report.append({'source':source_name, 'position_blender':[x,y,0], 'height_m':height})
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(verts, [], faces)
        mesh.update()
        bm = bmesh.new(); bm.from_mesh(mesh)
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        assert all(e.is_manifold for e in bm.edges), 'Glass walls must remain closed solids'
        bm.to_mesh(mesh); bm.free()
        for polygon in mesh.polygons: polygon.use_smooth = True
        mesh.materials.append(mat)
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        return obj, {'name':name, 'triangles':sum(len(p.vertices)-2 for p in mesh.polygons), 'items':report}

    bazaar, bazaar_report = make_set('inst_goods_goblets', [
        ('WineGlass_01',-.2,0,.19), ('WaterGlass_01',0,.05,.16), ('ElinaChampagneGlass_01',.2,-.02,.21)])
    interior, interior_report = make_set('LIB_brass_goblets', [
        ('WineGlass_01',-.155,.075,.24), ('WaterGlass_01',0,-.075,.15), ('ElinaChampagneGlass_01',.155,.075,.265)])
    # The source kit displays the sets separately; patching/generation uses their local mesh coordinates.
    interior.location.x = .8
    for obj in originals.values(): bpy.data.objects.remove(obj, do_unlink=True)
    root = bpy.data.objects.new('DrinkwareTemplates', None)
    bpy.context.scene.collection.objects.link(root)
    bazaar.parent = root; interior.parent = root
    bpy.ops.object.select_all(action='SELECT')
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=str(output), export_format='GLB', use_selection=True, export_animations=False)
    result = {'source_meshes':len(originals), 'sets':[bazaar_report, interior_report], 'bytes':output.stat().st_size}
    print('DRINKWARE_PREPARED', json.dumps(result), flush=True)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parent/'assets/verres/Verres.obj')
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parent/'assets/verres/drinkware.glb')
    args = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
    report = prepare(args.source, args.output)
    args.output.with_suffix('.prepared.json').write_text(json.dumps(report, indent=2)+'\n')
    # The host can hang in PulseAudio shutdown after a completed export.
    sys.stdout.flush(); sys.stderr.flush(); os._exit(0)
