"""Halo Lagoon props: cars, yachts/sailboats, parasols, a domed kiosk, bins, bollards, sun loungers.
Runs inside headless Blender 5.2 Python (import after mkit). Every function only emits faces into kit.MB buckets and returns None;
pass `occ=[...]` to have a keep-out circle (x, y, r) appended (same shape as halo.OCC).

Conventions: x east, y north, z up; `z` is the absolute height of the surface the prop stands on (`z_water` for boats).
`heading` = direction the prop's front points, radians CCW from +x (east) in the Blender XY plane
(car/boat nose, lounger foot end).  Every face is single-sided with an explicit outward normal; things seen from both
sides (parasol canopy, kiosk awning) are emitted twice.

Materials: flat colours sample the palette swatch atlas (`palette_m.json`).  Metal / stone / glass parts go through the
bucket table `MAT`; by default all of it is the self-contained `palette` bucket (+ `led` for lights).  Call
`use_halo_materials()` once in halo.py to route gold/chrome/marble/glass parts to its solid/glass materials instead."""
import math
from mkit import pquad, ptri, beam

TAU = 2 * math.pi
# role -> (bucket, palette colour). The palette colour is only used for UVs when the bucket is a solid-colour material.
MAT = {"gold": ("palette", "yellow"), "chrome": ("palette", "alu"), "marble": ("palette", "cream"), "glass": ("palette", "glass_dk"),
       "kglass": ("palette", "glass_dk"), "led": ("led", "cool_led"), "led_warm": ("led", "warm_led"), "led_red": ("led", "red")}
def use_halo_materials(gold="gold", chrome="chrome", marble="marble", kiosk_glass="shopglass", led="led"):
    """Route metal/stone/glass roles to halo.py's buckets (they must exist in mkit.MATS before realise())."""
    MAT.update({"gold": (gold, "yellow"), "chrome": (chrome, "alu"), "marble": (marble, "white"), "kglass": (kiosk_glass, "glass_lt"),
                "led": (led, "cool_led"), "led_warm": (led, "warm_led"), "led_red": (led, "red")})

CAR_PAINT = ["white", "tile_white", "alu", "cream", "navy", "teal", "red", "black", "white", "alu"]   # white/silver weighted

# ---------------------------------------------------------------- local frame + primitives
class _F:
    """Prop-local frame: lx forward (heading), ly to the left, lz up."""
    def __init__(s, x, y, z, h=0.0): s.x, s.y, s.z, s.c, s.s = x, y, z, math.cos(h), math.sin(h)
    def p(s, lx, ly, lz): return (s.x + lx * s.c - ly * s.s, s.y + lx * s.s + ly * s.c, s.z + lz)
    def n(s, v): return (v[0] * s.c - v[1] * s.s, v[0] * s.s + v[1] * s.c, v[2])
def _role(r): return MAT[r] if r in MAT else ("palette", r)
def _q(F, role, a, b, c, d, out):
    bk, col = _role(role); pquad(bk, F.p(*a), F.p(*b), F.p(*c), F.p(*d), col, F.n(out))
def _t(F, role, a, b, c, out):
    bk, col = _role(role); ptri(bk, F.p(*a), F.p(*b), F.p(*c), col, F.n(out))
def _ctr(pts): n = len(pts); return tuple(sum(p[i] for p in pts) / n for i in range(3))
def _sub(a, b): return (a[0] - b[0], a[1] - b[1], a[2] - b[2])
def _loft(F, rings, axes, role_fn, closed=True):
    """Quads between consecutive rings (same point count). axes[i] = a point inside ring i; outward = face centre - axis."""
    m = len(rings[0]); ne = m if closed else m - 1
    for i in range(len(rings) - 1):
        ax = _ctr([axes[i], axes[i + 1]])
        for j in range(ne):
            a, b = rings[i][j], rings[i][(j + 1) % m]; c, d = rings[i + 1][(j + 1) % m], rings[i + 1][j]
            r = role_fn(i, j)
            if r: _q(F, r, a, b, c, d, _sub(_ctr([a, b, c, d]), ax))
