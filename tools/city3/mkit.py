"""Shared helpers for the modern districts (runs inside headless Blender 5.2 Python).
Builds on kit.py (MB buckets keyed by material, Frame, fbox). Differences from City 3:
 - PBR materials (diffuse + GL normal map, scalar roughness) from tex_m/ (mtex.py)
 - UVs are in metres / tile size, world-anchored, so a wall continues across quads
 - footprints are convex polygons (rect, chamfered, ellipse) with per-edge wall frames
Every material is single-sided; glass-like surfaces that must be seen from both sides are emitted twice."""
import bpy, json, math, os, random
from mathutils import Vector
import kit
from kit import MB, mb, MBS, grp, Frame, frame_for, pquad, ptri, fbox, pbox, cyl, hcyl, pal_uv
HERE = os.path.dirname(os.path.abspath(__file__)); TEX = f"{HERE}/tex_m"
PALM = json.load(open(f"{HERE}/palette_m.json")); kit.PAL.clear(); kit.PAL.update(PALM)       # palette-swatch colours for kit.pal_uv
GA = json.load(open(f"{HERE}/glass_atlas.json")); MS = json.load(open(f"{HERE}/msigns.json")); PB = json.load(open(f"{HERE}/pbr_m.json"))
MATS = {}
def _img(path, nc=False):
    im = bpy.data.images.load(path)
    if nc: im.colorspace_settings.name = "Non-Color"
    return im
def _principled(name):
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree
    for n in list(nt.nodes):
        if n.type not in ("OUTPUT_MATERIAL", "BSDF_PRINCIPLED"): nt.nodes.remove(n)
    m.use_backface_culling = True; return m, nt, nt.nodes["Principled BSDF"]
def pbr_mat(key, tag=None, rough=None, metal=0.0):
    """Poly Haven set `tag` (tex_m/<tag>_d.jpg + _n.jpg) as a PBR material named `key`."""
    tag = tag or key; m, nt, b = _principled(key); info = PB[tag]
    t = nt.nodes.new("ShaderNodeTexImage"); t.image = _img(f"{TEX}/{tag}_d.jpg"); t.extension = "REPEAT"; nt.links.new(t.outputs["Color"], b.inputs["Base Color"])
    n = nt.nodes.new("ShaderNodeTexImage"); n.image = _img(f"{TEX}/{tag}_n.jpg", True); n.extension = "REPEAT"
    nm = nt.nodes.new("ShaderNodeNormalMap"); nt.links.new(n.outputs["Color"], nm.inputs["Color"]); nt.links.new(nm.outputs["Normal"], b.inputs["Normal"])
    b.inputs["Roughness"].default_value = info["rough"] if rough is None else rough; b.inputs["Metallic"].default_value = metal
    MATS[key] = m; return m
def img_mat(key, img, emit_img=None, rough=0.3, metal=0.0, emit=1.0, ext="EXTEND"):
    m, nt, b = _principled(key)
    t = nt.nodes.new("ShaderNodeTexImage"); t.image = _img(f"{TEX}/{img}"); t.extension = ext; nt.links.new(t.outputs["Color"], b.inputs["Base Color"])
    if emit_img:
        e = nt.nodes.new("ShaderNodeTexImage"); e.image = _img(f"{TEX}/{emit_img}"); e.extension = ext
        nt.links.new(e.outputs["Color"], b.inputs["Emission Color"]); b.inputs["Emission Strength"].default_value = emit
    b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = metal; MATS[key] = m; return m
def palette_mat(key="palette", rough=0.55, metal=0.0, emit=0.0):
    m, nt, b = _principled(key); t = nt.nodes.new("ShaderNodeTexImage"); t.image = _img(f"{TEX}/palette_m.png"); t.interpolation = "Closest"
    nt.links.new(t.outputs["Color"], b.inputs["Base Color"]); b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = metal
    if emit: nt.links.new(t.outputs["Color"], b.inputs["Emission Color"]); b.inputs["Emission Strength"].default_value = emit
    MATS[key] = m; return m
def glass_mat(key="shopglass", alpha=0.18, tint=(0.62, 0.8, 0.9, 1.0)):
    m, nt, b = _principled(key); b.inputs["Base Color"].default_value = tint; b.inputs["Roughness"].default_value = 0.04; b.inputs["Alpha"].default_value = alpha
    m.use_backface_culling = False
    for a, v in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
        try: setattr(m, a, v)
        except Exception: pass
    MATS[key] = m; return m

