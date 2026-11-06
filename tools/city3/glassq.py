"""Glass Quarter — modern CBD district (north of the Bazaar). 360 x 360 m island, local origin = district centre.
Run: blender -b --python glassq.py      (after mtex.py)  ->  out/world-glassq.glb, out/glassq-plan.json
Layout: 4 x 4 blocks; 30 m boulevard cross at the centre (x = 0 / y = 0, mates the Bazaar bridge), 16 m streets at +-118 m.
Coordinates: x east, y north (Blender); glTF export maps to three.js (x, z = -y)."""
import bpy, json, math, os, random, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from mkit import *
import mdetails as D, kit
for _n in [n for n in dir(D) if callable(getattr(D,n)) and not n.startswith('_') and n not in ('Frame','MB','Vector')]: setattr(D,_n,kit.prof(_n,getattr(D,_n)))
clear_blender()
Z = 0.2; FH = 4.0; GROUND = 5.5; LAND = 180.0; SW = 3.5
rng = random.Random(1818); T = {k: v["size"] for k, v in PB.items()}
# ---------------------------------------------------------------- materials
for k, tag in (("sidewalk", "plaza_herring"), ("road", "road_m"), ("cladding", "cladding_dk"), ("ribbed", None), ("panel", "panel_conc"), ("tiledk", "tile_dk"),
               ("pave", "pave_sq"), ("bitumen", None), ("terrazzo", None), ("stone", "stone_clad"), ("roofgrey", "roof_grey")):
    pbr_mat(k, tag or k if tag else {"ribbed": "ribbed", "bitumen": "bitumen", "terrazzo": "terrazzo"}[k])
img_mat("glass", "glass_atlas.jpg", "glass_emit.jpg", rough=0.08, metal=0.55, emit=1.0)
img_mat("msign", "msigns.jpg", "msigns.jpg", rough=0.4, emit=0.5)
palette_mat("palette"); palette_mat("led", emit=3.0); palette_mat("water", rough=0.03); palette_mat("metal", rough=0.3, metal=0.9); glass_mat("shopglass")
TILE = {"sidewalk": 1.8, "road": 2.1, "cladding": 2.09, "ribbed": 2.0, "panel": 2.0, "tiledk": 2.0, "pave": 1.8, "bitumen": 6.0, "terrazzo": 2.0, "stone": 2.0, "roofgrey": 4.0}
# ---------------------------------------------------------------- plan
LINES = [(-118, 16), (0, 30), (118, 16)]
edges = [-LAND]
for c, w in LINES: edges += [c - w / 2, c + w / 2]
edges.append(LAND)
BL = [(edges[i], edges[i + 1]) for i in range(0, len(edges), 2)]
KIND = {(1, 1): "cbd", (2, 1): "cbd", (1, 2): "cbd", (2, 2): "cbd", (1, 0): "mid", (2, 0): "mid", (1, 3): "mid", (2, 3): "mid", (0, 1): "res", (0, 2): "res",
        (3, 1): "campus", (3, 2): "campus", (0, 0): "park", (3, 0): "transit", (0, 3): "plaza", (3, 3): "park"}
PLAN = {"district": "glassq", "land": LAND, "blocks": [], "buildings": [], "streets": [{"c": c, "w": w} for c, w in LINES], "trees": [], "lamps": []}
# ---------------------------------------------------------------- ground
floor_quad("road", -LAND, -LAND, LAND, LAND, Z - 0.03, TILE["road"])
def strips(axis, c, w):
    """Lane markings for one street, broken at crossings with the other streets."""
    cuts = sorted((cc - ww / 2, cc + ww / 2) for cc, ww in LINES if cc != c or True)
    spans = []; a = -LAND
    for lo, hi in cuts:
        if lo > a: spans.append((a, lo))
        a = max(a, hi)
    if a < LAND: spans.append((a, LAND))
    zz = Z + 0.012
    def line(off, wd, color, dash=None):
        for a, b in spans:
            if dash:
                t = a + 1.0
                while t + dash[0] < b - 1.0:
                    (D.stripe(c + off - wd / 2, t, c + off + wd / 2, t + dash[0], zz, color) if axis == "x" else D.stripe(t, c + off - wd / 2, t + dash[0], c + off + wd / 2, zz, color)); t += dash[0] + dash[1]
            else:
                (D.stripe(c + off - wd / 2, a + 0.5, c + off + wd / 2, b - 0.5, zz, color) if axis == "x" else D.stripe(a + 0.5, c + off - wd / 2, b - 0.5, c + off + wd / 2, zz, color))
    if w >= 30:
        for s in (-1, 1): line(s * 5.75, 0.15, "paint_white", (3.0, 6.0)); line(s * 9.2, 0.18, "paint_white"); line(s * 10.3, 2.1, "teal")
        line(-2.2, 0.12, "paint_yellow"); line(2.2, 0.12, "paint_yellow")
    else:
        line(-0.12, 0.1, "paint_yellow"); line(0.12, 0.1, "paint_yellow")
        for s in (-1, 1): line(s * 6.3, 0.15, "paint_white")
for c, w in LINES: strips("x", c, w); strips("y", c, w)
for i, (x0, x1) in enumerate(BL):
    for j, (y0, y1) in enumerate(BL):
        floor_quad("sidewalk", x0, y0, x1, y1, Z, TILE["sidewalk"])
        for (a, b, c_, d_) in ((x0, y0, x1, y0 + 0.25), (x0, y1 - 0.25, x1, y1), (x0, y0, x0 + 0.25, y1), (x1 - 0.25, y0, x1, y1)): pquad("palette", (a, b, Z + 0.006), (c_, b, Z + 0.006), (c_, d_, Z + 0.006), (a, d_, Z + 0.006), "concrete_dk", (0, 0, 1))
        PLAN["blocks"].append({"i": i, "j": j, "kind": KIND[(i, j)], "rect": [x0, y0, x1, y1]})
