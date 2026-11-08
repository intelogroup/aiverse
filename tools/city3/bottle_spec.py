"""Bottle decoration spec — the single source for the library bottles' glass,
liquid, label and cork treatment.

Pure Python (no bpy): imported by the generator (rooms.py, inside Blender)
and by bridge_decorate_library.py (outside Blender) so both executors build
the SAME decoration from the SAME tables. Geometry helpers return raw
vertex/face/uv lists in Blender space (Z up, bottle origin at bottom centre,
front = -Y, the kit convention); each executor converts to its own format.

Profiles are NOT baked here: both executors measure the real bottle mesh at
runtime (radius per height) and derive liquid/label/cork geometry from it.
"""
import hashlib, math

# ---------------------------------------------------------------------------
# Families: glass alpha (Blender Principled Alpha / glTF baseColorFactor a),
# liquid colour (linear rgb), label copy.
FAMILIES = {
    "wine":   {"glass_alpha": 0.50, "liquid": (0.145, 0.010, 0.022),
               "label_name": "PLUM WINE",    "label_sub": "Sunstone Reserve"},
    "amber":  {"glass_alpha": 0.55, "liquid": (0.280, 0.100, 0.014),
               "label_name": "BITTER TONIC", "label_sub": "Bazaar Blend No. 3"},
    "green":  {"glass_alpha": 0.52, "liquid": (0.028, 0.125, 0.040),
               "label_name": "HERBAL SYRUP", "label_sub": "Terraces Botanicals"},
    "clear":  {"glass_alpha": 0.30, "liquid": (0.520, 0.380, 0.130),
               "label_name": "JASMINE SYRUP", "label_sub": "Matchmaker's Own"},
    "cobalt": {"glass_alpha": 0.52, "liquid": (0.014, 0.048, 0.270),
               "label_name": "NIGHT TONIC",  "label_sub": "Halo Distilling Co."},
}
CORK_RGB = (0.520, 0.345, 0.175)
CORK_ROUGH = 0.95
LIQUID_ROUGH = 0.35
LABEL_ROUGH = 0.85

# Per-shape label band (z0, z1 in metres, on the straight body section,
# measured from the shipped meshes) and liquid fill window (z range the
# deterministic per-variant fill is drawn from; ceiling stays below the
# shoulder on every shape).
SHAPES = {
    0: {"label": (0.030, 0.120), "fill": (0.055, 0.120)},
    1: {"label": (0.035, 0.135), "fill": (0.090, 0.185)},
    2: {"label": (0.022, 0.092), "fill": (0.040, 0.105)},
    3: {"label": (0.032, 0.122), "fill": (0.060, 0.140)},
}
LABEL_ARC = 1.92          # radians (~110 deg) of body the label wraps
LABEL_SEG = 6
LABEL_LIFT = 0.0016       # metres the label floats off the glass
LIQUID_SHRINK = 0.90      # liquid radius = glass inner profile * this
LIQUID_SEG = 12
LIQUID_BASE = 0.012       # liquid starts just above the bottle's floor

def fill_for(key, shape):
    """Deterministic per-variant fill height (same bottle, same fill, on
    every build and in every executor)."""
    lo, hi = SHAPES[shape]["fill"]
    frac = hashlib.sha1(key.encode()).digest()[0] / 255.0
    return lo + frac * (hi - lo)

def profile_from_points(points, step=0.01):
    """points: iterable of (x, y, z) in Blender space (Z up).
    Returns [(z, r_max)] sampled every `step` metres from the base. Each
    sample takes the widest vertex within +/-10 mm; a sample with no vertex
    in range falls back to the nearest populated level, so a sparse mesh
    (a slender 336-tri bottle) can never read radius 0 mid-body."""
    pts = sorted((p[2], math.hypot(p[0], p[1])) for p in points)
    if not pts: return []
    zmax = pts[-1][0]
    out = []
    z = 0.0
    while z <= zmax + 1e-9:
        cand = [r for (zz, r) in pts if abs(zz - z) <= 0.01]
        if cand:
            r = max(cand)
        else:
            z_near = min(pts, key=lambda t: abs(t[0] - z))[0]
            r = max(rr for (zzz, rr) in pts if abs(zzz - z_near) < 1e-6)
        out.append((z, r))
        z += step
    return out

def _ring(cx_verts, z, r, seg, phase=0.0):
    base = len(cx_verts)
    for k in range(seg):
        a = phase + 2 * math.pi * k / seg
        cx_verts.append((r * math.sin(a), -r * math.cos(a), z))
    return base