def _fan(F, role, pts, out):
    c = _ctr(pts)
    for k in range(len(pts)): _t(F, role, c, pts[k], pts[(k + 1) % len(pts)], out)
def _box(F, role, x0, x1, y0, y1, z0, z1, bottom=False, skip=()):
    for key, q, o in (("-y", ((x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)), (0, -1, 0)), ("+x", ((x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)), (1, 0, 0)),
                      ("+y", ((x1, y1, z0), (x0, y1, z0), (x0, y1, z1), (x1, y1, z1)), (0, 1, 0)), ("-x", ((x0, y1, z0), (x0, y0, z0), (x0, y0, z1), (x0, y1, z1)), (-1, 0, 0)),
                      ("+z", ((x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)), (0, 0, 1)), ("-z", ((x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0)), (0, 0, -1))):
        if key in skip or (key == "-z" and not bottom): continue
        _q(F, role, *q, o)
def _hexa(F, role, P, bottom=False):
    """Arbitrary convex hexahedron: P = 4 bottom corners then the 4 top corners above them (same order)."""
    c = _ctr(P)
    faces = [(P[0], P[1], P[5], P[4]), (P[1], P[2], P[6], P[5]), (P[2], P[3], P[7], P[6]), (P[3], P[0], P[4], P[7]), (P[4], P[5], P[6], P[7])]
    if bottom: faces.append((P[0], P[1], P[2], P[3]))
    for f in faces: _q(F, role, *f, _sub(_ctr(f), c))
def _lathe(F, cx, cy, prof, seg, role, phase=0.0, role_k=None):
    """Surface of revolution about local (cx, cy); prof bottom->top [(r, z)], outward from the profile tangent."""
    for i in range(len(prof) - 1):
        (r0, z0), (r1, z1) = prof[i], prof[i + 1]; nr, nz = z1 - z0, -(r1 - r0)
        if abs(nr) + abs(nz) < 1e-6: continue
        for k in range(seg):
            t0, t1 = phase + TAU * k / seg, phase + TAU * (k + 1) / seg; tm = (t0 + t1) / 2
            P = lambda r, t, z: (cx + r * math.cos(t), cy + r * math.sin(t), z)
            _q(F, role_k(k) if role_k else role, P(r0, t0, z0), P(r0, t1, z0), P(r1, t1, z1), P(r1, t0, z1), (math.cos(tm) * nr, math.sin(tm) * nr, nz))
def _disc(F, cx, cy, r, z, seg, role, down=False, phase=0.0):
    pts = [(cx + r * math.cos(phase + TAU * k / seg), cy + r * math.sin(phase + TAU * k / seg), z) for k in range(seg)]
    _fan(F, role, pts, (0, 0, -1 if down else 1))
def _beam(F, a, b, w, h, role):
    bk, col = _role(role); beam(F.p(*a), F.p(*b), w, h, col, bk)
def _occ(occ, x, y, r):
    if occ is not None: occ.append((x, y, r))

# ---------------------------------------------------------------- 1. car
# stations along the body (front = +x): (x, half-width, z bottom, z belt, z roof, roof half-width)
_CAR = [(-2.30, 0.70, 0.40, 0.80, 0.84, 0.52), (-2.18, 0.88, 0.28, 0.88, 0.97, 0.62), (-1.75, 0.94, 0.20, 0.91, 1.17, 0.63),
        (-0.95, 0.95, 0.18, 0.90, 1.41, 0.66), (-0.15, 0.95, 0.18, 0.88, 1.45, 0.68), (0.55, 0.95, 0.18, 0.86, 1.37, 0.65),
        (1.30, 0.93, 0.19, 0.80, 0.99, 0.60), (1.98, 0.86, 0.22, 0.68, 0.73, 0.50), (2.30, 0.60, 0.30, 0.52, 0.55, 0.36)]
