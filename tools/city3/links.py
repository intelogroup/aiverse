"""Bridges that join the district islands (world coordinates, Blender x east / y north).  blender -b --python links.py -> out/world-links.glb
Each 40 m water gap carries a 20 m road bridge with side walks, glass rails, steel arches with hangers and lamps."""
import bpy, math, os, sys, random
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from mkit import *
import mdetails as D
clear_blender(); Z = 0.2
pbr_mat("road", "road_m"); pbr_mat("sidewalk", "plaza_herring"); pbr_mat("panel", "panel_conc"); palette_mat("palette"); palette_mat("led", emit=3.0); glass_mat("shopglass")
rng = random.Random(5)
def beam(p0, p1, w, h, color):
    """Oriented box between two 3D points (cross-section w x h, h roughly vertical)."""
    d = Vector(p1) - Vector(p0); d.normalize(); side = d.cross(Vector((0, 0, 1)))
    if side.length < 1e-4: side = Vector((1, 0, 0))
    side.normalize(); up = side.cross(d); up.normalize()
    c = [[Vector(p) + side * sx * w / 2 + up * sy * h / 2 for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))] for p in (p0, p1)]
    ctr = (Vector(p0) + Vector(p1)) / 2
    for a, b in ((0, 1), (1, 2), (2, 3), (3, 0)):
        q = [c[0][a], c[1][a], c[1][b], c[0][b]]; m = sum(q, Vector()) / 4 - ctr; pquad("palette", *[tuple(v) for v in q], color, tuple(m))
def bridge(axis, c, a0, a1, w=20.0):
    """axis 'y': runs along y at x=c from a0 to a1; axis 'x': along x at y=c."""
    L = a1 - a0
    def P(u, v, z): return (c + v, a0 + u, z) if axis == "y" else (a0 + u, c + v, z)
    # frame: u along the span, v across (centred)
    fr = Frame(P(0, -w / 2, 0)[:2], (0, 1) if axis == "y" else (1, 0), (-1, 0) if axis == "y" else (0, 1), 0)   # t toward -v (left side), only used for orientation
    def quad(mat, pts, uvs, out): tquad(mat, *pts, uvs, out)
    # deck road (14 m) + walks (3 m each side)
    for (v0, v1, mat, tile) in ((-7, 7, "road", 2.1), (-10, -7, "sidewalk", 1.8), (7, 10, "sidewalk", 1.8)):
        quad(mat, [P(0, v0, Z), P(L, v0, Z), P(L, v1, Z), P(0, v1, Z)], [(P(0, v0, 0)[0] / tile, P(0, v0, 0)[1] / tile), (P(L, v0, 0)[0] / tile, P(L, v0, 0)[1] / tile), (P(L, v1, 0)[0] / tile, P(L, v1, 0)[1] / tile), (P(0, v1, 0)[0] / tile, P(0, v1, 0)[1] / tile)], (0, 0, 1))
    # lane markings
    for k in range(int(L / 9)):
        u = 2 + k * 9; D.stripe(*sorted((P(u, -0.07, 0)[0], P(u + 4, 0.07, 0)[0])), *sorted((P(u, -0.07, 0)[1], P(u + 4, 0.07, 0)[1])), Z + 0.012, "paint_yellow") if False else None
    for s in (-1, 1):
        a = P(0, s * 6.8 - 0.075, Z + 0.012); b = P(L, s * 6.8 + 0.075, Z + 0.012)
        D.stripe(min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1]), Z + 0.012, "paint_white")
    a = P(0, -0.06, Z + 0.012); b = P(L, 0.06, Z + 0.012); D.stripe(min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1]), Z + 0.012, "paint_yellow")
    # structure: deep girders under the walks, soffit slab, abutment pads
    for (v0, v1) in ((-10.4, -9.6), (9.6, 10.4), (-0.4, 0.4)):
        a = P(0, v0, 0); b = P(L, v1, 0); x0, x1 = sorted((a[0], b[0])); y0, y1 = sorted((a[1], b[1])); pbox(x0, y0, x1, y1, Z - 1.8, Z - 0.02, "concrete_dk")
    a = P(0, -10.4, 0); b = P(L, 10.4, 0); x0, x1 = sorted((a[0], b[0])); y0, y1 = sorted((a[1], b[1])); pbox(x0, y0, x1, y1, Z - 0.7, Z - 0.02, "concrete")
    # rails: glass panels between steel posts, handrail
    for s in (-1, 1):
        v = s * 10.1
        for k in range(int(L / 2) + 1):
            u = k * 2.0; x, y = P(u, v, 0)[:2]; cyl(x, y, Z, Z + 1.15, 0.045, 6, "alu_dk", top=True)
        a = P(0, v, 0); b = P(L, v, 0)
        for k in range(int(L / 2)):
            p0 = P(k * 2 + 0.06, v, Z + 0.1); p1 = P(k * 2 + 1.94, v, Z + 0.1)
            for sg in (1, -1): mb("shopglass").quad(p0, p1, (p1[0], p1[1], Z + 1.05), (p0[0], p0[1], Z + 1.05), (0, 0), (1, 0), (1, 1), (0, 1), (sg if axis == "x" else 0, 0 if axis == "x" else sg, 0) if True else None)
        h0 = P(0, v, 0); h1 = P(L, v, 0); pbox(min(h0[0], h1[0]) - 0.04, min(h0[1], h1[1]) - 0.04, max(h0[0], h1[0]) + 0.04, max(h0[1], h1[1]) + 0.04, Z + 1.12, Z + 1.18, "alu")
    # steel arches (one per side, outside the walk) rising 13 m at midspan, hangers every 4 m
    def arch_pt(u): t = u / L; return 4 * 13.0 * t * (1 - t)
    for s in (-1, 1):
        v = s * 11.0; prev = None
        for k in range(0, 25):
            u = L * k / 24; z = Z + 0.9 + arch_pt(u); x, y = P(u, v, 0)[:2]
            if prev: beam(prev, (x, y, z), 0.7, 0.9, "orange")
            prev = (x, y, z)
        for k in range(1, 10):
            u = L * k / 10; x, y = P(u, v, 0)[:2]; cyl(x, y, Z + 0.1, Z + 0.9 + arch_pt(u), 0.04, 5, "alu", top=False)
    for k in range(5):                                                       # lamps along both walks
        u = 4 + k * (L - 8) / 4
        for s in (-1, 1):
            x, y = P(u, s * 9.2, 0)[:2]; D.lamp(x, y, Z, ((-s, 0) if axis == "y" else (0, -s)))
def main():
    which = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else ["N", "E", "W", "S"]
    for k in which: {"N": lambda: bridge("y", 0, 180, 220), "E": lambda: bridge("x", 0, 180, 220), "W": lambda: bridge("x", 0, -220, -180), "S": lambda: bridge("y", 0, -220, -180)}[k]()
    realise({"road": "Road", "sidewalk": "Sidewalk", "palette": "Props", "led": "Led", "shopglass": "ShopGlass"})
    print("TRIS", sum(len(b.f) for b in MBS.values())); bpy.ops.wm.save_as_mainfile(filepath=f"{HERE}/out/links.blend"); export_glb(f"{HERE}/out/world-links.glb")
main()
