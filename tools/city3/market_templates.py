"""Approved fruit/vase meshes, retained as a compact, reproducible asset library."""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
KIT = HERE/'assets/market_realism/fruit-vases.glb'
KEYS = frozenset(json.loads((KIT.parent/'manifest.json').read_text())['templates'])
_CACHE = {}


def template(key, collection):
    import bpy
    if not _CACHE:
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=str(KIT))
        imported = set(bpy.data.objects)-before
        for obj in imported:
            if obj.type != 'MESH': continue
            name = obj.name.removeprefix('inst_goods_')
            if name not in KEYS: continue
            obj.parent = None
            obj.name = 'LIB_g_'+name
            for old in list(obj.users_collection): old.objects.unlink(obj)
            collection.objects.link(obj)
            _CACHE[name] = obj
        for obj in imported-set(_CACHE.values()): bpy.data.objects.remove(obj, do_unlink=True)
        bpy.context.view_layer.update()
    return _CACHE[key]