_WR, _WX = 0.35, (1.48, -1.45)
def _car_w(x):
    for a, b in zip(_CAR, _CAR[1:]):
        if a[0] <= x <= b[0]: t = (x - a[0]) / (b[0] - a[0]); return a[1] + (b[1] - a[1]) * t
    return _CAR[0][1] if x < _CAR[0][0] else _CAR[-1][1]
def _car_ring(st):
    x, w, zb, zs, zt, wr = st
    half = [(x, -w * 0.84, zb), (x, -w, zb + 0.17), (x, -w * 0.985, zs), (x, -wr, zt - 0.06), (x, -wr * 0.55, zt)]
    return half + [(px, -py, pz) for px, py, pz in reversed(half)]
def car(x, y, z, heading, rng, color=None, occ=None):
    """Sleek EV pod, 4.6 x 1.9 x 1.45 m, ~350 tris. Front LED bar (white) and rear light bar (red) in the emissive bucket."""
    F = _F(x, y, z, heading); paint = color or rng.choice(CAR_PAINT); trim = "alu_dk" if paint == "black" else "black"
    rings = [_car_ring(s) for s in _CAR]; axes = [(s[0], 0, (s[2] + s[4]) / 2) for s in _CAR]
    # ring edges: 0 lower tuck L, 1 side L, 2 greenhouse L, 3 roof L, 4 roof mid, 5 roof R, 6 greenhouse R, 7 side R, 8 tuck R, 9 floor
    def role(i, j):
        if j in (0, 8, 9): return trim
        if j in (2, 6): return "glass" if 2 <= i <= 5 else paint            # side window band, tail to windscreen base
        if j in (3, 4, 5): return "glass" if i in (2, 5) else paint          # rear window, windscreen (roof stays body colour)
        return paint
    _loft(F, rings, axes, role)
    _fan(F, paint, list(reversed(rings[0][1:9])), (-1, 0, 0)); _fan(F, paint, rings[-1][1:9], (1, 0, 0))
    _t(F, trim, rings[0][0], rings[0][1], rings[0][8], (-1, 0, 0)); _t(F, trim, rings[0][0], rings[0][8], rings[0][9], (-1, 0, 0))
    _t(F, trim, rings[-1][0], rings[-1][1], rings[-1][8], (1, 0, 0)); _t(F, trim, rings[-1][0], rings[-1][8], rings[-1][9], (1, 0, 0))
    # light bars 3 cm proud of the end caps
    _q(F, "led", (2.335, -0.50, 0.44), (2.335, 0.50, 0.44), (2.335, 0.50, 0.48), (2.335, -0.50, 0.48), (1, 0, 0))
    _q(F, "led_red", (-2.335, 0.56, 0.70), (-2.335, -0.56, 0.70), (-2.335, -0.56, 0.75), (-2.335, 0.56, 0.75), (-1, 0, 0))
    # wheels: 8-sided tyre, alloy hub cone, dark arch lip on the body side above each wheel
    for wx in _WX:
        wmax = max(_car_w(wx + d) for d in (-_WR, 0, _WR))
        for sd in (-1, 1):
            yo, yi = sd * (wmax + 0.02), sd * (wmax - 0.23); n = 8
            P = lambda r, a, yy: (wx + r * math.cos(a), yy, _WR + r * math.sin(a))
            for k in range(n):
                a0, a1 = TAU * (k + 0.5) / n, TAU * (k + 1.5) / n; am = (a0 + a1) / 2
                _q(F, "black", P(_WR, a0, yi), P(_WR, a1, yi), P(_WR, a1, yo), P(_WR, a0, yo), (math.cos(am), 0, math.sin(am)))
                _q(F, "steel", P(_WR, a0, yo), P(_WR, a1, yo), P(0.23, a1, yo), P(0.23, a0, yo), (0, sd, 0))
                _t(F, "chrome", P(0.23, a0, yo), P(0.23, a1, yo), (wx, yo + sd * 0.025, _WR), (0, sd, 0))
            for k in range(4):                                                     # arch: 4 quads over the top of the tyre
                a0, a1 = math.pi * k / 4, math.pi * (k + 1) / 4
                pts = [(wx + r * math.cos(a), sd * (_car_w(wx + r * math.cos(a)) + 0.012), _WR + r * math.sin(a)) for r, a in ((0.38, a0), (0.38, a1), (0.45, a1), (0.45, a0))]
                _q(F, "black", *pts, (0, sd, 0))
    _occ(occ, x, y, 2.5)

