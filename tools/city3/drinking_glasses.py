"""Committed Verres templates used by the full generator; shared PBR materials are retained."""
from pathlib import Path

KIT = Path(__file__).resolve().parent/'assets/verres/drinkware.glb'
_CACHE = {}


def template(kind, collection):
    import bpy
    from mathutils import Matrix
    if not _CACHE:
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=str(KIT))
        imported = set(bpy.data.objects)-before
        for key, source_name, final_name in [('bazaar','inst_goods_goblets','LIB_g_goblets'), ('interior','LIB_brass_goblets','LIB_brass_goblets')]:
            obj = next(o for o in imported if o.type == 'MESH' and o.name.startswith(source_name))
            obj.parent = None
            obj.matrix_world = Matrix.Identity(4)
            obj.name = final_name
            for old in list(obj.users_collection): old.objects.unlink(obj)
            collection.objects.link(obj)
            _CACHE[key] = obj
        for obj in imported-set(_CACHE.values()): bpy.data.objects.remove(obj, do_unlink=True)
        bpy.context.view_layer.update()
    return _CACHE[kind]


def install_library():
    import bpy
    import assets_kit
    old = assets_kit.LIB.get('brass_goblets')
    obj = template('interior', assets_kit._lib_collection())
    if old and old['obj'] is not obj:
        bpy.data.objects.remove(old['obj'], do_unlink=True)
    obj.name = 'LIB_brass_goblets'
    assets_kit.LIB['brass_goblets'] = {
        'obj':obj, 'dims':tuple(obj.dimensions), 'tris_raw':sum(len(p.vertices)-2 for p in obj.data.polygons),
        'tris':sum(len(p.vertices)-2 for p in obj.data.polygons), 'source':'user upload', 'id':'verres',
        'credit':'User upload: Verres.FBX / Verres.obj', 'credit_license':'not supplied in upload'}
