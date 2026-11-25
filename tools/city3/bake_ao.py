"""Bake ambient occlusion into the loft kit as VERTEX COLOUR (glTF COLOR_0).

    tools/city3/blender_lock.sh -b --factory-startup --python tools/city3/bake_ao.py -- \\
        [--src GLB] [--out GLB] [--dirt-angle rad] [--normalize 1]

Why vertex colour and not a map: the library is diffuse-only and many materials share a `palette`
atlas, so baking AO into a per-object UV space and multiplying it into the base map blacked out every
pixel the palette does not cover (measured 2026-11-25: -48 luma, 71 % of pixels darkened, mean baked
AO 0.03-0.13 because most of the image is unbaked black). Vertex colour needs no second UV channel,
adds no texture memory, and three.js applies COLOR_0 automatically; the cost is resolution - it is
per-vertex, so it wants the ~3.5-8k tris the kit already carries.

`paint.vertex_color_dirt` is the classic Dirty Vertex Colours pass: 26-53 ms per asset.
"""
import bpy, json, os, struct, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
ARGV = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
opt = dict(zip(ARGV[::2], ARGV[1::2]))
SRC = os.path.abspath(opt.get('--src', os.path.join(ROOT, 'apps/console/public/assets/interiors/modern-loft-interior.glb')))
OUT = os.path.abspath(opt.get('--out', '/tmp/modern-loft-ao.glb'))
DIRT = float(opt.get('--dirt-angle', 0.0))
NORM = opt.get('--normalize', '1') == '1'

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_scene.gltf(filepath=SRC)

rows, t0 = [], time.time()
for obj in sorted((o for o in bpy.data.objects if o.type == 'MESH' and o.name.startswith('LIB_')), key=lambda o: o.name):
    t = time.time()
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    try:
        bpy.ops.paint.vertex_color_dirt(blur_strength=1.0, blur_iterations=1, clean_angle=3.14159,
                                       dirt_angle=DIRT, dirt_only=False, normalize=NORM)
        attrs = [c.name for c in obj.data.color_attributes]
        rows.append({'asset': obj.name, 'ok': True, 'attr': attrs[0] if attrs else None,
                     'vertices': len(obj.data.vertices), 'ms': round((time.time() - t) * 1000)})
    except Exception as exc:
        rows.append({'asset': obj.name, 'ok': f'{type(exc).__name__}: {exc}'})

bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_image_format='JPEG',
                          export_image_quality=80, export_apply=True, export_animations=False)

with open(OUT, 'rb') as f:
    b = f.read()
jl = struct.unpack('<I', b[12:16])[0]
doc = json.loads(b[20:20 + jl])
prims = [p for m in doc.get('meshes', []) for p in m['primitives']]
with_color = sum(1 for p in prims if 'COLOR_0' in p.get('attributes', {}))
rep = {'assets': len(rows), 'ok': sum(1 for r in rows if r.get('ok') is True),
       'primitives': len(prims), 'with_color0': with_color,
       'src_mb': round(os.path.getsize(SRC) / 1e6, 2), 'out_mb': round(os.path.getsize(OUT) / 1e6, 2),
       'total_s': round(time.time() - t0, 1), 'rows': rows}
json.dump(rep, open('/tmp/ao-report.json', 'w'), indent=1)
print(f"AO_VCOL {rep['ok']}/{rep['assets']} assets, {with_color}/{rep['primitives']} primitives carry COLOR_0, "
      f"{rep['src_mb']} -> {rep['out_mb']} MB in {rep['total_s']} s")