# zebra crossings on the boulevard arms and the 16 m streets
for cx, wx in LINES:
    for cy, wy in LINES:
        for (ya, yb) in ((cy - wy / 2 - 4.0, cy - wy / 2 - 1.5), (cy + wy / 2 + 1.5, cy + wy / 2 + 4.0)): D.crossing(cx - wx / 2 + 0.8, ya, cx + wx / 2 - 0.8, yb, Z + 0.012, True)
        for (xa, xb) in ((cx - wx / 2 - 4.0, cx - wx / 2 - 1.5), (cx + wx / 2 + 1.5, cx + wx / 2 + 4.0)): D.crossing(xa, cy - wy / 2 + 0.8, xb, cy + wy / 2 - 0.8, Z + 0.012, False)
# quay walls (outer edge of the island) — concrete, open top; the runtime water plane sits at -1.2
for side, (a, b, o) in {"S": ((-LAND, -LAND), (LAND, -LAND), (0, -1)), "E": ((LAND, -LAND), (LAND, LAND), (1, 0)), "N": ((LAND, LAND), (-LAND, LAND), (0, 1)), "W": ((-LAND, LAND), (-LAND, -LAND), (-1, 0))}.items():
    pquad("palette", (a[0], a[1], -3), (b[0], b[1], -3), (b[0], b[1], Z), (a[0], a[1], Z), "concrete_dk", (o[0], o[1], 0))
# median planting on the boulevard cross
def median(axis):
    for s in range(-170, 171, 20):
        if abs(s) < 17: continue
        x, y = (0, s) if axis == "y" else (s, 0)
        if axis == "y": pbox(-2.0, s - 5, 2.0, s + 5, Z, Z + 0.25, "concrete"); pbox(-1.85, s - 4.85, 1.85, s + 4.85, Z + 0.25, Z + 0.27, "grass")
        else: pbox(s - 5, -2.0, s + 5, 2.0, Z, Z + 0.25, "concrete"); pbox(s - 4.85, -1.85, s + 4.85, 1.85, Z + 0.25, Z + 0.27, "grass")
        D.tree(x, y, Z + 0.27, rng, 6.0, "slim"); PLAN["trees"].append([x, y])
        for k in (-3, 3): D.shrub(x + (0 if axis == "y" else k), y + (k if axis == "y" else 0), Z + 0.27, rng, 0.5)
median("x"); median("y")

# ---------------------------------------------------------------- facade systems
def curtain(fr, L, nfl, r, z0=0.0, fins=True, deep=False):
    ng = max(1, round(L / 4.5)); gw = L / ng; H = nfl * FH
    for f in range(nfl):
        z = z0 + f * FH
        for g in range(ng):
            u0, v0, u1, v1 = GA["tiles"][str(r.randrange(8))]; u0 += .002; v0 += .002; u1 -= .002; v1 -= .002
            P = fr.p; tquad("glass", P(g * gw, -0.10, z), P((g + 1) * gw, -0.10, z), P((g + 1) * gw, -0.10, z + FH), P(g * gw, -0.10, z + FH), [(u0, v0), (u1, v0), (u1, v1), (u0, v1)], fr.o(0, 1))
        if deep: wbox(fr, 0, L, -0.05, 0.55, z - 0.05, z + 0.95, "panel", TILE["panel"])
        else: fbox(fr, 0, L, -0.10, 0.12, z - 0.05, z + 0.30, "alu")
    if fins:
        for g in range(ng): fbox(fr, g * gw - 0.05, g * gw + 0.05, -0.1, 0.30, z0, z0 + H, "alu_dk")
    fbox(fr, 0, L, -0.10, 0.12, z0 + H - 0.1, z0 + H + 0.25, "alu")
def punched(fr, L, nfl, r, z0=0.0, mat="cladding", pitch=3.0, ww=1.9):
    nb = max(1, round(L / pitch)); bw = L / nb; tl = TILE[mat]
    for f in range(nfl):
        z = z0 + f * FH; sill, head = 0.85, 3.15
        for b in range(nb):
            u0, u1 = b * bw, (b + 1) * bw; c = (u0 + u1) / 2; w = min(ww, bw - 0.7); a, d = c - w / 2, c + w / 2
            wall(fr, u0, a, z, z + FH, mat, tl); wall(fr, d, u1, z, z + FH, mat, tl); wall(fr, a, d, z, z + sill, mat, tl); wall(fr, a, d, z + head, z + FH, mat, tl)
            reveal(fr, a, d, z + sill, z + head, 0.0, -0.3, "panel", TILE["panel"])
            gu = glaze_uv(r.randrange(8), r.randrange(3)); tquad("glass", fr.p(a, -0.3, z + sill), fr.p(d, -0.3, z + sill), fr.p(d, -0.3, z + head), fr.p(a, -0.3, z + head), [(gu[0], gu[1]), (gu[2], gu[1]), (gu[2], gu[3]), (gu[0], gu[3])], fr.o(0, 1))
            fbox(fr, a - 0.06, d + 0.06, 0, 0.2, z + sill - 0.08, z + sill, "alu"); fbox(fr, c - 0.025, c + 0.025, -0.28, -0.24, z + sill, z + head, "alu_dk")
        fbox(fr, 0, L, 0, 0.06, z + FH - 0.12, z + FH, "concrete")
def sign(fr, u0, u1, z0, z1, k, t=0.28):
    a, b, c, d = MS[str(k % 8)]; P = fr.p
    tquad("msign", P(u0, t, z0), P(u1, t, z0), P(u1, t, z1), P(u0, t, z1), [(a, b), (c, b), (c, d), (a, d)], fr.o(0, 1))
