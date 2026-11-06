"""Halo Lagoon — south district (three z=+400): golden-hour island of lathe-built glass towers, halo rings, diagrid domes,
a flared buttress spire, fountains, palms and a static elevated monorail loop.
Run: blender -b --python halo.py  -> out/world-halo.glb, out/halo-plan.json. Local origin = district centre (x east, y north;
the bridge from the Bazaar lands on the north edge, local y=+180)."""
import bpy, json, math, os, random, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from mkit import *
from mkit import _principled
import mdetails as D
clear_blender(); Z = 0.2; FH = 4.0; R_ISL = 176.0; TAU = 2 * math.pi
PB["halo_pave"] = {"rough": PB["plaza_herring"]["rough"]}; PB["halo_terrazzo"] = {"rough": PB["terrazzo"]["rough"]}   # halo_tex.py tints
for k, tag in (("road", "road_m"), ("sidewalk", "halo_pave"), ("terrazzo", "halo_terrazzo"), ("stone", "plaza_stone")): pbr_mat(k, tag)
img_mat("glass", "halo_glass.jpg", "glass_emit.jpg", rough=0.06, metal=0.45, emit=1.0)
palette_mat("palette"); palette_mat("led", emit=3.0); palette_mat("water", rough=0.03); glass_mat("shopglass")
glass_mat("jet", alpha=0.42, tint=(0.92, 0.97, 1.0, 1.0)); glass_mat("shallow", alpha=0.32, tint=(0.35, 0.88, 0.82, 1.0))
def solid_mat(key, rgb, rough, metal):
    m, nt, b = _principled(key); b.inputs["Base Color"].default_value = (*rgb, 1.0); b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = metal
    MATS[key] = m; return m
solid_mat("gold", (0.93, 0.64, 0.3), 0.3, 1.0); solid_mat("chrome", (0.86, 0.88, 0.9), 0.22, 1.0)
solid_mat("domeglass", (0.12, 0.42, 0.64), 0.06, 0.55); solid_mat("marble", (0.93, 0.9, 0.85), 0.45, 0.0)
TL = {"road": 2.1, "sidewalk": 2.0, "terrazzo": 2.0, "stone": 2.4}
PLAN = {"district": "halo", "land": R_ISL, "shape": "superellipse4", "buildings": [], "trees": [], "lamps": [], "monorail": [], "plazas": []}
OCC = []                                                               # (cx, cy, r) keep-out circles for scatter

# ---------------------------------------------------------------- primitives
def lathe(cx, cy, prof, seg, b="palette", color="white", tile=None):
    """Surface of revolution. prof = [(r, z), ...] bottom->top; outward normal from the profile tangent (handles overhangs)."""
    for i in range(len(prof) - 1):
        (r0, z0), (r1, z1) = prof[i], prof[i + 1]; nr, nz = z1 - z0, -(r1 - r0)
        if abs(nr) + abs(nz) < 1e-6: continue
        rm = (r0 + r1) / 2
        for k in range(seg):
            t0, t1 = TAU * k / seg, TAU * (k + 1) / seg; tm = (t0 + t1) / 2
            P = lambda r, t, z: (cx + r * math.cos(t), cy + r * math.sin(t), z)
            pts = (P(r0, t0, z0), P(r0, t1, z0), P(r1, t1, z1), P(r1, t0, z1)); out = (math.cos(tm) * nr, math.sin(tm) * nr, nz)
            if tile: tquad(b, *pts, [(rm * t0 / tile, z0 / tile), (rm * t1 / tile, z0 / tile), (rm * t1 / tile, z1 / tile), (rm * t0 / tile, z1 / tile)], out)
            else: pquad(b, *pts, color, out)
def flat_ring(b, cx, cy, r0, r1, z, seg, tile=None, color="white", down=False):
    for k in range(seg):
        t0, t1 = TAU * k / seg, TAU * (k + 1) / seg
        pts = [(cx + r * math.cos(t), cy + r * math.sin(t), z) for r, t in ((r0, t0), (r0, t1), (r1, t1), (r1, t0))]
        out = (0, 0, -1 if down else 1)
        if tile: tquad(b, *pts, [(p[0] / tile, p[1] / tile) for p in pts], out)
        else: pquad(b, *pts, color, out)
def torus(cx, cy, z, R, r, b="gold", color="white", segR=72, segr=6):
    for i in range(segR):
        for j in range(segr):
            def P(ii, jj):
                t = TAU * ii / segR; f = TAU * jj / segr; c = (cx + R * math.cos(t), cy + R * math.sin(t), z)
                return (c[0] + r * math.cos(f) * math.cos(t), c[1] + r * math.cos(f) * math.sin(t), c[2] + r * math.sin(f))
            tm = TAU * (i + 0.5) / segR; fm = TAU * (j + 0.5) / segr
            pquad(b, P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1), color, (math.cos(fm) * math.cos(tm), math.cos(fm) * math.sin(tm), math.sin(fm)))
def chain(pts, w, h, color, b="palette"):
    for a, c in zip(pts, pts[1:]): beam(a, c, w, h, color, b)