# ---------------------------------------------------------------- 2. boats
def _hull(F, L, B, sheer, keel, wds, ts, hull, bottom="navy", deck="wood"):
    """Lofted hull from transom (t=0) to stem (t=1); returns (sheer points per station) for decks/rails."""
    rings, axes = [], []
    for t, wd, zs, zk in zip(ts, wds, sheer, keel):
        x = -L / 2 + L * t; w = B * wd; zc = -0.04 if t < 0.9 else zk * 0.5
        half = [(x, w, zs), (x, w * 0.98, zs - 0.42 * (zs - zc)), (x, w * 0.86, zc)]
        rings.append(half + [(x, 0.0, zk)] + [(px, -py, pz) for px, py, pz in reversed(half)]); axes.append((x, 0, (zs + zk) / 2))
    def role(i, j): return bottom if j in (2, 3) else hull
    _loft(F, rings, axes, role, closed=False)
    _fan(F, hull, list(reversed(rings[0])), (-1, 0, 0))                              # flat transom
    for i in range(len(rings) - 1):                                                   # deck between the sheer lines
        a, b, c, d = rings[i][6], rings[i][0], rings[i + 1][0], rings[i + 1][6]; _q(F, deck, a, b, c, d, (0, 0, 1))
    return rings
def _rails(F, rings, i0, h, role="chrome"):
    """Chrome guard rails along both sheers from station i0 to the bow, stanchions at each station."""
    for sd in (0, 6):
        pts = [(r[sd][0], r[sd][1] * 0.93, r[sd][2] + h) for r in rings[i0:]]
        pts[-1] = (pts[-1][0] - 0.25, 0.0, pts[-1][2] - 0.05)
        for a, b in zip(pts, pts[1:]): _beam(F, a, b, 0.04, 0.04, role)
        for p in pts[:-1]: _beam(F, (p[0], p[1], p[2] - h + 0.02), p, 0.035, 0.035, role)