def revolving(fr, u, h):
    cu, ct = u, 0.9; r = 1.25
    for sgn in (-1, 1):
        for k in range(5):
            a0 = math.radians(95 + k * 34) * (1 if sgn > 0 else 1); a1 = math.radians(95 + (k + 1) * 34)
            if sgn < 0: a0 += math.pi; a1 += math.pi
            pa = fr.p(cu + r * math.cos(a0), ct + r * math.sin(a0), 0.05); pb = fr.p(cu + r * math.cos(a1), ct + r * math.sin(a1), 0.05)
            pc = fr.p(cu + r * math.cos(a1), ct + r * math.sin(a1), 2.5); pd = fr.p(cu + r * math.cos(a0), ct + r * math.sin(a0), 2.5); am = (a0 + a1) / 2
            mb("shopglass").quad(pa, pb, pc, pd, (0, 0), (1, 0), (1, 1), (0, 1), fr.o(math.cos(am), math.sin(am)))
    x, y = fr.xy(cu, ct); cyl(x, y, Z + 0.05 + fr.z0 - Z, fr.z0 + 2.55, 0.05, 8, "alu")
    for ang in (0.3, 0.3 + math.pi / 2, 0.3 + math.pi, 0.3 + 1.5 * math.pi):
        ex, ey = x + 1.2 * math.cos(ang), y + 1.2 * math.sin(ang)
        for s in (0, 1): pquad("shopglass", (x, y, fr.z0 + 0.1), (ex, ey, fr.z0 + 0.1), (ex, ey, fr.z0 + 2.4), (x, y, fr.z0 + 2.4), "white", (math.sin(ang) * (1 if s else -1), -math.cos(ang) * (1 if s else -1), 0))
    cyl(x, y, fr.z0 + 2.5, fr.z0 + 2.62, 1.3, 14, "alu_dk")
def canopy(fr, u, w=4.8, d=3.2, z=3.6):
    wbox(fr, u - w / 2, u + w / 2, 0, d, z, z + 0.28, "panel", TILE["panel"])
    for s in (-1, 1): x, y = fr.xy(u + s * (w / 2 - 0.2), d - 0.25); cyl(x, y, fr.z0, fr.z0 + z, 0.07, 8, "alu_dk")
    P = fr.p; pquad("led", P(u - w / 2 + 0.3, 0.3, z - 0.003), P(u + w / 2 - 0.3, 0.3, z - 0.003), P(u + w / 2 - 0.3, d - 0.3, z - 0.003), P(u - w / 2 + 0.3, d - 0.3, z - 0.003), "warm_led", (0, 0, -1))