def glass_shell(cx, cy, rfun, z0, nfl, rng, slab=None, bay=1.6):
    """Faceted curtain wall of revolution; each facet x floor = one bay of a glass-atlas tile (lit tiles glow at night)."""
    rmax = max(rfun(z0 + f * FH) for f in range(nfl + 1)); seg = max(12, int(round(TAU * rmax / bay / 3)) * 3)
    for f in range(nfl):
        za, zb = z0 + f * FH, z0 + (f + 1) * FH; ra, rb = rfun(za), rfun(zb); nr, nz = zb - za, -(rb - ra)
        for k in range(seg):
            if k % 3 == 0: v = rng.randrange(8)
            u0, v0, u1, v1 = GA["tiles"][str(v)]; bw = (u1 - u0) / 3; bb = k % 3
            t0, t1 = TAU * k / seg, TAU * (k + 1) / seg; tm = (t0 + t1) / 2
            P = lambda r, t, z: (cx + r * math.cos(t), cy + r * math.sin(t), z)
            tquad("glass", P(ra, t0, za), P(ra, t1, za), P(rb, t1, zb), P(rb, t0, zb), [(u0 + bw * bb, v0), (u0 + bw * (bb + 1), v0), (u0 + bw * (bb + 1), v1), (u0 + bw * bb, v1)], (math.cos(tm) * nr, math.sin(tm) * nr, nz))
        if slab and f < nfl - 1: r = rfun(zb); lathe(cx, cy, [(r - 0.05, zb - 0.32), (r + slab, zb - 0.32), (r + slab, zb + 0.06), (r - 0.05, zb + 0.06)], seg, color="cream")
def glass_prism(poly, z0, nfl, rng, bay=1.6, slab=0.35):
    """Flat-faceted curtain wall around a convex CCW polygon."""
    for f in range(nfl):
        za = z0 + f * FH
        for fr, L in edge_frames(poly, za):
            nb = max(1, round(L / bay)); w = L / nb
            for k in range(nb):
                if k % 3 == 0: v = rng.randrange(8)
                u0, v0, u1, v1 = GA["tiles"][str(v)]; bw = (u1 - u0) / 3; bb = k % 3; P = fr.p
                tquad("glass", P(k * w, 0, 0), P((k + 1) * w, 0, 0), P((k + 1) * w, 0, FH), P(k * w, 0, FH), [(u0 + bw * bb, v0), (u0 + bw * (bb + 1), v0), (u0 + bw * (bb + 1), v1), (u0 + bw * bb, v1)], fr.o(0, 1))
            if f % 2 == 1: fbox(fr, -0.1, L + 0.1, 0, slab, FH - 0.3, FH + 0.05, "cream")
def cap(poly, z, color="concrete"):
    cx, cy = poly_center(poly)
    for k in range(len(poly)): a = poly[k]; b = poly[(k + 1) % len(poly)]; ptri("palette", (cx, cy, z), (a[0], a[1], z), (b[0], b[1], z), color, (0, 0, 1))
def dome(cx, cy, zb, R, H, ribs=16, rings=3, oculus=True, rib_b="gold"):
    prof = [(R * math.cos(math.pi / 2 * i / 10), zb + H * math.sin(math.pi / 2 * i / 10)) for i in range(11)]
    lathe(cx, cy, prof, 48, "domeglass")
    off = lambda r, z, d: (r + d * math.cos(math.atan2(z - zb, r) if False else 0), z)
    for k in range(ribs):                                                 # meridian ribs 6 cm proud of the glass, along the normal
        t = TAU * k / ribs; pts = []
        for i in range(11):
            a = math.pi / 2 * i / 10; n = (H * math.cos(a), R * math.sin(a)); L = math.hypot(*n); r = R * math.cos(a) + 0.18 * n[0] / L; z = zb + H * math.sin(a) + 0.18 * n[1] / L
            pts.append((cx + r * math.cos(t), cy + r * math.sin(t), z))
        chain(pts[:-1], 0.28, 0.22, "white", rib_b)
    for q in range(1, rings + 1):
        a = math.pi / 2 * q / (rings + 1.3); n = (H * math.cos(a), R * math.sin(a)); L = math.hypot(*n)
        torus(cx, cy, zb + H * math.sin(a) + 0.15 * n[1] / L, R * math.cos(a) + 0.15 * n[0] / L, 0.13, rib_b, segR=64, segr=4)
    if oculus:
        ro = R * 0.12; lathe(cx, cy, [(ro + 0.4, zb + H * 0.985), (ro + 0.4, zb + H + 0.25), (0, zb + H + 0.3)], 24, color="white")
        lathe(cx, cy, [(ro, zb + H + 0.3), (ro * 0.6, zb + H + 0.75), (0, zb + H + 0.85)], 24, "led", color="cool_led")
def plinth(cx, cy, R, h=0.6, steps=2):
    prof = []
    for s in range(steps):
        r = R - s * 1.2; z0 = Z + s * h / steps; z1 = Z + (s + 1) * h / steps; prof += [(r, z0), (r, z1)]
        if s < steps - 1: prof.append((r - 1.2, z1))
    lathe(cx, cy, prof, 64, "marble"); flat_ring("terrazzo", cx, cy, 0, R - (steps - 1) * 1.2, Z + h, 64, TL["terrazzo"])
    for q in (0.55, 0.8): flat_ring("palette", cx, cy, (R - (steps - 1) * 1.2) * q, (R - (steps - 1) * 1.2) * q + 0.35, Z + h + 0.03, 64, color="terra")
    OCC.append((cx, cy, R + 2)); return Z + h
def planter_ring(cx, cy, r0, r1, z, rng, n):
    lathe(cx, cy, [(r1, z), (r1, z + 0.7), (r1 - 0.25, z + 0.7)], 64, color="cream"); flat_ring("palette", cx, cy, r0, r1 - 0.25, z + 0.55, 64, color="moss")
    for k in range(n):
        t = rng.uniform(0, TAU); r = rng.uniform(r0 + 0.5, r1 - 0.8)
        D.shrub(cx + r * math.cos(t), cy + r * math.sin(t), z + 0.55, rng, rng.uniform(0.45, 0.8), rng.choice(["leaf", "leaf_dk", "leaf_lt", "pink", "lilac", "moss"]))