def yacht(x, y, z_water, heading, rng, length=None, occ=None):
    """Motor yacht 9-14 m: white hull (pointed bow, flat transom, swim platform), hull windows, deckhouse with dark glazing,
    enclosed upper cabin under an overhanging hardtop, chrome rails, teak decks. ~560 tris."""
    L = length or rng.uniform(9.0, 14.0); B = 0.175 * L; s = L / 12.0; F = _F(x, y, z_water, heading)
    hull = rng.choice(["white", "white", "white", "navy", "tile_white"]); bot = "navy" if hull != "navy" else "white"
    ts = (0.0, 0.15, 0.35, 0.55, 0.72, 0.85, 0.94, 1.0); wds = (0.93, 0.98, 1.0, 0.98, 0.86, 0.64, 0.36, 0.02)
    sheer = tuple(v * s for v in (1.05, 1.05, 1.07, 1.12, 1.22, 1.34, 1.44, 1.52)); keel = tuple(v * s for v in (-0.5, -0.58, -0.64, -0.62, -0.5, -0.3, 0.05, 0.75))
    R = _hull(F, L, B, sheer, keel, wds, ts, hull, bot)
    def hp(i, u, f, sd):                                                              # point on the upper hull side, 3 cm proud
        a, b = (R[i][0], R[i][1]) if sd > 0 else (R[i][6], R[i][5]); c, d = (R[i + 1][0], R[i + 1][1]) if sd > 0 else (R[i + 1][6], R[i + 1][5])
        p = [a[k] + (c[k] - a[k]) * u + ((b[k] + (d[k] - b[k]) * u) - (a[k] + (c[k] - a[k]) * u)) * f for k in range(3)]
        return (p[0], p[1] + sd * 0.03, p[2])
    for sd in (1, -1):                                                                # hull window strip, tapered ends
        for i, u0, u1 in ((2, 0.25, 1.0), (3, 0.0, 0.7)):
            f0, f1 = 0.28, 0.62; e0 = 0.08 if u0 > 0 else 0.0; e1 = 0.08 if u1 < 1 else 0.0
            _q(F, "glass", hp(i, u0, f0 + e0, sd), hp(i, u1, f0 + e1, sd), hp(i, u1, f1 - e1, sd), hp(i, u0, f1 - e0, sd), (0, sd, 0))
    _box(F, "wood", -L / 2 - 0.7 * s, -L / 2, -B * 0.85, B * 0.85, 0.22 * s, 0.32 * s)                   # swim platform
    # deckhouse: (t, half-width factor, wall height); front station low = raked windscreen
    zd = sheer[2] - 0.05; dh = [(0.17, 0.80, 1.55), (0.50, 0.80, 1.55), (0.63, 0.70, 1.28), (0.71, 0.52, 0.42)]
    def cabin(stations, zb, glass_lo, glass_hi, wind_i):
        rings, axes = [], []
        for t, f, h in stations:
            xx = -L / 2 + L * t; w = B * f; h *= s
            half = [(xx, w, zb), (xx, w, zb + glass_lo * h), (xx, w * 0.97, zb + glass_hi * h), (xx, w * 0.88, zb + h)]
            rings.append(half + [(px, -py, pz) for px, py, pz in reversed(half)]); axes.append((xx, 0, zb + h * 0.4))
        def role(i, j):
            if j in (1, 5): return "glass"
            if j == 3 and i == wind_i: return "glass"
            return "white"
        _loft(F, rings, axes, role, closed=False)
        _q(F, "white", rings[0][0], rings[0][7], rings[0][6], rings[0][1], (-1, 0, 0)); _q(F, "glass", rings[0][1], rings[0][6], rings[0][5], rings[0][2], (-1, 0, 0))
        _q(F, "white", rings[0][2], rings[0][5], rings[0][4], rings[0][3], (-1, 0, 0))
        e = rings[-1]; _fan(F, "white", e, (1, 0, 0))
        return rings
    cabin(dh, zd, 0.42, 0.82, 2)
    zu = zd + 1.55 * s; up = [(0.24, 0.62, 0.95), (0.44, 0.62, 0.95), (0.50, 0.50, 0.55)]
    cabin(up, zu, 0.30, 0.86, 1)
    zt = zu + 0.95 * s; xa, xb = -L / 2 + L * 0.11, -L / 2 + L * 0.53                                       # hardtop + aft posts
    _box(F, "white", xa, xb, -B * 0.74, B * 0.74, zt + 0.04 * s, zt + 0.13 * s, bottom=True)
    for sd in (1, -1): _beam(F, (xa + 0.25 * s, sd * B * 0.66, zd), (xa + 0.25 * s, sd * B * 0.66, zt + 0.05 * s), 0.08 * s, 0.08 * s, "white")
    _beam(F, (xb - 1.0 * s, 0, zt + 0.13 * s), (xb - 1.2 * s, 0, zt + 0.7 * s), 0.08 * s, 0.12 * s, "white")            # radar mast
    _lathe(F, xb - 1.2 * s, 0, [(0.22 * s, zt + 0.7 * s), (0.24 * s, zt + 0.82 * s), (0, zt + 0.9 * s)], 6, "white")
    _rails(F, R, 4, 0.6 * s)
    _occ(occ, x, y, L * 0.55)