def storefront(fr, L, h, r, doors=None, depth=4.5, seed=0):
    nb = max(1, round(L / 3.0)); bw = L / nb; hh = h - 1.3
    if doors is None: doors = {nb // 2} if nb > 3 else set()
    P = fr.p; back = r.choice(["cream", "white", "teal", "navy", "wood", "sand"])
    pquad("palette", P(0, -depth, 0.02), P(L, -depth, 0.02), P(L, 0, 0.02), P(0, 0, 0.02), "concrete_dk", (0, 0, 1))
    pquad("palette", P(0, 0, hh), P(L, 0, hh), P(L, -depth, hh), P(0, -depth, hh), "white", (0, 0, -1))
    pquad("palette", P(0, -depth, 0), P(L, -depth, 0), P(L, -depth, hh), P(0, -depth, hh), back, fr.o(0, 1))
    pquad("palette", P(0, 0, 0), P(0, -depth, 0), P(0, -depth, hh), P(0, 0, hh), "white", fr.o(1, 0)); pquad("palette", P(L, -depth, 0), P(L, 0, 0), P(L, 0, hh), P(L, -depth, hh), "white", fr.o(-1, 0))
    for k in range(int(L // 6)): fbox(fr, 1 + k * 6, 1 + k * 6 + 3.0, -depth + 0.4, -depth + 1.0, 0.02, 1.1, r.choice(["wood", "alu", "white"])); fbox(fr, 1.2 + k * 6, 1.2 + k * 6 + 0.6, -depth + 0.1, -depth + 0.2, 0.9, 2.4, "wood_dk")
    for k in range(int(L // 3)): P0 = P(1.0 + k * 3.0, -1.2, hh - 0.05); fbox(fr, 1.0 + k * 3.0 - 0.6, 1.0 + k * 3.0 + 0.6, -1.4, -1.0, hh - 0.08, hh - 0.02, "cool_led", b="led")
    for b in range(nb):
        u0, u1 = b * bw, (b + 1) * bw
        fbox(fr, u0 - 0.05, u0 + 0.05, -0.05, 0.14, 0, hh, "alu_dk")
        if b in doors:
            revolving(fr, (u0 + u1) / 2, h); canopy(fr, (u0 + u1) / 2)
            for sg in (-1, 1): fbox(fr, (u0 + u1) / 2 + sg * 1.6 - 0.04, (u0 + u1) / 2 + sg * 1.6 + 0.04, -0.05, 0.12, 0, 2.7, "alu_dk")
            mb("shopglass").quad(P(u0, 0, 2.7), P(u1, 0, 2.7), P(u1, 0, hh), P(u0, 0, hh), (0, 0), (1, 0), (1, 1), (0, 1), fr.o(0, 1)); fbox(fr, u0, u1, -0.05, 0.1, 2.7, 2.78, "alu_dk")
        else:
            mb("shopglass").quad(P(u0, 0, 0.15), P(u1, 0, 0.15), P(u1, 0, hh), P(u0, 0, hh), (0, 0), (1, 0), (1, 1), (0, 1), fr.o(0, 1))
            fbox(fr, u0, u1, -0.05, 0.1, 2.6, 2.68, "alu_dk"); fbox(fr, u0, u1, 0, 0.18, 0, 0.15, "alu_dk")
    fbox(fr, L - 0.05, L + 0.05, -0.05, 0.14, 0, hh, "alu_dk")
    wbox(fr, 0, L, -0.05, 0.3, hh, h, "cladding", TILE["cladding"])
    for k in range(int(L // 5)): sign(fr, 1.0 + k * 5.0, 1.0 + k * 5.0 + 3.6, hh + 0.1, hh + 1.0, r.randrange(8), 0.33)
def roof(poly, z, r, tall=False, equip=3):
    poly_cap("bitumen", poly, z, TILE["bitumen"])
    for fr, L in edge_frames(poly, z): wbox(fr, 0, L, -0.3, 0.0, 0.0, 1.1, "panel", TILE["panel"], top=True); fbox(fr, 0, L, -0.3, 0.05, 1.1, 1.18, "alu")
    ip = inset_poly(poly, 3.0); cx, cy = poly_center(poly); xs = [p[0] for p in ip]; ys = [p[1] for p in ip]
    for _ in range(equip + 2):
        for _t in range(10):
            ex = r.uniform(min(xs), max(xs)); ey = r.uniform(min(ys), max(ys)); w = r.uniform(2.5, 5.0); d = r.uniform(1.6, 3.0)
            corners = [(ex - w / 2, ey - d / 2), (ex + w / 2, ey - d / 2), (ex + w / 2, ey + d / 2), (ex - w / 2, ey + d / 2)]
            if all(point_in(ip, c) for c in corners): break
        else: continue
        k = r.random()
        if k < 0.45: pbox(ex - w / 2, ey - d / 2, ex + w / 2, ey + d / 2, z, z + r.uniform(1.4, 2.4), r.choice(["alu", "white", "concrete"])); cyl(ex - w / 4, ey, z + 2.4, z + 2.45, 0.6, 10, "black", top=True)
        elif k < 0.75: cyl(ex, ey, z, z + 3.2, 1.2, 12, "alu"); cyl(ex, ey, z + 3.2, z + 3.4, 1.25, 12, "alu_dk")
        else:
            pbox(ex - w / 2, ey - d / 2, ex + w / 2, ey + d / 2, z, z + 3.0, "concrete")
            for s in range(5): pbox(ex - w / 2 - 0.02, ey - d / 2 + 0.3 + s * (d - 0.6) / 4, ex + w / 2 + 0.02, ey - d / 2 + 0.38 + s * (d - 0.6) / 4, z + 0.5, z + 2.6, "steel")
    if tall:
        cyl(cx, cy, z, z + 22.0, 0.22, 8, "alu", r1=0.06); cyl(cx, cy, z + 21.8, z + 22.4, 0.14, 8, "red", b="led")
        for k in range(4): a = k * math.pi / 2 + 0.78; pbox(cx + math.cos(a) * 4 - 0.15, cy + math.sin(a) * 4 - 0.15, cx + math.cos(a) * 4 + 0.15, cy + math.sin(a) * 4 + 0.15, z, z + 7.5, "alu_dk")
def point_in(poly, p):
    return all((poly[(k + 1) % len(poly)][0] - poly[k][0]) * (p[1] - poly[k][1]) - (poly[(k + 1) % len(poly)][1] - poly[k][1]) * (p[0] - poly[k][0]) >= 0 for k in range(len(poly)))
def prism(poly, z0, z1, mat, tile):
    for fr, L in edge_frames(poly, z0): wall(fr, 0, L, 0, z1 - z0, mat, tile)
def balconies(poly, z0, nfl, r, every=1, depth=1.5):
    for f in range(0, nfl, every):
        z = z0 + f * FH
        for fr, L in edge_frames(poly, z):
            if L < 2.2: continue
            wbox(fr, 0.1, L - 0.1, 0.1, depth, 0.0, 0.2, "panel", TILE["panel"]); P = fr.p
            mb("shopglass").quad(P(0.1, depth, 0.2), P(L - 0.1, depth, 0.2), P(L - 0.1, depth, 1.25), P(0.1, depth, 1.25), (0, 0), (1, 0), (1, 1), (0, 1), fr.o(0, 1))
            fbox(fr, 0.1, L - 0.1, depth - 0.03, depth + 0.03, 1.22, 1.28, "alu")
def setback_deck(outer, inner, z, rail=True):
    for k in range(len(outer)):
        a, b = outer[k], outer[(k + 1) % len(outer)]; c, d = inner[(k + 1) % len(outer)], inner[k]
        tquad("pave", (a[0], a[1], z), (b[0], b[1], z), (c[0], c[1], z), (d[0], d[1], z), [(a[0] / 1.8, a[1] / 1.8), (b[0] / 1.8, b[1] / 1.8), (c[0] / 1.8, c[1] / 1.8), (d[0] / 1.8, d[1] / 1.8)], (0, 0, 1))
    if rail:
        for fr, L in edge_frames(outer, z):
            P = fr.p; mb("shopglass").quad(P(0.1, -0.1, 0.0), P(L - 0.1, -0.1, 0.0), P(L - 0.1, -0.1, 1.1), P(0.1, -0.1, 1.1), (0, 0), (1, 0), (1, 1), (0, 1), fr.o(0, 1)); fbox(fr, 0, L, -0.15, -0.05, 1.08, 1.14, "alu")
def tower(poly, z0, floors, style, r, tall=False, setbacks=True, bal=False):
    """Stacked prism with up to two setbacks; returns the top z. z0 is absolute (podium roof)."""
    segs = [(poly, floors)]
    if setbacks and floors >= 22:
        a = int(floors * 0.62); b = int(floors * 0.26); segs = [(poly, a), (inset_poly(poly, 3.2), b), (inset_poly(inset_poly(poly, 3.2), 3.0), floors - a - b)]
    z = z0
    for k, (pp, n) in enumerate(segs):
        for fr, L in edge_frames(pp, z):
            if style == "punched": punched(fr, L, n, r, 0.0, "cladding")
            else: curtain(fr, L, n, r, 0.0, fins=(style == "curtain"), deep=(style == "ribbon"))
        for v in pp: cyl(v[0], v[1], z, z + n * FH, 0.2, 6, "alu_dk")
        if bal: balconies(pp, z, n, r)
        z += n * FH
        if k + 1 < len(segs): setback_deck(pp, segs[k + 1][0], z); D.planter(*poly_center(pp), z, 0.01, 0.01, r) if False else None
        else: roof(pp, z, r, tall, 3 if not tall else 5)
    if len(segs) > 1:
        pass
    return z
def podium(rect, r, floors=2, style="ribbon", doors_every=True):
    x0, y0, x1, y1 = rect; top = Z + GROUND + floors * FH
    for side in ("S", "E", "N", "W"):
        fr, L = frame_for(rect, side, Z)
        storefront(fr, L, GROUND, r, None if doors_every else set(), seed=r.randrange(99))
        fr2 = Frame(fr.a, fr.r, fr.n, Z + GROUND)
        curtain(fr2, L, floors, r, 0.0, fins=False, deep=True) if style == "ribbon" else punched(fr2, L, floors, r, 0.0, "cladding")
    poly = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    tquad("pave", (x0, y0, top), (x1, y0, top), (x1, y1, top), (x0, y1, top), [(x0 / 1.8, y0 / 1.8), (x1 / 1.8, y0 / 1.8), (x1 / 1.8, y1 / 1.8), (x0 / 1.8, y1 / 1.8)], (0, 0, 1))
    for fr, L in edge_frames(poly, top):
        P = fr.p; mb("shopglass").quad(P(0.2, -0.3, 0.0), P(L - 0.2, -0.3, 0.0), P(L - 0.2, -0.3, 1.1), P(0.2, -0.3, 1.1), (0, 0), (1, 0), (1, 1), (0, 1), fr.o(0, 1)); fbox(fr, 0, L, -0.35, -0.25, 1.08, 1.14, "alu")
        wbox(fr, 0, L, -0.45, 0.0, -0.1, 0.35, "panel", TILE["panel"])
    return top

# ---------------------------------------------------------------- street dressing
def dress_block(rect, r, bus=False):
    x0, y0, x1, y1 = rect
    for side in ("S", "E", "N", "W"):
        fr, L = frame_for(rect, side, Z)
        out = fr.o(0, 1); face = (out[0], out[1])
        n = int(L // 20)
        for k in range(n):
            u = (k + 0.5) * L / n
            if 6 < u < L - 6:
                x, y = fr.xy(u, 1.0 + 0.0); y_off = 0
                D.tree_grate(x, y, Z + 0.02); D.tree(x, y, Z + 0.02, r, None, "round"); PLAN["trees"].append([x, y])
        for k in range(int(L // 24)):
            u = 8 + k * 24; x, y = fr.xy(u, 0.6) if False else fr.xy(u, 0.9); D.lamp(x, y, Z, face); PLAN["lamps"].append([x, y])
        for k in range(int(L // 14)):
            u = 5 + k * 14 + r.uniform(-1, 1); sel = r.random(); x, y = fr.xy(u, 1.5)
            if abs(face[0]) < 0.5: pass
            alongx = abs(fr.r[0]) > 0.5
            if sel < 0.35: D.bench(*fr.xy(u + 3.0, 2.6), Z, alongx)
            elif sel < 0.55: D.planter(*fr.xy(u + 3.0, 3.0), Z, 3.0 if alongx else 1.1, 1.1 if alongx else 3.0, r)
            elif sel < 0.7: D.bike_rack(*fr.xy(u + 3.0, 2.6), Z, alongx)
            elif sel < 0.85: D.bin_(*fr.xy(u + 3.0, 2.0), Z)
            else: D.kiosk(*fr.xy(u + 5.0, 2.6), Z, r, (-out[0], -out[1])) if r.random() < 0.15 else D.bin_(*fr.xy(u + 3.0, 2.2), Z)
        for k in range(0, int(L), 12):
            if r.random() < 0.9: D.bollard(*fr.xy(k + 1.0, 0.45), Z)
    if bus: D.bus_shelter(*frame_for(rect, "S", Z)[0].xy(20, 1.8), Z, (0, -1))

# ---------------------------------------------------------------- block builders
def block_rect(i, j):
    x0, x1 = BL[i]; y0, y1 = BL[j]; return (x0 + SW, y0 + SW, x1 - SW, y1 - SW)
def add_building(poly, floors, kind, style, bid):
    PLAN["buildings"].append({"id": bid, "poly": [[round(a, 2), round(b, 2)] for a, b in poly], "floors": floors, "kind": kind, "style": style})
def cbd(i, j, r):
    x0, y0, x1, y1 = block_rect(i, j); cx = (x0 + x1) / 2; cy = (y0 + y1) / 2; dirx = -1 if cx > 0 else 1; diry = -1 if cy > 0 else 1
    with grp(f"b{i}{j}"):
        pod = (x0 + 4.5, y0 + 4.5, x1 - 4.5, y1 - 4.5); top = podium(pod, r, 2, "ribbon"); add_building([(pod[0], pod[1]), (pod[2], pod[1]), (pod[2], pod[3]), (pod[0], pod[3])], 3, "podium", "ribbon", f"pod{i}{j}")
        near = (i in (1, 2) and j in (1, 2)); t1 = rng.choice([30, 34, 38, 42]) if (i, j) in ((2, 2), (1, 1)) else rng.choice([22, 26, 30])
        tx, ty = cx + dirx * 8, cy + diry * 8; poly = chamfer_poly(tx, ty, 44, 44, 9); z = tower(poly, top, t1, "curtain", r, tall=(t1 >= 34)); add_building(poly, t1 + 3, "tower", "curtain", f"tw{i}{j}")
        px, py = cx - dirx * 24, cy - diry * 24; poly2 = ellipse_poly(px, py, 13, 13, 20, rng.uniform(0, 1)); t2 = rng.choice([14, 18, 22]); tower(poly2, top, t2, "curtain" if rng.random() < 0.5 else "ribbon", r, setbacks=False); add_building(poly2, t2 + 3, "tower", "round", f"rt{i}{j}")
        for k in range(10): D.tree(rng.uniform(pod[0] + 4, pod[2] - 4), rng.uniform(pod[1] + 4, pod[3] - 4), top, r, 4.0) if not point_in(poly, (0, 0)) and False else None
        for _ in range(14):
            for _t in range(12):
                x = r.uniform(pod[0] + 3, pod[2] - 3); y = r.uniform(pod[1] + 3, pod[3] - 3)
                if not point_in(inset_poly(poly, -3), (x, y)) and not point_in(inset_poly(poly2, -3), (x, y)):
                    if r.random() < 0.55: D.planter(x, y, top, 3.2, 1.2, r);
                    else: D.tree(x, y, top, r, 4.2);
                    break
        dress_block((x0, y0, x1, y1), r, bus=(i, j) == (1, 1))
def mid(i, j, r):
    x0, y0, x1, y1 = block_rect(i, j); cx = (x0 + x1) / 2
    with grp(f"b{i}{j}"):
        for (ya, yb, face) in ((y0 + 5, y0 + 27, "S"), (y1 - 27, y1 - 5, "N")):
            rect = (x0 + 6, ya, x1 - 6, yb); fl = rng.choice([8, 9, 10, 11]); poly = [(rect[0], rect[1]), (rect[2], rect[1]), (rect[2], rect[3]), (rect[0], rect[3])]
            for side in ("S", "E", "N", "W"):
                fr, L = frame_for(rect, side, Z)
                if (side == "S" and face == "S") or (side == "N" and face == "N"): storefront(fr, L, GROUND, r)
                elif side in ("S", "N"): punched(fr, L, 1, r, 0.0, "cladding") if False else None; curtain(Frame(fr.a, fr.r, fr.n, Z), L, 1, r, 0.0, fins=False, deep=True)
                else: punched(fr, L, 1, r, 0.0, "cladding")
                fr2 = Frame(fr.a, fr.r, fr.n, Z + (GROUND if (side in ("S", "N") and ((side == face))) else FH))
                nflo = fl - (1 if (side in ("S", "N") and side == face) else 1)
                if side in ("S", "N"): curtain(fr2, L, fl - 1, r, 0.0, fins=(face == "N"), deep=(face == "S"))
                else: punched(fr2, L, fl - 1, r, 0.0, "cladding")
            roof(poly, Z + GROUND + (fl - 1) * FH, r, False, 4); add_building(poly, fl, "mid", "ribbon" if face == "S" else "curtain", f"mid{i}{j}{face}")
        # courtyard between the bars: pool, pave, trees, benches
        yy0, yy1 = y0 + 27, y1 - 27; floor_quad("pave", x0 + 6, yy0, x1 - 6, yy1, Z + 0.02, TILE["pave"])
        pw = (x1 - x0) * 0.45; D.planter(cx, (yy0 + yy1) / 2, Z + 0.02, pw, 6.0, r, 0.45); mb("water").quad((cx - pw / 2 + 0.3, (yy0 + yy1) / 2 - 2.7, Z + 0.5), (cx + pw / 2 - 0.3, (yy0 + yy1) / 2 - 2.7, Z + 0.5), (cx + pw / 2 - 0.3, (yy0 + yy1) / 2 + 2.7, Z + 0.5), (cx - pw / 2 + 0.3, (yy0 + yy1) / 2 + 2.7, Z + 0.5), (0, 0), (1, 0), (1, 1), (0, 1), (0, 0, 1))
        for k in range(8): D.tree(x0 + 12 + k * (x1 - x0 - 24) / 7, yy0 + 2.5 if k % 2 else yy1 - 2.5, Z + 0.02, r, 5.5); PLAN["trees"].append([x0 + 12 + k * (x1 - x0 - 24) / 7, yy0 + 2.5])
        for k in range(5): D.bench(x0 + 14 + k * (x1 - x0 - 28) / 4, (yy0 + yy1) / 2 + (5.0 if k % 2 else -5.0), Z + 0.02, True)
        dress_block((x0, y0, x1, y1), r)
def res(i, j, r):
    x0, y0, x1, y1 = block_rect(i, j); cx = (x0 + x1) / 2; cy = (y0 + y1) / 2
    with grp(f"b{i}{j}"):
        pod = (x0 + 4.5, y0 + 4.5, x1 - 4.5, y1 - 4.5); top = podium(pod, r, 1, "punched")
        for k, (dx, dy, rr, fl) in enumerate(((-12, -26, 11, 20), (14, 0, 12, 24), (-12, 27, 10, 16))):
            poly = ellipse_poly(cx + dx, cy + dy, rr, rr, 22, 0.2 * k); tower(poly, top, fl, "ribbon", r, setbacks=False, bal=True); add_building(poly, fl + 2, "tower", "balcony", f"res{i}{j}{k}")
        for _ in range(16):
            D.tree(r.uniform(pod[0] + 4, pod[2] - 4), r.uniform(pod[1] + 4, pod[3] - 4), top, r, 4.5)
        dress_block((x0, y0, x1, y1), r)
def campus(i, j, r):
    x0, y0, x1, y1 = block_rect(i, j); cx = (x0 + x1) / 2; cy = (y0 + y1) / 2
    with grp(f"b{i}{j}"):
        for (ya, yb, face) in ((y0 + 5, y0 + 22, "S"), (y1 - 22, y1 - 5, "N")):
            rect = (x0 + 6, ya, x1 - 6, yb); poly = [(rect[0], rect[1]), (rect[2], rect[1]), (rect[2], rect[3]), (rect[0], rect[3])]
            for side in ("S", "E", "N", "W"):
                fr, L = frame_for(rect, side, Z)
                if side == face: storefront(fr, L, GROUND, r); curtain(Frame(fr.a, fr.r, fr.n, Z + GROUND), L, 2, r, 0.0, fins=True)
                else: curtain(fr, L, 3, r, 0.0, fins=False, deep=True) if side in ("S", "N") else punched(fr, L, 3, r, 0.0, "cladding")
            top = Z + GROUND + 2 * FH if True else 0
            poly_cap("roofgrey", poly, top, 4.0) if False else None
            tquad("palette", (rect[0], rect[1], top), (rect[2], rect[1], top), (rect[2], rect[3], top), (rect[0], rect[3], top), [pal_uv("grass")] * 4, (0, 0, 1))
            for fr, L in edge_frames(poly, top): wbox(fr, 0, L, -0.4, 0.0, 0.0, 0.7, "panel", TILE["panel"])
            for _ in range(24): D.shrub(r.uniform(rect[0] + 2, rect[2] - 2), r.uniform(rect[1] + 2, rect[3] - 2), top, r, r.uniform(0.5, 0.9))
            add_building(poly, 4, "campus", "ribbon", f"cam{i}{j}{face}")
        ly0, ly1 = y0 + 22, y1 - 22; tquad("palette", (x0 + 6, ly0, Z + 0.03), (x1 - 6, ly0, Z + 0.03), (x1 - 6, ly1, Z + 0.03), (x0 + 6, ly1, Z + 0.03), [pal_uv("grass")] * 4, (0, 0, 1))
        pond = ellipse_poly(cx, (ly0 + ly1) / 2, (x1 - x0) * 0.22, (ly1 - ly0) * 0.28, 24); poly_cap("water", [(a, b) for a, b in pond], Z + 0.05, 4.0)
        for k in range(14): D.tree(r.uniform(x0 + 10, x1 - 10), r.uniform(ly0 + 2, ly1 - 2), Z + 0.03, r, r.uniform(5, 8)) if not point_in(pond, (0, 0)) else None
        stripe_path = [(x0 + 6, (ly0 + ly1) / 2 - 1.2, x1 - 6, (ly0 + ly1) / 2 + 1.2)]
        for a, b, c_, d_ in stripe_path: pquad("palette", (a, b, Z + 0.05), (c_, b, Z + 0.05), (c_, d_, Z + 0.05), (a, d_, Z + 0.05), "sand", (0, 0, 1))
        dress_block((x0, y0, x1, y1), r)
def park(i, j, r):
    x0, y0, x1, y1 = block_rect(i, j); cx = (x0 + x1) / 2; cy = (y0 + y1) / 2
    with grp(f"b{i}{j}"):
        tquad("palette", (x0, y0, Z + 0.04), (x1, y0, Z + 0.04), (x1, y1, Z + 0.04), (x0, y1, Z + 0.04), [pal_uv("grass")] * 4, (0, 0, 1))
        for (a, b, c_, d_) in ((x0, cy - 1.5, x1, cy + 1.5), (cx - 1.5, y0, cx + 1.5, y1)): tquad("pave", (a, b, Z + 0.06), (c_, b, Z + 0.06), (c_, d_, Z + 0.06), (a, d_, Z + 0.06), [(a / 1.8, b / 1.8), (c_ / 1.8, b / 1.8), (c_ / 1.8, d_ / 1.8), (a / 1.8, d_ / 1.8)], (0, 0, 1))
        pond = ellipse_poly(cx + 14, cy + 14, 11, 8, 24, 0.5); poly_cap("water", pond, Z + 0.08, 4.0)
        pts = []
        for _ in range(60):
            x = r.uniform(x0 + 4, x1 - 4); y = r.uniform(y0 + 4, y1 - 4)
            if abs(x - cx) < 3.5 or abs(y - cy) < 3.5 or point_in(inset_poly(pond, -3), (x, y)): continue
            if all(math.hypot(x - a, y - b) > 6 for a, b in pts): pts.append((x, y)); D.tree(x, y, Z + 0.04, r, r.uniform(5, 9), r.choice(["round", "round", "slim"])); PLAN["trees"].append([x, y])
        for k in range(6): D.bench(cx + (2.5 if k % 2 else -2.5), y0 + 12 + k * (y1 - y0 - 24) / 5, Z + 0.06, False)
        px, py = cx - 16, cy - 16; pbox(px - 5, py - 3.5, px + 5, py + 3.5, Z + 0.06, Z + 0.3, "concrete")
        for sx in (-1, 1):
            for sy in (-1, 1): cyl(px + sx * 4.4, py + sy * 3.0, Z + 0.3, Z + 3.6, 0.1, 8, "alu_dk")
        pbox(px - 5.6, py - 4.1, px + 5.6, py + 4.1, Z + 3.6, Z + 3.85, "concrete")
        dress_block((x0, y0, x1, y1), r)
def plaza(i, j, r):
    x0, y0, x1, y1 = block_rect(i, j); cx = (x0 + x1) / 2; cy = (y0 + y1) / 2
    with grp(f"b{i}{j}"):
        floor_quad("terrazzo", x0, y0, x1, y1, Z + 0.025, TILE["terrazzo"])
        pbox(cx - 22, cy - 9, cx + 22, cy + 9, Z, Z + 0.5, "concrete"); mb("water").quad((cx - 21.5, cy - 8.5, Z + 0.36), (cx + 21.5, cy - 8.5, Z + 0.36), (cx + 21.5, cy + 8.5, Z + 0.36), (cx - 21.5, cy + 8.5, Z + 0.36), (0, 0), (1, 0), (1, 1), (0, 1), (0, 0, 1))
        for k in range(7):
            a = k * 0.55 + 0.2; h = 7 + 1.4 * k; bx, by = cx - 10 + k * 3.3, cy; w = 0.35
            ca, sa = math.cos(a), math.sin(a); pts = [(bx + ca * 0.3 - sa * w, by + sa * 0.3 + ca * w), (bx - ca * 0.3 - sa * w, by - sa * 0.3 + ca * w), (bx - ca * 0.3 + sa * w, by - sa * 0.3 - ca * w), (bx + ca * 0.3 + sa * w, by + sa * 0.3 - ca * w)]
            for q in range(4):
                p0, p1 = pts[q], pts[(q + 1) % 4]; pquad("palette", (p0[0], p0[1], Z + 0.4), (p1[0], p1[1], Z + 0.4), (p1[0], p1[1], Z + 0.4 + h), (p0[0], p0[1], Z + 0.4 + h), "alu" if k % 2 else "orange", ((p0[0] + p1[0]) / 2 - bx, (p0[1] + p1[1]) / 2 - by, 0))
            pquad("palette", (pts[0][0], pts[0][1], Z + 0.4 + h), (pts[1][0], pts[1][1], Z + 0.4 + h), (pts[2][0], pts[2][1], Z + 0.4 + h), (pts[3][0], pts[3][1], Z + 0.4 + h), "alu", (0, 0, 1))
        for gx in range(-3, 4):
            for gy in (-1, 1):
                x, y = cx + gx * 11, cy + gy * 21
                if abs(y - cy) > 12: D.tree_grate(x, y, Z + 0.03); D.tree(x, y, Z + 0.03, r, 6.0); PLAN["trees"].append([x, y])
        for k in range(8): D.bench(cx - 28 + k * 8, cy + (11 if k % 2 else -11), Z + 0.03, True)
        px, py = cx + 30, cy - 24; pbox(px - 9, py - 5, px + 9, py + 5, Z + 0.03, Z + 4.2, "glass_dk"); pbox(px - 10.5, py - 6.5, px + 10.5, py + 6.5, Z + 4.2, Z + 4.5, "white")
        dress_block((x0, y0, x1, y1), r)
def transit(i, j, r):
    x0, y0, x1, y1 = block_rect(i, j); cx = (x0 + x1) / 2; cy = (y0 + y1) / 2
    with grp(f"b{i}{j}"):
        floor_quad("pave", x0, y0, x1, y1, Z + 0.025, TILE["pave"])
        for k in range(3):
            bx = x0 + 12 + k * 22; D.bus_shelter(bx, y0 + 6, Z + 0.03, (0, -1)); pbox(bx - 8, y0 + 2.5, bx + 8, y0 + 2.7, Z + 0.03, Z + 0.035, "paint_yellow")
        pbox(cx - 24, cy - 6, cx + 24, cy + 14, Z + 0.03, Z + 7.2, "glass_dk"); pbox(cx - 26, cy - 8, cx + 26, cy + 16, Z + 7.2, Z + 7.6, "white")
        for sx in range(-3, 4): cyl(cx + sx * 8, cy - 7.6, Z + 0.03, Z + 7.2, 0.18, 8, "alu_dk")
        for sx in range(-3, 4): D.bike_rack(cx + sx * 7, cy + 24, Z + 0.03, True)
        for _ in range(18): D.tree(r.uniform(x0 + 4, x1 - 4), r.uniform(cy + 28, y1 - 3), Z + 0.03, r, 5.5)
        dress_block((x0, y0, x1, y1), r)
BUILD = {"cbd": cbd, "mid": mid, "res": res, "campus": campus, "park": park, "plaza": plaza, "transit": transit}
if __name__ == "__main__" or True:
    only = [a for a in sys.argv[sys.argv.index("--") + 1:]] if "--" in sys.argv else []
    for (i, j), k in KIND.items():
        if only and f"{i}{j}" not in only and k not in only: continue
        BUILD[k](i, j, random.Random(100 + i * 10 + j))
    realise({"road": "Road", "sidewalk": "Sidewalk", "glass": "Glass", "shopglass": "ShopGlass", "palette": "Props", "led": "Led", "msign": "Signs"})
    print("TRIS", sum(len(b.f) for b in MBS.values()), "meshes", len(MBS), {k: len(v.f) for k, v in sorted(MBS.items(), key=lambda kv: -len(kv[1].f))[:8]})
    os.makedirs(f"{HERE}/out", exist_ok=True); bpy.ops.wm.save_as_mainfile(filepath=f"{HERE}/out/glassq.blend")
    export_glb(f"{HERE}/out/world-glassq.glb"); json.dump(PLAN, open(f"{HERE}/out/glassq-plan.json", "w"))
    agg = {}
    for k, v in MBS.items(): agg[k.rpartition("::")[2]] = agg.get(k.rpartition("::")[2], 0) + len(v.f)
    print("PROF", dict(sorted(kit.PROF.items(), key=lambda kv: -kv[1])[:12]))
    print("BY_MAT", dict(sorted(agg.items(), key=lambda kv: -kv[1])))