# ---------------------------------------------------------------- textured geometry (UV in metres / tile)
def tquad(mat, a, b, c, d, uv, out=None): mb(mat).quad(a, b, c, d, uv[0], uv[1], uv[2], uv[3], out)
def wall(fr, u0, u1, z0, z1, mat, tile, t=0.0, uoff=0.0, zoff=0.0):
    """Wall-local textured quad (front face outward along fr.n). UV = (u, z) / tile so patterns line up between neighbours."""
    P = fr.p; a = (u0 + uoff) / tile; b = (u1 + uoff) / tile; c = (z0 + fr.z0 + zoff) / tile; d = (z1 + fr.z0 + zoff) / tile
    tquad(mat, P(u0, t, z0), P(u1, t, z0), P(u1, t, z1), P(u0, t, z1), [(a, c), (b, c), (b, d), (a, d)], fr.o(0, 1))
def reveal(fr, u0, u1, z0, z1, t_front, t_back, mat, tile):
    """The four inner faces of a window/door opening (front plane t_front, glass plane t_back < t_front)."""
    P = fr.p; dt = abs(t_front - t_back)
    # left face (normal +u), right face (normal -u), sill (normal +z), head (normal -z)
    tquad(mat, P(u0, t_back, z0), P(u0, t_front, z0), P(u0, t_front, z1), P(u0, t_back, z1), [(0, z0 / tile), (dt / tile, z0 / tile), (dt / tile, z1 / tile), (0, z1 / tile)], fr.o(1, 0))
    tquad(mat, P(u1, t_front, z0), P(u1, t_back, z0), P(u1, t_back, z1), P(u1, t_front, z1), [(0, z0 / tile), (dt / tile, z0 / tile), (dt / tile, z1 / tile), (0, z1 / tile)], fr.o(-1, 0))
    tquad(mat, P(u0, t_front, z0), P(u1, t_front, z0), P(u1, t_back, z0), P(u0, t_back, z0), [(u0 / tile, 0), (u1 / tile, 0), (u1 / tile, dt / tile), (u0 / tile, dt / tile)], (0, 0, 1))
    tquad(mat, P(u0, t_back, z1), P(u1, t_back, z1), P(u1, t_front, z1), P(u0, t_front, z1), [(u0 / tile, 0), (u1 / tile, 0), (u1 / tile, dt / tile), (u0 / tile, dt / tile)], (0, 0, -1))
def wbox(fr, u0, u1, t0, t1, z0, z1, mat, tile, top=True, uoff=0.0):
    """Textured box in a wall frame: front, both ends and top (the back/bottom are never seen)."""
    P = fr.p; w = lambda ua, ub, za, zb, t, nrm: tquad(mat, P(ua, t, za), P(ub, t, za), P(ub, t, zb), P(ua, t, zb), [((ua + uoff) / tile, (za + fr.z0) / tile), ((ub + uoff) / tile, (za + fr.z0) / tile), ((ub + uoff) / tile, (zb + fr.z0) / tile), ((ua + uoff) / tile, (zb + fr.z0) / tile)], nrm)
    w(u0, u1, z0, z1, t1, fr.o(0, 1))
    d = (t1 - t0) / tile
    tquad(mat, P(u0, t1, z0), P(u0, t0, z0), P(u0, t0, z1), P(u0, t1, z1), [(0, z0 / tile), (d, z0 / tile), (d, z1 / tile), (0, z1 / tile)], fr.o(-1, 0))
    tquad(mat, P(u1, t0, z0), P(u1, t1, z0), P(u1, t1, z1), P(u1, t0, z1), [(0, z0 / tile), (d, z0 / tile), (d, z1 / tile), (0, z1 / tile)], fr.o(1, 0))
    if top: tquad(mat, P(u0, t0, z1), P(u1, t0, z1), P(u1, t1, z1), P(u0, t1, z1), [(u0 / tile, 0), (u1 / tile, 0), (u1 / tile, d), (u0 / tile, d)], (0, 0, 1))
def floor_quad(mat, x0, y0, x1, y1, z, tile, rot=False):
    uv = [(x0 / tile, y0 / tile), (x1 / tile, y0 / tile), (x1 / tile, y1 / tile), (x0 / tile, y1 / tile)]
    tquad(mat, (x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z), uv, (0, 0, 1))
def poly_cap(mat, poly, z, tile, up=True):
    """Convex polygon fan (up or down) with world-anchored UVs."""
    cx = sum(p[0] for p in poly) / len(poly); cy = sum(p[1] for p in poly) / len(poly)
    for k in range(len(poly)):
        a = poly[k]; b = poly[(k + 1) % len(poly)]
        mb(mat).tri((cx, cy, z), (a[0], a[1], z), (b[0], b[1], z), (cx / tile, cy / tile), (a[0] / tile, a[1] / tile), (b[0] / tile, b[1] / tile), (0, 0, 1 if up else -1))