def sailboat(x, y, z_water, heading, rng, length=None, occ=None):
    """Sloop 8-12 m: slim white hull, low cabin trunk with dark ports, mast + furled main on the boom, stays, rails. ~330 tris."""
    L = length or rng.uniform(8.0, 12.0); B = 0.15 * L; s = L / 10.0; F = _F(x, y, z_water, heading)
    ts = (0.0, 0.15, 0.35, 0.55, 0.72, 0.85, 0.94, 1.0); wds = (0.80, 0.93, 1.0, 0.98, 0.86, 0.62, 0.34, 0.02)
    sheer = tuple(v * s for v in (0.62, 0.62, 0.64, 0.68, 0.74, 0.82, 0.88, 0.94)); keel = tuple(v * s for v in (-0.35, -0.45, -0.55, -0.55, -0.45, -0.28, 0.0, 0.5))
    R = _hull(F, L, B, sheer, keel, wds, ts, rng.choice(["white", "white", "tile_white", "navy"]), "red" if rng.random() < 0.5 else "navy")
    zd = sheer[3] - 0.03; x0, x1 = -L / 2 + L * 0.30, -L / 2 + L * 0.66; w = B * 0.62; h = 0.42 * s                 # cabin trunk
    _hexa(F, "white", [(x0, -w, zd), (x1, -w * 0.8, zd), (x1, w * 0.8, zd), (x0, w, zd), (x0 + 0.1, -w * 0.94, zd + h), (x1 - 0.4 * s, -w * 0.62, zd + h * 0.8), (x1 - 0.4 * s, w * 0.62, zd + h * 0.8), (x0 + 0.1, w * 0.94, zd + h)])
    for sd in (1, -1):
        yy = sd * (w * 0.97 + 0.03)
        _q(F, "glass", (x0 + 0.5 * s, yy, zd + h * 0.45), (x1 - 0.9 * s, yy * 0.93, zd + h * 0.45), (x1 - 0.9 * s, yy * 0.93, zd + h * 0.72), (x0 + 0.5 * s, yy, zd + h * 0.75), (0, sd, 0))
    xm = -L / 2 + L * 0.60; H = 1.3 * L; zb = zd + h + 0.7 * s
    _beam(F, (xm, 0, zd + h * 0.8), (xm, 0, zd + H), 0.14 * s, 0.2 * s, "white")
    xb = -L / 2 + L * 0.14; _beam(F, (xm, 0, zb), (xb, 0, zb), 0.1 * s, 0.12 * s, "chrome")
    cover = rng.choice(["navy", "white", "teal", "cream"]); _beam(F, (xm - 0.2 * s, 0, zb + 0.16 * s), (xb + 0.6 * s, 0, zb + 0.12 * s), 0.24 * s, 0.24 * s, cover)
    _beam(F, (xm, 0, zd + H * 0.96), (L / 2 - 0.15 * s, 0, sheer[-1]), 0.03, 0.03, "chrome")                  # forestay
    fx0, fz0 = L / 2 - 0.35 * s, sheer[-1] + 0.15; fx1, fz1 = xm + (L / 2 - 0.15 * s - xm) * 0.12, zd + H * 0.96 - (zd + H * 0.96 - sheer[-1]) * 0.12
    _beam(F, (fx0, 0, fz0), (fx1, 0, fz1 - 0.1), 0.11 * s, 0.11 * s, "white")                                   # furled jib on the forestay
    _beam(F, (xm, 0, zd + H), (-L / 2 + 0.1, 0, sheer[0]), 0.03, 0.03, "chrome")                               # backstay
    _rails(F, R, 1, 0.55 * s)
    _occ(occ, x, y, L * 0.55)

