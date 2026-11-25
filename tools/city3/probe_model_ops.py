"""Probe unwrap / retopo / rigging headless, with timings and counts.

    tools/city3/blender_lock.sh -b --factory-startup --python tools/city3/probe_model_ops.py

Writes /tmp/model-ops.json and prints one line per section.
"""
import addon_utils, bpy, json, os, time, traceback

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.abspath(os.path.join(HERE, '..', '..', 'apps', 'console', 'public', 'assets'))
R = {}

def step(name):
    def wrap(fn):
        t0 = time.time()
        try:
            R[name] = fn() or {}
        except Exception as exc:
            R[name] = {'error': f'{type(exc).__name__}: {exc}',
                       'trace': traceback.format_exc().splitlines()[-3:]}
        R[name]['ms'] = round((time.time() - t0) * 1000)
        print(f'[ops] {name}: {"ok" if "error" not in R[name] else "FAILED"}', flush=True)
        return fn
    return wrap

def fresh(glb='interiors/modern-loft-interior.glb', pick='LIB_loft_sofa'):
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.import_scene.gltf(filepath=os.path.join(ASSETS, glb))
    return next(o for o in bpy.data.objects if o.name.startswith(pick))

def tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)

def activate(o):
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o

@step('unwrap')
def _unwrap():
    o = fresh()
    activate(o)
    had_uv = [l.name for l in o.data.uv_layers]
    # 1. smart project (the kits' path)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.02)
    bpy.ops.object.mode_set(mode='OBJECT')
    smart_uv = [l.name for l in o.data.uv_layers]
    # 2. seams from islands, then a real ANGLE_BASED unwrap on a copy
    dup = o.copy(); dup.data = o.data.copy(); bpy.context.scene.collection.objects.link(dup)
    activate(dup)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.seams_from_islands(mark_seams=True)
    bpy.ops.uv.unwrap(method='ANGLE_BASED', margin=0.02)
    bpy.ops.uv.pack_islands(margin=0.02, rotate=True)
    bpy.ops.object.mode_set(mode='OBJECT')
    seams = sum(1 for e in dup.data.edges if e.use_seam)
    # UV coverage: share of the 0..1 square used by the loops' bounding box
    uv = dup.data.uv_layers.active.data
    us = [d.uv[0] for d in uv]; vs = [d.uv[1] for d in uv]
    return {'had_uv': had_uv, 'smart_uv': smart_uv, 'seams': seams,
            'uv_bbox': [round(min(us), 3), round(min(vs), 3), round(max(us), 3), round(max(vs), 3)],
            'loops': len(uv)}

@step('retopo_quadriflow')
def _quadriflow():
    o = fresh(pick='LIB_loft_bed')
    before = tris(o)
    activate(o)
    bpy.ops.object.quadriflow_remesh(target_faces=400, use_mesh_symmetry=False)
    quads = sum(1 for p in o.data.polygons if len(p.vertices) == 4)
    return {'object': o.name, 'tris_before': before, 'faces_after': len(o.data.polygons), 'quads': quads}

@step('retopo_voxel')
def _voxel():
    o = fresh(pick='LIB_loft_vase')
    before = tris(o)
    activate(o)
    o.data.remesh_voxel_size = max(0.004, max(o.dimensions) / 60)
    bpy.ops.object.voxel_remesh()
    return {'object': o.name, 'tris_before': before, 'tris_after': tris(o),
            'voxel_size': round(o.data.remesh_voxel_size, 4)}

@step('retopo_shrinkwrap')
def _shrinkwrap():
    src = fresh(pick='LIB_loft_counter')
    before = tris(src)
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=24, y_subdivisions=24, size=max(src.dimensions))
    grid = bpy.context.active_object
    grid.location = src.location
    m = grid.modifiers.new('sw', 'SHRINKWRAP')
    m.target = src
    m.wrap_method = 'PROJECT'
    m.use_project_z = True
    bpy.ops.object.modifier_apply(modifier=m.name)
    return {'source_tris': before, 'grid_faces': len(grid.data.polygons), 'applied': True}

@step('rig_auto_weights')
def _rig():
    o = fresh(pick='LIB_loft_sofa')
    activate(o)
    bpy.ops.object.armature_add(enter_editmode=True, location=(0, 0, 0))
    arm = bpy.context.active_object
    eb = arm.data.edit_bones
    for b in list(eb):
        eb.remove(b)
    root = eb.new('root'); root.head = (0, 0, 0); root.tail = (0, 0, 0.4)
    spine = eb.new('spine'); spine.head = (0, 0, 0.4); spine.tail = (0, 0, 0.9); spine.parent = root
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True); arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    groups = [g.name for g in o.vertex_groups]
    weighted = sum(1 for v in o.data.vertices if v.groups and any(g.weight > 0 for g in v.groups))
    return {'bones': len(arm.data.bones), 'vertex_groups': groups,
            'vertices': len(o.data.vertices), 'vertices_weighted': weighted,
            'modifier': [m.type for m in o.modifiers]}

@step('rig_addons')
def _rig_addons():
    out = {}
    for mod in ('bl_ext.blender_org.retarget', 'bl_ext.blender_org.cloudrig', 'rigify'):
        try:
            addon_utils.enable(mod, default_set=False)
            ns = mod.split('.')[-1]
            out[ns] = sorted(n for n in dir(getattr(bpy.ops, ns, object())) if not n.startswith('_'))[:10]
        except Exception as exc:
            out[mod] = f'{type(exc).__name__}: {exc}'
    return out

json.dump(R, open('/tmp/model-ops.json', 'w'), indent=1)
print('[ops] wrote /tmp/model-ops.json')
