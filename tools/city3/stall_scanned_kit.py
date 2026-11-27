"""Build the scanned bottle/fruit goods templates (Poly Haven CC0).

    tools/city3/blender_lock.sh -b --disable-autoexec --python tools/city3/stall_scanned_kit.py -- WORLD.glb
    python3 tools/city3/bridge_market_templates.py WORLD.glb OUT.glb --kit tools/city3/assets/stall_scanned/kit.glb

Reads footprints from the world's own templates, so bottles and heaps keep their places.
Sources: ~/Developer/city3-downloads/stall-food/<asset>/ (1k glTF).
"""
import bmesh
import bpy
import os
import random
import sys
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.environ.get("SRC", os.path.expanduser("~/Developer/city3-downloads/stall-food"))
BOTTLES = ("bottles_amber", "bottles_blue", "bottles_green", "bottles_mixed")
HEAPS = {"mound_pears": "food_pears_asian_01", "mound_plums": "food_pomegranate_01", "mound_lemons": "bananas"}
TRIS = {"wine_bottles_01": 2000, "food_pears_asian_01": 300, "food_pomegranate_01": 400, "bananas": 400}
rng = random.Random(4)


def box(points):
    lo = Vector([min(p[i] for p in points) for i in range(3)])
    return lo, Vector([max(p[i] for p in points) for i in range(3)])


def load(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    bpy.context.view_layer.update()
    return sorted(set(bpy.data.objects) - before, key=lambda o: o.name)


def protos(asset):
    """Decimated copies of one download's meshes, origin at the base centre."""
    folder = f"{SRC}/{asset}"
    new = load(folder + "/" + next(f for f in os.listdir(folder) if f.endswith(".gltf")))
    out = []
    for o in new:
        if o.type != "MESH" or o.name.endswith("bunch"):
            continue
        mod = o.modifiers.new("d", "DECIMATE")
        mod.ratio = min(1, TRIS[asset] / sum(len(p.vertices) - 2 for p in o.data.polygons))
        me = bpy.data.meshes.new_from_object(o.evaluated_get(bpy.context.evaluated_depsgraph_get()))
        me.transform(o.matrix_world)
        lo, hi = box([v.co for v in me.vertices])
        me.transform(Matrix.Translation((-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -lo.z)))
        out.append((me, hi.z - lo.z, max(hi.x - lo.x, hi.y - lo.y)))
    for o in new:
        bpy.data.objects.remove(o)
    return out


def instance(me, at, scale=1.0, turn=0.0):
    copy = me.copy()
    copy.transform(Matrix.LocRotScale(at, Matrix.Rotation(turn, 3, "Z"), (scale,) * 3))
    o = bpy.data.objects.new("part", copy)
    bpy.context.scene.collection.objects.link(o)
    return o


def join(parts, name, parent):
    bpy.ops.object.select_all(action="DESELECT")
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = name
    o.parent = parent


def islands(bm):
    seen = set()
    for v in bm.verts:
        if v in seen:
            continue
        seen.add(v)
        stack, group = [v], []
        while stack:
            a = stack.pop()
            group.append(a)
            for e in a.link_edges:
                b = e.other_vert(a)
                if b not in seen:
                    seen.add(b)
                    stack.append(b)
        yield group


bpy.ops.wm.read_factory_settings(use_empty=True)
world = load(sys.argv[sys.argv.index("--") + 1])
templates = {}
for key in BOTTLES + tuple(HEAPS):
    src = next(o for o in world if o.type == "MESH" and o.name.split(".")[0] == "g_" + key)
    templates[key] = src.data.copy()
for o in world:
    bpy.data.objects.remove(o)

wood = bpy.data.materials.new("stall_board_wood")
wood.use_nodes = True
bsdf = next(n for n in wood.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
bsdf.inputs["Base Color"].default_value = (0.23, 0.12, 0.055, 1)
bsdf.inputs["Roughness"].default_value = 0.85
root = bpy.data.objects.new("City3GoodsTemplates", None)
bpy.context.scene.collection.objects.link(root)
bottles = protos("wine_bottles_01")

n = 0
for key in BOTTLES:
    bm = bmesh.new()
    bm.from_mesh(templates[key])
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0002)
    parts, old = [], []
    for group in list(islands(bm)):
        lo, hi = box([v.co for v in group])
        if hi.z - lo.z <= 0.1:
            continue                                  # the board stays
        me, h, _ = bottles[n % len(bottles)]
        n += 1
        parts.append(instance(me, Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z)),
                              (hi.z - lo.z) / h, rng.uniform(-0.5, 0.5)))
        old += group
    assert parts, f"{key}: no bottles found in template"
    bmesh.ops.delete(bm, geom=old, context="VERTS")
    board = bpy.data.meshes.new(key + "_board")
    bm.to_mesh(board)
    bm.free()
    board.materials.append(wood)
    parts.append(instance(board, Vector()))
    join(parts, "inst_goods_" + key, root)

heap_protos = {asset: protos(asset) for asset in set(HEAPS.values())}
for key, asset in HEAPS.items():
    lo, hi = box([v.co for v in templates[key].vertices])
    mid, kit, parts = (lo + hi) / 2, heap_protos[asset], []
    if asset == "bananas":
        for k in range(4):
            me = kit[k % len(kit)][0]
            parts.append(instance(me, Vector((mid.x - 0.11 + k * 0.075, mid.y, lo.z + 0.002 * k)),
                                  turn=rng.uniform(-0.25, 0.25)))
    else:
        w = max(p[2] for p in kit)
        nx = max(2, int((hi.x - lo.x) / w))
        ny = max(1, int((hi.y - lo.y) / w))
        for layer in range(2):
            rows = max(1, ny - layer)
            for i in range(nx - layer):
                for j in range(rows):
                    me, h, _ = kit[rng.randrange(len(kit))]
                    at = Vector((mid.x + (i - (nx - layer - 1) / 2) * w * 0.95,
                                 mid.y + (j - (rows - 1) / 2) * w * 0.95, lo.z + layer * h * 0.7))
                    parts.append(instance(me, at, turn=rng.uniform(0, 6.28)))
    join(parts, "inst_goods_" + key, root)

bpy.ops.object.select_all(action="DESELECT")
for o in [root, *root.children]:
    o.select_set(True)
    if o.type == "MESH":
        print("TEMPLATE", o.name, sum(len(p.vertices) - 2 for p in o.data.polygons))
bpy.ops.export_scene.gltf(filepath=f"{HERE}/assets/stall_scanned/kit.glb", export_format="GLB",
                          use_selection=True, export_animations=False, export_image_format="AUTO")