# ---------------------------------------------------------------- 3. parasol
PARASOL_COLS = [("cream", "terra"), ("cream", "teal"), ("white", "teal"), ("white", "navy"), ("cream", "cream"), ("terra", "terra")]
def parasol(x, y, z, rng, r=None, colors=None, occ=None):
    """Octagonal market umbrella (~110 tris): pole, slightly domed canopy of alternating panels, valance; canopy emitted top and underside."""
    r = r or rng.uniform(1.35, 1.8); ca, cb = colors or rng.choice(PARASOL_COLS); F = _F(x, y, z, rng.uniform(0, TAU)); n = 8
    zr = 2.15; za = zr + r * 0.34; zm = zr + r * 0.24; rm = r * 0.55
    _lathe(F, 0, 0, [(0.2, 0), (0.05, 0.12)], 6, "concrete_dk"); _lathe(F, 0, 0, [(0.028, 0.12), (0.028, za + 0.02)], 6, "white")
    _lathe(F, 0, 0, [(0.05, za - 0.01), (0.0, za + 0.14)], 6, "white")
    P = lambda rr, k, zz: (rr * math.cos(TAU * k / n), rr * math.sin(TAU * k / n), zz)
    for k in range(n):
        col = ca if k % 2 == 0 else cb; A = (0, 0, za); m0, m1 = P(rm, k, zm), P(rm, k + 1, zm); r0, r1 = P(r, k, zr), P(r, k + 1, zr)
        up = (math.cos(TAU * (k + 0.5) / n) * 0.3, math.sin(TAU * (k + 0.5) / n) * 0.3, 1)
        dn = (-up[0], -up[1], -1)
        _t(F, col, A, m0, m1, up); _q(F, col, m0, r0, r1, m1, up); _t(F, col, A, m0, m1, dn); _q(F, col, m0, r0, r1, m1, dn)
        v0, v1 = (r0[0], r0[1], zr - 0.18), (r1[0], r1[1], zr - 0.18); o = (up[0], up[1], 0)                     # valance, both faces
        _q(F, col, r0, r1, v1, v0, o); _q(F, col, r0, r1, v1, v0, (-o[0], -o[1], 0))
    _occ(occ, x, y, r)

# ---------------------------------------------------------------- 4. kiosk
def kiosk(x, y, z, rng, occ=None, awning=None):
    """Round 3.5 m futurist kiosk (~520 tris): marble counter base, glazed band around a warm-lit core, striped awning ring,
    marble eave, low ribbed gold dome with a finial. Buckets via MAT roles: marble, kglass, gold, led_warm."""
    F = _F(x, y, z, rng.uniform(0, TAU)); n = 12; aw = awning or rng.choice([("cream", "terra"), ("cream", "teal"), ("white", "navy")])
    _lathe(F, 0, 0, [(1.72, 0), (1.72, 0.92), (1.80, 0.92), (1.80, 1.0), (1.60, 1.0)], n, "marble")
    _lathe(F, 0, 0, [(1.58, 1.0), (1.58, 2.36)], n, "kglass")
    _disc(F, 0, 0, 1.6, 1.0, n, "cream")                                                                         # floor seen through glass
    _lathe(F, 0, 0, [(0.85, 1.0), (0.85, 2.0)], n, "wood", role_k=lambda k: "wood" if k % 3 else "teal")           # shelving core
    _lathe(F, 0, 0, [(0.85, 2.0), (0.85, 2.36)], n, "led_warm")
    _disc(F, 0, 0, 1.9, 2.36, n, "white", down=True)                                                            # soffit
    _lathe(F, 0, 0, [(1.9, 2.36), (1.9, 2.52), (1.78, 2.52)], n, "marble")
    for side in (1, -1):                                                                                         # awning frustum, both faces
        for k in range(n):
            a0, a1 = TAU * k / n, TAU * (k + 1) / n; am = (a0 + a1) / 2; col = aw[k % 2]
            P = lambda r, a, zz: (r * math.cos(a), r * math.sin(a), zz)
            q = (P(1.93, a0, 2.33), P(1.93, a1, 2.33), P(2.5, a1, 2.08), P(2.5, a0, 2.08)); o = (math.cos(am) * 0.25 * side, math.sin(am) * 0.25 * side, side)
            _q(F, col, *q, o)
    R0, Hd, zb = 1.78, 0.95, 2.52; prof = [(R0 * math.cos(math.pi / 2 * i / 4), zb + Hd * math.sin(math.pi / 2 * i / 4)) for i in range(5)]
    _lathe(F, 0, 0, prof, n, "white")
    for k in range(6):                                                                                            # gold ribs 5 cm proud
        t = TAU * k / 6 + TAU / 24; pts = []
        for i in range(4):
            a = math.pi / 2 * i / 4; nx, nz = Hd * math.cos(a), R0 * math.sin(a); l = math.hypot(nx, nz)
            rr = R0 * math.cos(a) + 0.05 * nx / l; zz = zb + Hd * math.sin(a) + 0.05 * nz / l; pts.append((rr * math.cos(t), rr * math.sin(t), zz))
        for a, b in zip(pts, pts[1:]): _beam(F, a, b, 0.07, 0.05, "gold")
    _lathe(F, 0, 0, [(0.42, zb + Hd * 0.93), (0.42, zb + Hd + 0.08), (0.12, zb + Hd + 0.12), (0.03, zb + Hd + 0.55), (0, zb + Hd + 0.62)], 8, "gold")
    _occ(occ, x, y, 2.6)

