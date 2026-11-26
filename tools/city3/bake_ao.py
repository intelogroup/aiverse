"""Bake cavity shading into the loft kit as VERTEX COLOUR (glTF COLOR_0).

    tools/city3/blender_lock.sh -b --factory-startup --python tools/city3/bake_ao.py -- \\
        [--src GLB] [--out GLB] [--strength 2.0] [--dirt-angle 0]

Why vertex colour and not a map: the library is diffuse-only and many materials share a `palette`
atlas, so baking AO into a per-object UV space and multiplying it into the base map blacked out every
pixel the palette does not cover (measured 2026-11-25: -48 luma, 71 % of pixels darkened, mean baked
AO 0.03-0.13 because most of the image is unbaked black). Vertex colour needs no second UV channel,
adds no texture memory, and three.js applies COLOR_0 automatically; the cost is resolution.

Two traps this script now handles (both cost a full run on 2026-11-25):

1. `paint.vertex_color_dirt` writes into a layer *it* owns. On a mesh that already carries one it
   appends a second attribute and the exporter ships the old, untouched (pure white) layer - which
   looks exactly like "no AO" while reporting COLOR_0 on every primitive. So: reduce to exactly one
   BYTE_COLOR/CORNER layer, make it active, then bake.
2. `normalize=True` rescales the result so the darkest vertex is 0 and the median lands near 0.53 -
   multiplying that into albedo halves the room's brightness. The cavity look wants
   `dirt_only=True, normalize=False` (min 0.85, mean 0.998) plus an explicit `--strength` remap.

The run aborts if any asset comes out effectively white (mean > 0.999), so a silent no-op can never
be reported as success again.
"""
import bpy, json, os, struct, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
ARGV = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
opt = dict(zip(ARGV[::2], ARGV[1::2]))
SRC = os.path.abspath(opt.get('--src', os.path.join(ROOT, 'apps/console/public/assets/interiors/modern-loft-interior.glb')))
OUT = os.path.abspath(opt.get('--out', '/tmp/modern-loft-ao.glb'))
STRENGTH = float(opt.get('--strength', 2.0))
DIRT = float(opt.get('--dirt-angle', 0.0))

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_scene.gltf(filepath=SRC)

def single_layer(mesh):
    ca = mesh.color_attributes
    while len(ca) > 1:
        ca.remove(ca[-1])
    if len(ca) == 0:
        ca.new(name='Color', type='BYTE_COLOR', domain='CORNER')
    layer = ca[0]
    ca.active_color = layer
    return layer

rows, t0 = [], time.time()
for obj in sorted((o for o in bpy.data.objects if o.type == 'MESH' and o.name.startswith('LIB_')), key=lambda o: o.name):
    t = time.time()
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    layer = single_layer(obj.data)
    try:
        bpy.ops.paint.vertex_color_dirt(blur_strength=1.0, blur_iterations=1, clean_angle=3.14159,
                                       dirt_angle=DIRT, dirt_only=True, normalize=False)
    except Exception as exc:
        rows.append({'asset': obj.name, 'ok': f'{type(exc).__name__}: {exc}'})
        continue
    raw = [d.color[0] for d in layer.data]
    if STRENGTH != 1.0:
        for d in layer.data:
            v = max(0.0, min(1.0, 1.0 - (1.0 - d.color[0]) * STRENGTH))
            d.color = (v, v, v, 1.0)
    out = [d.color[0] for d in layer.data]
    rows.append({'asset': obj.name, 'ok': True, 'vertices': len(obj.data.vertices),
                 'raw_min': round(min(raw), 3), 'raw_mean': round(sum(raw) / len(raw), 4),
                 'min': round(min(out), 3), 'mean': round(sum(out) / len(out), 4),
                 'noop': (sum(raw) / len(raw)) > 0.999,
                 'ms': round((time.time() - t) * 1000)})

bpy.ops.object.select_all(action='SELECT')
# export_vertex_color='ACTIVE' + export_all_vertex_colors=False is load-bearing: with the defaults
# ('MATERIAL', all=True) the exporter writes TWO colour sets, leaves COLOR_0 white and puts the baked
# cavity pass in COLOR_1 - three.js reads COLOR_0, so the AO silently disappears.
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_image_format='WEBP',
                          export_image_quality=82, export_apply=True, export_animations=False,
                          export_vertex_color='ACTIVE', export_all_vertex_colors=False)

with open(OUT, 'rb') as f:
    b = f.read()
jl = struct.unpack('<I', b[12:16])[0]
doc = json.loads(b[20:20 + jl])
prims = [p for m in doc.get('meshes', []) for p in m['primitives']]
with_color = sum(1 for p in prims if 'COLOR_0' in p.get('attributes', {}))
noop = [r['asset'] for r in rows if r.get('noop')]
rep = {'assets': len(rows), 'ok': sum(1 for r in rows if r.get('ok') is True),
       'noop': noop, 'primitives': len(prims), 'with_color0': with_color,
       'min_mean': [min(r.get('min', 1) for r in rows if r.get('ok') is True),
                    round(sum(r.get('mean', 1) for r in rows if r.get('ok') is True) / max(1, sum(1 for r in rows if r.get('ok') is True)), 4)],
       'src_mb': round(os.path.getsize(SRC) / 1e6, 2), 'out_mb': round(os.path.getsize(OUT) / 1e6, 2),
       'total_s': round(time.time() - t0, 1), 'rows': rows}
json.dump(rep, open('/tmp/ao-report.json', 'w'), indent=1)
print(f"AO_VCOL {rep['ok']}/{rep['assets']} baked, darkest {rep['min_mean'][0]:.3f}, mean {rep['min_mean'][1]:.4f}, "
      f"{with_color}/{rep['primitives']} prims COLOR_0, {rep['src_mb']} -> {rep['out_mb']} MB in {rep['total_s']} s, no-ops: {noop or 'none'}")