def palm(x, y, z, rng, h=None):
    """Low-poly palm (~190 tris): leaning 4-sided trunk, 8 drooping fronds emitted on both faces."""
    h = h or rng.uniform(7, 11); a = rng.uniform(0, TAU); lean = rng.uniform(0.04, 0.12) * h
    T = lambda t: (x + math.cos(a) * lean * t * t, y + math.sin(a) * lean * t * t, z + h * t)
    pts = [T(i / 5) for i in range(6)]
    for i in range(5): beam(pts[i], pts[i + 1], 0.42 - 0.04 * i, 0.42 - 0.04 * i, "trunk" if i % 2 else "wood_dk")
    top = pts[-1]; L = rng.uniform(3.6, 4.6)
    for k in range(8):
        t = TAU * k / 8 + rng.uniform(-0.2, 0.2); dx, dy = math.cos(t), math.sin(t); px, py = -dy, dx; col = "leaf" if k % 2 else "leaf_dk"
        Q = lambda s: (top[0] + dx * L * s, top[1] + dy * L * s, top[2] + L * (0.42 * s - 0.95 * s * s))
        Wd = lambda s: 0.08 + 0.55 * math.sin(math.pi * min(s * 1.15, 1))
        for i in range(4):
            s0, s1 = i / 4, (i + 1) / 4; q0, q1 = Q(s0), Q(s1); w0, w1 = Wd(s0), Wd(s1)
            quad = [(q0[0] + px * w0, q0[1] + py * w0, q0[2] - 0.1 * w0), (q1[0] + px * w1, q1[1] + py * w1, q1[2] - 0.1 * w1), (q1[0] - px * w1, q1[1] - py * w1, q1[2] - 0.1 * w1), (q0[0] - px * w0, q0[1] - py * w0, q0[2] - 0.1 * w0)]
            pquad("palette", *quad, col, (0, 0, 1)); pquad("palette", *quad, col, (0, 0, -1))
    PLAN["trees"].append([round(x, 2), round(y, 2)])
def fountain(cx, cy, z, R, rng, jets=12):
    lathe(cx, cy, [(R, z), (R, z + 0.6), (R - 0.45, z + 0.6), (R - 0.45, z + 0.3)], 64, "marble")
    flat_ring("water", cx, cy, 0, R - 0.45, z + 0.32, 64, color="water")
    for q in (0.42, 0.7): flat_ring("palette", cx, cy, R * q, R * q + 0.25, z + 0.36, 64, color="white")
    lathe(cx, cy, [(R * 0.16, z + 0.3), (R * 0.12, z + 1.4), (R * 0.4, z + 1.7), (R * 0.42, z + 1.9), (R * 0.36, z + 1.9)], 40, "marble")
    flat_ring("water", cx, cy, 0, R * 0.36, z + 1.86, 40, color="water")
    lathe(cx, cy, [(R * 0.08, z + 1.86), (R * 0.03, z + 1.86 + R * 0.55), (0, z + 1.9 + R * 0.6)], 16, "jet")
    for k in range(jets):
        t = TAU * k / jets; r0 = R * 0.62; x0, y0 = cx + r0 * math.cos(t), cy + r0 * math.sin(t)
        lathe(x0, y0, [(0.12, z + 0.32), (0.04, z + 0.32 + R * 0.22), (0, z + 0.36 + R * 0.24)], 8, "jet")
    OCC.append((cx, cy, R + 1.5))