def liquid_geometry(profile, fill_z):
    """Inner liquid solid: rings following the (shrunk) profile up to
    fill_z, capped top and bottom. Winding: outward (CCW seen from outside).
    Returns (verts, faces); faces are index triples."""
    rings = []
    prof = [(z, r * LIQUID_SHRINK) for (z, r) in profile if LIQUID_BASE - 1e-9 <= z <= fill_z and r > 0.004]
    if not prof: return [], []
    if prof[0][0] > LIQUID_BASE: prof.insert(0, (LIQUID_BASE, prof[0][1]))
    if prof[-1][0] < fill_z: prof.append((fill_z, prof[-1][1]))
    verts = []
    for (z, r) in prof: rings.append(_ring(verts, z, r, LIQUID_SEG))
    faces = []
    for i in range(len(rings) - 1):
        a, b = rings[i], rings[i + 1]
        for k in range(LIQUID_SEG):
            k2 = (k + 1) % LIQUID_SEG
            faces.append((a + k, b + k2, b + k))
            faces.append((a + k, a + k2, b + k2))
    # bottom cap (faces down) and top cap (faces up), as fans around a centre
    cb = len(verts); verts.append((0.0, 0.0, prof[0][0]))
    ct = len(verts); verts.append((0.0, 0.0, prof[-1][0]))
    a, b = rings[0], rings[-1]
    for k in range(LIQUID_SEG):
        k2 = (k + 1) % LIQUID_SEG
        faces.append((cb, a + k, a + k2))
        faces.append((ct, b + k2, b + k))
    return verts, faces

def label_geometry(radius, z0, z1):
    """Curved label patch on the bottle front (-Y), centred, spanning
    LABEL_ARC. Returns (verts, faces, uvs); v = 0 at the TOP of the label
    (glTF UV convention; the Blender executor flips when it assigns)."""
    verts, faces, uvs = [], [], []
    r = radius + LABEL_LIFT
    for i in range(LABEL_SEG + 1):
        th = -LABEL_ARC / 2 + LABEL_ARC * i / LABEL_SEG
        x, y = r * math.sin(th), -r * math.cos(th)
        verts.append((x, y, z0)); uvs.append((i / LABEL_SEG, 1.0))
        verts.append((x, y, z1)); uvs.append((i / LABEL_SEG, 0.0))
    for i in range(LABEL_SEG):
        a = 2 * i
        faces.append((a, a + 3, a + 1))
        faces.append((a, a + 2, a + 3))
    return verts, faces, uvs

def cork_geometry(neck_r, top_z):
    """Cork plug: slight taper, sunk into the neck, proud of the lip.
    Returns (verts, faces)."""
    seg = 10
    rb, rt = neck_r * 0.94, neck_r * 0.86
    z0, z1 = top_z - 0.010, top_z + 0.017
    verts = []
    b = _ring(verts, z0, rb, seg)
    t = _ring(verts, z1, rt, seg)
    faces = []
    for k in range(seg):
        k2 = (k + 1) % seg
        faces.append((b + k, t + k2, t + k))
        faces.append((b + k, b + k2, t + k2))
    ct = len(verts); verts.append((0.0, 0.0, z1))
    for k in range(seg):
        k2 = (k + 1) % seg
        faces.append((ct, t + k, t + k2))
    return verts, faces

# ---------------------------------------------------------------------------
# Label art (PIL; sRGB). One 256x128 image per family.
def make_label_png(family):
    from PIL import Image, ImageDraw, ImageFont
    import io, random
    W, H = 256, 128
    rnd = random.Random(hashlib.sha1(family.encode()).digest()[0])
    img = Image.new("RGB", (W, H), (216, 196, 154))
    px = img.load()
    for _ in range(2600):  # aged-paper speckle
        x, y = rnd.randrange(W), rnd.randrange(H)
        d = rnd.choice((-14, -9, 7, 12))
        c = px[x, y]
        px[x, y] = tuple(max(0, min(255, v + d)) for v in c)
    dr = ImageDraw.Draw(img)
    edge = (122, 88, 44)
    dr.rectangle([5, 5, W - 6, H - 6], outline=edge, width=3)
    dr.rectangle([11, 11, W - 12, H - 12], outline=edge, width=1)
    def font(size, bold=True):
        names = ["/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
                 "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"]
        for n in names:
            try: return ImageFont.truetype(n, size)
            except Exception: pass
        return ImageFont.load_default()
    ink = (74, 48, 22)
    name = FAMILIES[family]["label_name"]
    sub = FAMILIES[family]["label_sub"]
    f1 = font(30 if len(name) <= 12 else 26)
    f2 = font(15)
    # ornament: diamond + rules above the name
    cx = W // 2
    dr.polygon([(cx, 24), (cx + 7, 31), (cx, 38), (cx - 7, 31)], outline=edge, width=2)
    dr.line([26, 31, cx - 14, 31], fill=edge, width=1)
    dr.line([cx + 14, 31, W - 26, 31], fill=edge, width=1)
    w1 = dr.textlength(name, font=f1)
    dr.text(((W - w1) / 2, 44), name, font=f1, fill=ink)
    w2 = dr.textlength(sub, font=f2)
    dr.text(((W - w2) / 2, 84), sub, font=f2, fill=(104, 74, 38))
    buf = io.BytesIO(); img.save(buf, "PNG")
    return buf.getvalue()