def glaze_uv(variant, bay, nb=3):
    """UV rectangle (u0,v0,u1,v1) of the glazed part of one bay of an atlas tile (spandrel excluded)."""
    u0, v0, u1, v1 = GA["tiles"][str(variant)]; bw = (u1 - u0) / nb; fh = (v1 - v0); sp = GA["span"] / GA["floor_h"]
    return (u0 + bw * bay + 0.002, v0 + fh * sp + 0.004, u0 + bw * (bay + 1) - 0.002, v1 - 0.01)

# ---------------------------------------------------------------- footprints (convex, counter-clockwise)
def rect_poly(cx, cy, w, d): return [(cx - w / 2, cy - d / 2), (cx + w / 2, cy - d / 2), (cx + w / 2, cy + d / 2), (cx - w / 2, cy + d / 2)]
def chamfer_poly(cx, cy, w, d, c):
    x0, x1, y0, y1 = cx - w / 2, cx + w / 2, cy - d / 2, cy + d / 2
    return [(x0 + c, y0), (x1 - c, y0), (x1, y0 + c), (x1, y1 - c), (x1 - c, y1), (x0 + c, y1), (x0, y1 - c), (x0, y0 + c)]
def ellipse_poly(cx, cy, rx, ry, n=20, rot=0.0):
    return [(cx + rx * math.cos(rot + 2 * math.pi * k / n) * 1.0, cy + ry * math.sin(rot + 2 * math.pi * k / n)) for k in range(n)]
def inset_poly(poly, d):
    """Offset a convex CCW polygon inward by d (positive = shrink)."""
    out = []; n = len(poly)
    for k in range(n):
        p0 = Vector(poly[k - 1]); p1 = Vector(poly[k]); p2 = Vector(poly[(k + 1) % n])
        e0 = (p1 - p0).normalized(); e1 = (p2 - p1).normalized(); n0 = Vector((-e0.y, e0.x)); n1 = Vector((-e1.y, e1.x))
        bis = n0 + n1; k2 = max(0.2, bis.length ** 2 / 2); q = p1 + bis * (d / k2); out.append((q.x, q.y))
    return out
def edge_frames(poly, z0=0.0):
    """[(Frame, length)] per edge; frame origin p0, u along the edge, t = outward normal (n = (ry, -rx) for CCW)."""
    out = []
    for k in range(len(poly)):
        a = poly[k]; b = poly[(k + 1) % len(poly)]; dx, dy = b[0] - a[0], b[1] - a[1]; L = math.hypot(dx, dy)
        if L < 1e-3: continue
        r = (dx / L, dy / L); out.append((Frame(a, r, (r[1], -r[0]), z0), L))
    return out
def poly_area(poly): return abs(sum(poly[k][0] * poly[(k + 1) % len(poly)][1] - poly[(k + 1) % len(poly)][0] * poly[k][1] for k in range(len(poly)))) / 2
def poly_center(poly): return (sum(p[0] for p in poly) / len(poly), sum(p[1] for p in poly) / len(poly))
def clear_blender(): bpy.ops.wm.read_factory_settings(use_empty=True)

def realise(names, extra_mats=None):
    """Turn the MB buckets into Blender objects (one object per bucket, material = bucket's last path part)."""
    for key, b in MBS.items():
        if not b.f: continue
        g, _, m = key.rpartition("::")
        me = bpy.data.meshes.new(key); me.from_pydata(b.v, [], b.f); me.update()
        me.uv_layers.new(name="UVMap").data.foreach_set("uv", [c for tri in b.uv for uv in tri for c in uv])
        ob = bpy.data.objects.new((f"{g}_" if g else "") + names.get(m, m), me); bpy.context.scene.collection.objects.link(ob); ob.data.materials.append(MATS[m])

def export_glb(path):
    import io_scene_gltf2.io.exp.meshopt as _m          # see 03-blender-gltf-lessons.md: Blender 5.2 meshopt POSITION precision
    _m.EXP_FILTER_BITS = 20; _m.ENCODE_EXP_SHARED_VECTOR = _m.ENCODE_EXP_SEPARATE
    for o in bpy.data.objects: o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_yup=True, export_apply=True, export_image_format="AUTO", export_texcoords=True,
        export_normals=True, export_cameras=False, export_lights=False, export_meshopt_compression_enable=True, use_selection=True)
    print("EXPORTED", path, os.path.getsize(path) // 1024, "KB")