# ---------------------------------------------------------------- buildings
def bld(tag, kind, cx, cy, r, h, **kw): PLAN["buildings"].append({"id": tag, "kind": kind, "center": [round(cx, 2), round(cy, 2)], "radius": r, "height": round(h, 1), **kw}); OCC.append((cx, cy, r + 4))
def hero_spire(cx, cy, rng):
    """Flared buttress spire: glass core flaring to the ground, white buttress blades, gold mullions, observation drum, halo rings, needle."""
    z0 = plinth(cx, cy, 46, 0.6, 2); TOP = 88.0; core = lambda z: 6.5 + 10.5 * max(0.0, 1 - (z - z0) / (TOP - z0)) ** 2.2
    glass_shell(cx, cy, core, z0, int((TOP - z0) // FH), rng)
    glass_shell(cx, cy, lambda z: 26.0, z0, 2, rng); flat_ring("palette", cx, cy, 17.5, 26.6, z0 + 8.0, 64, color="moss"); lathe(cx, cy, [(26.6, z0 + 7.6), (26.6, z0 + 8.4), (26.2, z0 + 8.4)], 64, color="cream")
    for k in range(12):                                                    # gold mullions hugging the core
        t = TAU * (k + 0.5) / 12; pts = [(cx + (core(z) + 0.35) * math.cos(t), cy + (core(z) + 0.35) * math.sin(t), z) for z in [z0 + 8.5 + i * (TOP - z0 - 8.5) / 10 for i in range(11)]]
        chain(pts, 0.45, 0.35, "white", "gold")
    for k in range(6):                                                     # buttress blades: from the plinth edge up the core
        t = TAU * k / 6 + TAU / 12; pts = []
        for i in range(17):
            s = i / 16; z = z0 + 0.2 + 64 * s; r = core(z) + 0.9 + 30.0 * (1 - s) ** 2.4
            pts.append((cx + r * math.cos(t), cy + r * math.sin(t), z))
        chain(pts, 3.2, 1.3, "cream", "marble"); chain([(p[0] + 0.0, p[1], p[2] + 0.0) for p in pts], 0.5, 1.45, "white", "gold")
    lathe(cx, cy, [(core(TOP), TOP - 0.5), (15.5, TOP + 2.5), (16.4, TOP + 3.0), (16.4, TOP + 3.4), (15.9, TOP + 3.4)], 64, "marble")
    glass_shell(cx, cy, lambda z: 15.6, TOP + 3.4, 1, rng)
    lathe(cx, cy, [(16.6, TOP + 7.3), (16.6, TOP + 8.1), (12.0, TOP + 8.6), (5.0, TOP + 8.9), (0, TOP + 9.0)], 64, "marble")
    lathe(cx, cy, [(4.5, TOP + 8.95), (4.5, TOP + 9.25), (0, TOP + 9.3)], 32, "led", color="cool_led")
    for R, rr, zz in ((31.0, 0.55, TOP + 10.0), (24.0, 0.42, TOP + 10.6)): torus(cx, cy, zz, R, rr, "chrome", segR=96)
    for k in range(12):
        t = TAU * k / 12; beam((cx + 16.4 * math.cos(t), cy + 16.4 * math.sin(t), TOP + 7.8), (cx + 31 * math.cos(t), cy + 31 * math.sin(t), TOP + 10.0), 0.35, 0.3, "white", "chrome")
    lathe(cx, cy, [(1.1, TOP + 9.0), (0.6, TOP + 30), (0.18, TOP + 48), (0, TOP + 52)], 12, "gold")
    for k in range(3):
        t = TAU * k / 3 + 0.3; beam((cx + 7 * math.cos(t), cy + 7 * math.sin(t), TOP + 8.6), (cx + 2.2 * math.cos(t), cy + 2.2 * math.sin(t), TOP + 34), 1.1, 0.7, "cream", "marble")
    for s in (-1, 1): fountain(cx + s * 35.5, cy, z0, 6.0, rng, 8)
    bld("spire", "spire", cx, cy, 46, TOP + 52)
def ring_tower(tag, cx, cy, r, nfl, rng, crown="cone"):
    """Cylindrical tower with a white slab ring every floor (image 1), glass crown dome + gold rib cone + halo rings + needle."""
    z0 = plinth(cx, cy, r + 9, 0.5, 2); planter_ring(cx, cy, r + 3, r + 6, z0, rng, 18)
    glass_shell(cx, cy, lambda z: r, z0, nfl, rng, slab=0.85); top = z0 + nfl * FH
    lathe(cx, cy, [(r + 1.1, top - 0.4), (r + 1.1, top + 0.6), (r - 0.6, top + 0.9)], 48, "marble")
    dome(cx, cy, top + 0.9, r - 1.0, r * 0.45, 12, 1, oculus=False)
    if crown == "cone":
        apex = top + 0.9 + r * 1.3
        for k in range(14): t = TAU * k / 14; beam((cx + (r - 0.3) * math.cos(t), cy + (r - 0.3) * math.sin(t), top + 0.9), (cx + 0.6 * math.cos(t), cy + 0.6 * math.sin(t), apex), 0.45, 0.4, "white", "gold")
        for R, zz in ((r + 2.5, top + r * 0.35), (r * 0.62, top + r * 0.82), (r * 0.28, top + r * 1.12)): torus(cx, cy, zz, R, 0.32 if R > r else 0.25, "gold")
        lathe(cx, cy, [(0.5, apex - 1), (0.2, apex + 9), (0, apex + 10)], 10, "gold"); h = apex + 10
    else:                                                                  # crown = "halo": a single tilted-free horizontal ring on spokes
        torus(cx, cy, top + r * 0.6, r * 1.35, 0.45, "chrome")
        for k in range(8): t = TAU * k / 8; beam((cx + (r - 1) * math.cos(t), cy + (r - 1) * math.sin(t), top + 1.0), (cx + r * 1.35 * math.cos(t), cy + r * 1.35 * math.sin(t), top + r * 0.6), 0.3, 0.3, "white", "chrome")
        lathe(cx, cy, [(0.6, top + r * 0.45), (0.15, top + r * 1.6), (0, top + r * 1.7)], 10, "gold"); h = top + r * 1.7
    bld(tag, "ring_tower", cx, cy, r + 9, h)
def flared_tower(tag, cx, cy, rng, H=80.0, r_top=6.0, r_base=13.0, fins=4):
    """Image 3: tapering glass core, white blades sweeping out to the plinth, halo ring and needle on top."""
    z0 = plinth(cx, cy, 26, 0.6, 2); core = lambda z: r_top + (r_base - r_top) * max(0.0, 1 - (z - z0) / H) ** 1.6
    glass_shell(cx, cy, core, z0, int(H // FH), rng); top = z0 + int(H // FH) * FH
    for k in range(fins):
        t = TAU * k / fins + TAU / (2 * fins); pts = []
        for i in range(15):
            s = i / 14; z = z0 + 0.1 + (top - z0 - 4) * s; rr = core(z) + 0.7 + 10.5 * (1 - s) ** 2.0
            pts.append((cx + rr * math.cos(t), cy + rr * math.sin(t), z))
        chain(pts, 2.4, 1.2, "cream", "marble"); chain(pts, 0.4, 1.35, "white", "gold")
    lathe(cx, cy, [(core(top) + 0.2, top), (r_top + 1.6, top + 1.2), (r_top + 1.6, top + 2.0), (r_top - 1, top + 3.5), (1.2, top + 7)], 32, "domeglass")
    torus(cx, cy, top + 2.2, r_top + 6.5, 0.4, "gold"); torus(cx, cy, top + 2.2, r_top + 4.2, 0.22, "gold")
    for k in range(8): t = TAU * k / 8; beam((cx + (r_top + 1.6) * math.cos(t), cy + (r_top + 1.6) * math.sin(t), top + 1.8), (cx + (r_top + 6.5) * math.cos(t), cy + (r_top + 6.5) * math.sin(t), top + 2.2), 0.25, 0.25, "white", "gold")
    lathe(cx, cy, [(1.2, top + 7), (0.5, top + 18), (0, top + 20)], 10, "chrome")
    glass_shell(cx, cy, lambda z: 18.0, z0, 1, rng); lathe(cx, cy, [(18.3, z0 + 3.8), (18.3, z0 + 4.3), (0.0, z0 + 4.3)], 48, "marble")
    bld(tag, "flared_tower", cx, cy, 26, top + 20)
def diagrid_drum(tag, cx, cy, R, nfl, rng, n=20):
    """Image 2: glazed drum wrapped in a cream diagrid with gold inner lines, glass dome with gold ribs and a blue oculus."""
    z0 = plinth(cx, cy, R + 6, 0.5, 2); planter_ring(cx, cy, R + 1.5, R + 4.5, z0, rng, 24)
    glass_shell(cx, cy, lambda z: R, z0, nfl, rng); top = z0 + nfl * FH; lv = nfl
    P = lambda k, l, d=0.55: (cx + (R + d) * math.cos(TAU * k / n), cy + (R + d) * math.sin(TAU * k / n), z0 + top * 0 + (l * FH))
    for l in range(lv):
        for k in range(n):
            o = 0.5 * (l % 2); a = (k + o, l); b1 = (k + o + 0.5, l + 1); b2 = (k + o - 0.5, l + 1)
            for b in (b1, b2): beam(P(*a), P(*b), 0.7, 0.5, "cream"); beam(P(*a, d=0.85), P(*b, d=0.85), 0.16, 0.12, "white", "gold")
    lathe(cx, cy, [(R + 0.1, z0), (R + 1.1, z0), (R + 1.1, z0 + 1.0), (R + 0.1, z0 + 1.0)], 64, "marble")
    lathe(cx, cy, [(R + 0.2, top - 0.2), (R + 1.6, top - 0.2), (R + 1.6, top + 1.4), (R - 1.0, top + 1.4)], 64, "marble")
    dome(cx, cy, top + 1.4, R - 1.6, (R - 1.6) * 0.62, 20, 3)
    bld(tag, "diagrid_drum", cx, cy, R + 6, top + 1.4 + (R - 1.6) * 0.62)
def terraced_dome(tag, cx, cy, R, rng, levels=4):
    """Image 5 (left): stepped glass drums with planted terraces, crowned by a ribbed glass dome."""
    z = plinth(cx, cy, R + 5, 0.5, 2)
    for l in range(levels):
        r = R - 3.2 * l; glass_shell(cx, cy, lambda zz, r=r: r, z, 1, rng); z += FH
        lathe(cx, cy, [(r + 0.6, z - 0.3), (r + 0.6, z + 0.3), (r - 3.2, z + 0.3)], 64, "marble"); planter_ring(cx, cy, r - 2.8, r + 0.5, z + 0.3, rng, 16)
    rd = R - 3.2 * levels; dome(cx, cy, z + 0.3, rd, rd * 0.8, 16, 2, rib_b="chrome")
    bld(tag, "terraced_dome", cx, cy, R + 5, z + rd * 0.8)
def hex_tower(tag, cx, cy, r, nfl, rng):
    z0 = plinth(cx, cy, r + 7, 0.5, 2); poly = ellipse_poly(cx, cy, r, r, 6, 0.3); glass_prism(poly, z0, nfl, rng); top = z0 + nfl * FH
    for p in poly: lathe(p[0], p[1], [(0.45, z0), (0.45, top + 3), (0, top + 3.2)], 8, "gold")
    cap(poly, top, "concrete_dk"); inner = inset_poly(poly, 3.0); glass_prism(inner, top, 1, rng); cap(inner, top + FH, "white")
    for k in range(6):
        a = poly[k]; b = poly[(k + 1) % 6]; m = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        beam((a[0], a[1], top + 3), (m[0], m[1], top + 7.5), 0.35, 0.35, "white", "gold"); beam((b[0], b[1], top + 3), (m[0], m[1], top + 7.5), 0.35, 0.35, "white", "gold")
    lathe(cx, cy, [(3.0, top + FH), (0.0, top + FH + 6)], 6, "domeglass")
    bld(tag, "hex_tower", cx, cy, r + 7, top + FH + 6)
def wave_terraces(tag, cx, cy, rx, ry, rng, levels=4):
    """Image 5 (lower left): elliptical stacked terraces stepping back, green rims, roof pool, beside a freeform lagoon pool."""
    z = Z + 0.05
    for l in range(levels):
        ex, ey = rx - 2.6 * l, ry - 2.0 * l; poly = ellipse_poly(cx, cy, ex, ey, 32, 0.0); glass_prism(poly, z, 1, rng, slab=0.5); z += FH
        cap(poly, z, "cream"); rim = ellipse_poly(cx, cy, ex + 0.3, ey + 0.3, 32)
        for fr, L in edge_frames(rim, z): fbox(fr, 0, L, -0.9, 0.0, 0.0, 0.55, "leaf_dk")
    pool = ellipse_poly(cx, cy, rx - 2.6 * levels - 1, ry - 2.0 * levels - 1, 24)
    cxp, cyp = poly_center(pool)
    for k in range(len(pool)): a = pool[k]; b = pool[(k + 1) % len(pool)]; mb("water").tri((cxp, cyp, z + 0.08), (a[0], a[1], z + 0.08), (b[0], b[1], z + 0.08), pal_uv("water"), pal_uv("water"), pal_uv("water"), (0, 0, 1))
    bld(tag, "wave_terraces", cx, cy, max(rx, ry), z)
def lagoon_pool(cx, cy, rng):
    """Freeform resort pool: lobed outline (star-shaped from its centre), marble coping, loungers and parasols."""
    n = 40; pts = []
    for k in range(n):
        t = TAU * k / n; r = 15 + 4.5 * math.sin(2 * t + 0.6) + 2.5 * math.sin(3 * t + 1.7); pts.append((cx + r * 1.3 * math.cos(t), cy + r * math.sin(t)))
    for k in range(n):
        a = pts[k]; b = pts[(k + 1) % n]; u = pal_uv("water")
        mb("water").tri((cx, cy, Z + 0.1), (a[0], a[1], Z + 0.1), (b[0], b[1], Z + 0.1), u, u, u, (0, 0, 1)); beam((a[0], a[1], Z + 0.18), (b[0], b[1], Z + 0.18), 0.9, 0.3, "white", "marble")
    for k in range(10):
        t = TAU * k / 10 + 0.2; r = 25 + rng.uniform(0, 3); x, y = cx + 1.3 * r * math.cos(t), cy + r * math.sin(t)
        if not inside(x, y, 6): continue
        cyl(x, y, Z, Z + 2.5, 0.05, 6, "alu", top=False); lathe(x, y, [(1.6, Z + 2.2), (0.0, Z + 2.8)], 10, color=rng.choice(["teal", "white", "orange"]))
        for s in (-1, 1): pbox(x + s * 1.0 - 0.35, y - 0.9, x + s * 1.0 + 0.35, y + 0.9, Z, Z + 0.35, "white")
    OCC.append((cx, cy, 30))

# ---------------------------------------------------------------- island, roads, plazas
def inside(x, y, margin=0.0): R = R_ISL - margin; return (abs(x) / R) ** 4 + (abs(y) / R) ** 4 <= 1.0
def edge_pt(t, R=R_ISL):
    c, s = math.cos(t), math.sin(t); return (R * math.copysign(abs(c) ** 0.5, c), R * math.copysign(abs(s) ** 0.5, s))
def island(rng):
    N = 192; E = [edge_pt(TAU * k / N) for k in range(N)]
    for k in range(N):
        a = E[k]; b = E[(k + 1) % N]; mb("sidewalk").tri((0, 0, Z), (a[0], a[1], Z), (b[0], b[1], Z), (0, 0), (a[0] / TL["sidewalk"], a[1] / TL["sidewalk"]), (b[0] / TL["sidewalk"], b[1] / TL["sidewalk"]), (0, 0, 1))
        A = edge_pt(TAU * k / N, R_ISL + 7); B = edge_pt(TAU * (k + 1) / N, R_ISL + 7)
        pquad("palette", (a[0], a[1], Z), (b[0], b[1], Z), (B[0], B[1], -3.0), (A[0], A[1], -3.0), "sand", ((a[0] + b[0]), (a[1] + b[1]), 40))
        A2 = edge_pt(TAU * k / N, R_ISL + 22); B2 = edge_pt(TAU * (k + 1) / N, R_ISL + 22)
        pquad("shallow", (A[0], A[1], -1.15), (B[0], B[1], -1.15), (B2[0], B2[1], -1.15), (A2[0], A2[1], -1.15), "white", (0, 0, 1))
    for k in range(48):                                                      # breakwater rocks
        t = TAU * (k + 0.5) / 48; m = edge_pt(t, R_ISL + 4.5); D.blob(m[0], m[1], -1.0, rng.uniform(1.0, 1.8), rng.choice(["concrete", "concrete_dk", "gravel"]), rng, 6, 4)
    for k, t in enumerate([0.25, 0.75, 1.3, 2.2, 2.85, 3.5, 4.2, 5.25, 5.75]):   # timber piers
        a = edge_pt(t, R_ISL - 1); b = edge_pt(t, R_ISL + 24); d = (b[0] - a[0], b[1] - a[1]); L = math.hypot(*d); u = (d[0] / L, d[1] / L)
        beam((a[0], a[1], Z - 0.1), (b[0], b[1], Z - 0.1), 2.6, 0.3, "wood")
        for s in range(0, int(L), 4):
            for side in (-1, 1): x = a[0] + u[0] * s - u[1] * 1.2 * side; y = a[1] + u[1] * s + u[0] * 1.2 * side; cyl(x, y, -2.5, Z + 0.05, 0.14, 6, "wood_dk", top=False)
        beam((b[0] - u[1] * 3, b[1] + u[0] * 3, Z - 0.1), (b[0] + u[1] * 3, b[1] - u[0] * 3, Z - 0.1), 2.0, 0.3, "wood")
def roads(rng):
    flat_ring("road", 0, 0, 60, 74, Z + 0.03, 128, TL["road"])
    for k in range(64):                                                      # dashed lane line
        t0 = TAU * k / 64; t1 = t0 + TAU / 64 * 0.5; pts = [(r * math.cos(t), r * math.sin(t), Z + 0.06) for r, t in ((66.9, t0), (66.9, t1), (67.1, t1), (67.1, t0))]; pquad("palette", *pts, "paint_white", (0, 0, 1))
    for (y0, y1) in ((74, R_ISL + 2), (-R_ISL - 2, -152)):
        floor_quad("road", -8, y0, 8, y1, Z + 0.03, TL["road"]); D.stripe(-0.08, y0, 0.08, y1, Z + 0.06, "paint_yellow")
        for s in (-1, 1):
            D.stripe(s * 7.6 - 0.07, y0, s * 7.6 + 0.07, y1, Z + 0.06, "paint_white"); pbox(-8.0 if s < 0 else 7.75, y0, -7.75 if s < 0 else 8.0, y1, Z, Z + 0.16, "concrete")
            for k in range(int((y1 - y0) // 11)):
                y = y0 + 6 + k * 11
                if inside(s * 11, y, 4): palm(s * 11.0, y, Z, rng)
            for k in range(int((y1 - y0) // 22)):
                y = y0 + 11 + k * 22
                if inside(s * 9.2, y, 4): D.lamp(s * 9.2, y, Z, (-s, 0)); PLAN["lamps"].append([s * 9.2, y])
        D.crossing(-7.5, y0 + 2 if y0 > 0 else y1 - 6, 7.5, y0 + 6 if y0 > 0 else y1 - 2, Z + 0.06, False)
    OCC.append(("rect", -12, 74, 12, R_ISL)); OCC.append(("rect", -12, -R_ISL, 12, -152)); OCC.append(("ring", 58, 76))
def south_plaza(rng):
    cx, cy, R = 0.0, -130.0, 22.0
    flat_ring("terrazzo", cx, cy, 0, R, Z + 0.03, 96, TL["terrazzo"])
    for q, col in ((0.55, "terra"), (0.78, "white"), (0.97, "terra")): flat_ring("palette", cx, cy, R * q, R * q + 0.4, Z + 0.06, 96, color=col)
    for k in range(16):
        t = TAU * k / 16; pts = [(cx + r * math.cos(t + d), cy + r * math.sin(t + d), Z + 0.07) for r, d in ((12.6, -0.02), (R * 0.97, -0.012), (R * 0.97, 0.012), (12.6, 0.02))]; pquad("palette", *pts, "white", (0, 0, 1))
    fountain(cx, cy, Z + 0.03, 11.0, rng, 16)
    for k in range(12): t = TAU * (k + 0.5) / 12; palm(cx + (R + 3) * math.cos(t), cy + (R + 3) * math.sin(t), Z, rng)
    for k in range(8): t = TAU * k / 8; D.bench(cx + (R - 3) * math.cos(t), cy + (R - 3) * math.sin(t), Z + 0.03, abs(math.sin(t)) > 0.7)
    PLAN["plazas"].append({"center": [cx, cy], "r": R}); OCC.append((cx, cy, R + 4))
def green_ring(rng):
    flat_ring("palette", 0, 0, 46.2, 58.5, Z + 0.03, 96, color="grass")
    for k in range(20):
        t = TAU * (k + 0.5) / 20
        if abs(math.sin(t)) > 0.97: continue
        palm(52 * math.cos(t), 52 * math.sin(t), Z + 0.03, rng)
    for k in range(40):
        t = rng.uniform(0, TAU); r = rng.uniform(48, 57)
        if abs(math.cos(t)) < 0.14: continue
        D.shrub(r * math.cos(t), r * math.sin(t), Z + 0.03, rng, rng.uniform(0.5, 0.9), rng.choice(["pink", "lilac", "leaf_lt", "leaf", "yellow"]))
    for s in (-1, 1):                                                         # paved paths across the ring to the spire stairs
        floor_quad("terrazzo", -6, s * 46.0 if s > 0 else -58.6, 6, 58.6 if s > 0 else -46.0, Z + 0.035, TL["terrazzo"])
def monorail(rng):
    """Static elevated loop (ellipse 104 x 100 m) at deck height 9.5 m on Y-piers, one parked 4-car train on the east side."""
    N = 160; rx, ry, zt = 104.0, 100.0, Z + 9.5; P = [(rx * math.cos(TAU * k / N), ry * math.sin(TAU * k / N), zt) for k in range(N + 1)]
    for a, b in zip(P, P[1:]):
        beam(a, b, 1.6, 1.8, "white", "marble"); beam((a[0], a[1], a[2] - 0.95), (b[0], b[1], b[2] - 0.95), 2.4, 0.18, "white")
        beam((a[0], a[1], a[2] + 0.96), (b[0], b[1], b[2] + 0.96), 0.5, 0.12, "alu_dk")
    for k in range(0, N, 5):
        x, y, _ = P[k]
        if abs(x) < 13 or not inside(x, y, 3): continue
        cyl(x, y, Z, zt - 2.6, 0.75, 10, "white"); nx, ny = math.cos(TAU * k / N), math.sin(TAU * k / N)
        lathe(x, y, [(0.75, zt - 2.65), (1.3, zt - 1.5), (1.3, zt - 1.05), (0, zt - 1.05)], 10, "marble")
        PLAN["monorail"].append([round(x, 2), round(y, 2)])
    k0 = 6
    for car in range(4):
        a = P[k0 + car * 3]; b = P[k0 + car * 3 + 3]; mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        d = (b[0] - a[0], b[1] - a[1]); L = math.hypot(*d); u = (d[0] / L, d[1] / L); g = 0.35
        A = (a[0] + u[0] * g, a[1] + u[1] * g, zt + 2.6); B = (b[0] - u[0] * g, b[1] - u[1] * g, zt + 2.6)
        beam(A, B, 2.9, 3.0, "white"); beam((A[0], A[1], zt + 3.0), (B[0], B[1], zt + 3.0), 3.0, 1.0, "glass_dk"); beam((A[0], A[1], zt + 1.55), (B[0], B[1], zt + 1.55), 3.0, 0.22, "blue")
        beam((A[0], A[1], zt + 4.15), (B[0], B[1], zt + 4.15), 2.2, 0.15, "alu")
    OCC.append(("ell", rx, ry, 4.0))
def free(x, y, r=1.5):
    if not inside(x, y, 6 + r): return False
    for o in OCC:
        if o[0] == "rect":
            if o[1] - r <= x <= o[3] + r and o[2] - r <= y <= o[4] + r: return False
        elif o[0] == "ring":
            if o[1] - r <= math.hypot(x, y) <= o[2] + r: return False
        elif o[0] == "ell":
            if abs(math.hypot(x / o[1], y / o[2]) - 1) * min(o[1], o[2]) < o[3] + r: return False
        elif math.hypot(x - o[0], y - o[1]) < o[2] + r: return False
    return True
def lawns(rng, n):
    """Round lawn beds with a cream kerb, a palm cluster and flowers (the concept's dense planting between buildings)."""
    placed = 0; tries = 0
    while placed < n and tries < n * 60:
        tries += 1; x, y = rng.uniform(-R_ISL, R_ISL), rng.uniform(-R_ISL, R_ISL); r = rng.uniform(5, 9)
        if not free(x, y, r): continue
        flat_ring("palette", x, y, 0, r, Z + 0.04, 28, color="grass"); lathe(x, y, [(r + 0.3, Z), (r + 0.3, Z + 0.3), (r, Z + 0.3)], 28, color="cream")
        for k in range(rng.choice([2, 3, 4])): a = rng.uniform(0, TAU); d = rng.uniform(0, r * 0.55); palm(x + d * math.cos(a), y + d * math.sin(a), Z + 0.04, rng)
        for k in range(int(r * 1.6)):
            a = rng.uniform(0, TAU); d = rng.uniform(r * 0.4, r - 0.7)
            D.shrub(x + d * math.cos(a), y + d * math.sin(a), Z + 0.04, rng, rng.uniform(0.4, 0.75), rng.choice(["pink", "lilac", "leaf_lt", "leaf", "yellow", "pink"]))
        OCC.append((x, y, r + 2.5)); placed += 1
def scatter(rng, n_palm, n_shrub, n_lamp):
    placed = 0; tries = 0
    while placed < n_palm and tries < n_palm * 30:
        tries += 1; x, y = rng.uniform(-R_ISL, R_ISL), rng.uniform(-R_ISL, R_ISL)
        if free(x, y, 2.5): palm(x, y, Z, rng); OCC.append((x, y, 3.0)); placed += 1
    placed = 0; tries = 0
    while placed < n_shrub and tries < n_shrub * 30:
        tries += 1; x, y = rng.uniform(-R_ISL, R_ISL), rng.uniform(-R_ISL, R_ISL)
        if free(x, y, 1.0): D.shrub(x, y, Z, rng, rng.uniform(0.5, 1.0), rng.choice(["pink", "lilac", "leaf", "leaf_lt", "moss", "pink"])); placed += 1
    for k in range(n_lamp):
        t = TAU * k / n_lamp; x, y = 82 * math.cos(t), 82 * math.sin(t)
        if free(x, y, 0.8): D.lamp(x, y, Z, (-math.cos(t), -math.sin(t))); PLAN["lamps"].append([round(x, 2), round(y, 2)])

# ---------------------------------------------------------------- compose
rng = random.Random(9090)
with grp("ground"): island(random.Random(1)); roads(random.Random(2)); green_ring(random.Random(3)); south_plaza(random.Random(4))
with grp("spire"): hero_spire(0, 0, random.Random(10))
with grp("ringA"): ring_tower("ringA", 112, 96, 11, 18, random.Random(11), "cone")
with grp("ringB"): ring_tower("ringB", -120, 104, 9, 14, random.Random(12), "halo")
with grp("flareA"): flared_tower("flareA", -54, 138, random.Random(13), 84)
with grp("flareB"): flared_tower("flareB", 62, 140, random.Random(14), 64, 5.0, 11.0, 3)
with grp("drumA"): diagrid_drum("drumA", 138, -40, 22, 5, random.Random(15), 20)
with grp("drumB"): diagrid_drum("drumB", 104, -112, 17, 4, random.Random(16), 16)
with grp("drumC"): diagrid_drum("drumC", 52, -148, 12, 3, random.Random(17), 12)
with grp("terrDome"): terraced_dome("terrDome", -136, -22, 20, random.Random(18))
with grp("hexT"): hex_tower("hexT", -146, 46, 12, 24, random.Random(19))
with grp("wave"): wave_terraces("wave", -104, -120, 22, 14, random.Random(20))
with grp("pool"): lagoon_pool(-52, -150, random.Random(21))
with grp("rail"): monorail(random.Random(22))
with grp("lawns"): lawns(random.Random(24), 46)
with grp("scatter"): scatter(random.Random(23), 110, 160, 36)
realise({"road": "Road", "sidewalk": "Sidewalk", "glass": "Glass", "shopglass": "ShopGlass", "palette": "Props", "led": "Led"})
agg = {}
for k, v in MBS.items(): agg[k.rpartition("::")[2]] = agg.get(k.rpartition("::")[2], 0) + len(v.f)
grpt = {}
for k, v in MBS.items(): grpt[k.rpartition("::")[0]] = grpt.get(k.rpartition("::")[0], 0) + len(v.f)
print("TRIS", sum(agg.values()), dict(sorted(agg.items(), key=lambda kv: -kv[1])[:10])); print("GROUPS", dict(sorted(grpt.items(), key=lambda kv: -kv[1])))
os.makedirs(f"{HERE}/out", exist_ok=True); bpy.ops.wm.save_as_mainfile(filepath=f"{HERE}/out/halo.blend")
export_glb(f"{HERE}/out/world-halo.glb"); json.dump(PLAN, open(f"{HERE}/out/halo-plan.json", "w"))