# ---------------------------------------------------------------- 5. small street furniture
def bin(x, y, z, occ=None):
    """Round litter bin, 0.95 m, white body with a gold band and dark lid (~44 tris)."""
    F = _F(x, y, z)
    _lathe(F, 0, 0, [(0.24, 0), (0.27, 0.62)], 8, "white"); _lathe(F, 0, 0, [(0.27, 0.62), (0.27, 0.7)], 8, "gold")
    _lathe(F, 0, 0, [(0.27, 0.7), (0.28, 0.9), (0.1, 0.96)], 8, "alu_dk")
    _disc(F, 0, 0, 0.1, 0.96, 8, "black")
    _occ(occ, x, y, 0.4)
def bollard(x, y, z, occ=None):
    """Marble-white bollard with a warm LED collar and gold cap (~40 tris)."""
    F = _F(x, y, z)
    _lathe(F, 0, 0, [(0.11, 0), (0.1, 0.7)], 8, "marble"); _lathe(F, 0, 0, [(0.1, 0.7), (0.1, 0.8)], 8, "led_warm")
    _lathe(F, 0, 0, [(0.1, 0.8), (0.115, 0.82), (0.0, 0.9)], 8, "gold")
    _occ(occ, x, y, 0.25)
LOUNGER_COLS = ["cream", "teal", "terra", "navy", "white", "sand"]
def lounger(x, y, z, heading, rng, cushion=None, occ=None):
    """Beach sun lounger 2.0 x 0.7 m, white frame, raised backrest at the rear (-heading) end (~80 tris)."""
    F = _F(x, y, z, heading); cc = cushion or rng.choice(LOUNGER_COLS); w = 0.33
    for sd in (1, -1): _beam(F, (-0.35, sd * w, 0.3), (1.0, sd * w, 0.3), 0.05, 0.06, "white")
    for lx in (-0.3, 0.92):
        for sd in (1, -1): _box(F, "white", lx - 0.03, lx + 0.03, sd * w - 0.03, sd * w + 0.03, 0, 0.27)
    _box(F, cc, -0.30, 1.0, -w + 0.02, w - 0.02, 0.33, 0.43)
    b1, bt = -0.98, 0.95; H, T = (-0.33, 0.38), (b1, bt); dx, dz = T[0] - H[0], T[1] - H[1]; l = math.hypot(dx, dz); nx, nz = dz / l * 0.05, -dx / l * 0.05
    if nz < 0: nx, nz = -nx, -nz                                                      # thickness normal points forward-up
    P = [(c[0] + sg * nx, yy, c[1] + sg * nz) for c in (H, T) for sg, yy in ((-1, -w + 0.02), (-1, w - 0.02), (1, w - 0.02), (1, -w + 0.02))]
    _hexa(F, cc, P)
    for sd in (1, -1): _beam(F, (-0.32, sd * w, 0.3), (b1 + 0.05, sd * w, bt - 0.08), 0.05, 0.05, "white")
    _occ(occ, x, y, 1.1)
