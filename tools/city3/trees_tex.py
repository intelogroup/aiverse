"""Procedural leaf-cluster atlas for the Bazaar trees (system python + numpy + PIL; no downloads, nothing to license).

Writes tex_trees/tree_leaves.png: 512x512 RGBA, 2x2 tiles of 256 px, each tile ONE dense foliage patch (an irregular disc of
overlapping leaves with midribs + side veins, per-leaf tone variation, darker inner depth, a few twigs) on transparent ground.
  tile 0 (top-left)  : broad ovate leaves, neutral greens (plane / linden / lime; tinted per card with vertex colours)
  tile 1 (top-right) : lobed leaves in autumn gold/amber/rust (maple / plane in October)
  tile 2 (bottom-left): narrow lanceolate leaves, silver-olive (olive tree)
  tile 3 (bottom-right): small leaves + 5-petal blossom, pink/white (cherry / almond)
Transparent texels carry the average leaf colour so mip-mapping never darkens the cut-out edge.
usage: python3 trees_tex.py   (run from tools/city3; bark: pass --bark <path to Poly Haven bark_brown_02 d.jpg>)"""
import math, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(HERE, "tex_trees"); os.makedirs(OUT, exist_ok=True)
T = 256; SS = 3                                   # tile size, supersampling
rng = np.random.default_rng(20261106)

def leaf_poly(kind, L, W, n=22):
    """Outline of a leaf pointing along +x with base at the origin: list of (x, y)."""
    pts = []
    for i in range(n + 1):
        t = i / n
        if kind == "ovate":
            w = W * math.sin(math.pi * t ** 0.8) ** 0.9 * (1 - 0.15 * t)
        elif kind == "lance":
            w = W * math.sin(math.pi * t) ** 0.85 * (1 - 0.25 * t)
        elif kind == "lobed":                     # five-lobed (plane / maple) silhouette from a polar-ish bump function
            a = t * math.pi
            w = W * (0.55 + 0.45 * abs(math.cos(2.5 * a * 1.0))) * math.sin(math.pi * t) ** 0.6
        else:
            w = W * math.sin(math.pi * t) ** 0.8
        pts.append((L * t, w))
    return [(x, y) for x, y in pts] + [(x, -y) for x, y in reversed(pts)]

def draw_leaf(dr, cx, cy, ang, L, W, kind, col, vein):
    c, s = math.cos(ang), math.sin(ang)
    poly = [(cx + x * c - y * s, cy + x * s + y * c) for x, y in leaf_poly(kind, L, W)]
    dr.polygon(poly, fill=col)
    # half-shade (underside gets a darker lower half) for volume
    half = [(cx + x * c - y * s, cy + x * s + y * c) for x, y in leaf_poly(kind, L, W)[len(poly) // 2:]]
    sh = tuple(int(v * 0.82) for v in col[:3]) + (255,)
    dr.polygon([(cx, cy)] + half, fill=sh)
    ex, ey = cx + L * 0.92 * c, cy + L * 0.92 * s
    dr.line([(cx, cy), (ex, ey)], fill=vein, width=max(1, int(L * 0.045)))            # midrib
    for k in range(1, 5 if kind != "lance" else 4):
        t = k / 5.2; bx, by = cx + L * t * c, cy + L * t * s
        for sg in (1, -1):
            a2 = ang + sg * 0.85; l2 = W * (1.0 - 0.15 * k) * (0.9 if kind != "lance" else 0.7)
            dr.line([(bx, by), (bx + l2 * math.cos(a2), by + l2 * math.sin(a2))], fill=vein, width=max(1, int(L * 0.02)))

def tone(base, k):
    return tuple(int(np.clip(v * k, 0, 255)) for v in base)

def patch(kind, palette, n, Lr, Wr, ratio, seed, vein_mul=1.35, flowers=None, twig=True):
    """One tile: leaves scattered in an irregular disc, drawn inner-first (inner leaves darker = depth)."""
    r = np.random.default_rng(seed); S = T * SS
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0)); dr = ImageDraw.Draw(im)
    cx0 = cy0 = S / 2
    if twig:
        for _ in range(7):
            a = r.uniform(0, 2 * math.pi); d = r.uniform(0.18, 0.4) * S
            dr.line([(cx0, cy0), (cx0 + d * math.cos(a), cy0 + d * math.sin(a))], fill=(70, 52, 34, 255), width=int(S * 0.008))
    pts = []
    for i in range(n):
        a = r.uniform(0, 2 * math.pi); rr = (r.random() ** 0.62) * 0.37 * S * (0.82 + 0.18 * math.sin(3 * a + seed) )
        pts.append((rr, a))
    pts.sort(key=lambda p: p[0])
    for rr, a in pts:
        x, y = cx0 + rr * math.cos(a), cy0 + rr * math.sin(a)
        depth = 0.62 + 0.38 * min(1.0, rr / (0.34 * S))                              # AO: centre darker, rim lit
        base = palette[int(r.integers(len(palette)))]; k = depth * r.uniform(0.88, 1.1)
        col = tone(base, k) + (255,); vein = tone(base, k * vein_mul) + (255,)
        ang = a + r.normal(0, 0.9) if r.random() < 0.7 else r.uniform(0, 2 * math.pi)
        L = S * Lr * r.uniform(0.75, 1.2); W = L * ratio * r.uniform(0.85, 1.1)
        draw_leaf(dr, x, y, ang, L, W, kind, col, vein)
        if flowers and r.random() < flowers[0]:
            fx, fy = x + r.normal(0, L * 0.4), y + r.normal(0, L * 0.4); fr = S * flowers[1] * r.uniform(0.8, 1.2)
            fc = flowers[2][int(r.integers(len(flowers[2])))]
            for p in range(5):
                pa = ang + 2 * math.pi * p / 5
                px, py = fx + fr * 0.55 * math.cos(pa), fy + fr * 0.55 * math.sin(pa)
                dr.ellipse([px - fr * 0.5, py - fr * 0.5, px + fr * 0.5, py + fr * 0.5], fill=fc + (255,))
            dr.ellipse([fx - fr * 0.22, fy - fr * 0.22, fx + fr * 0.22, fy + fr * 0.22], fill=(236, 190, 90, 255))
    im = im.resize((T, T), Image.LANCZOS)
    a = np.array(im).astype(np.float32); al = a[..., 3] / 255.0
    avg = (a[..., :3] * al[..., None]).sum((0, 1)) / max(al.sum(), 1)
    a[..., :3] = np.where(al[..., None] > 0.02, a[..., :3] / np.maximum(al[..., None], 0.02), avg)   # un-premultiply the LANCZOS edge, bleed average
    a[..., 3] = np.where(al > 0.5, 255, 0)                                                            # hard cut-out (alphaMode MASK)
    return np.clip(a, 0, 255).astype(np.uint8)

greens = [(70, 120, 40), (88, 142, 46), (56, 104, 38), (104, 150, 52), (76, 128, 62)]
gold = [(214, 160, 40), (226, 126, 34), (196, 98, 32), (232, 184, 58), (170, 120, 36)]
olive = [(128, 150, 96), (148, 168, 120), (104, 128, 80), (170, 184, 142), (118, 140, 92)]
bloom_leaf = [(86, 132, 62), (104, 150, 70), (72, 118, 56)]
tiles = [patch("ovate", greens, 170, 0.12, 0.5, 0.45, 1),
         patch("lobed", gold, 170, 0.11, 0.5, 0.5, 2),
         patch("lance", olive, 420, 0.13, 0.5, 0.17, 3, vein_mul=1.15),
         patch("ovate", bloom_leaf, 100, 0.09, 0.5, 0.45, 4, flowers=(0.55, 0.05, [(244, 170, 196), (250, 214, 224), (236, 140, 176)]))]
atlas = np.zeros((2 * T, 2 * T, 4), np.uint8)
for i, t in enumerate(tiles):
    c, r_ = i % 2, i // 2; atlas[r_ * T:(r_ + 1) * T, c * T:(c + 1) * T] = t
Image.fromarray(atlas, "RGBA").save(os.path.join(OUT, "tree_leaves.png"), optimize=True)
print("leaves", os.path.getsize(os.path.join(OUT, "tree_leaves.png")) // 1024, "KB")
if "--bark" in sys.argv:
    src = sys.argv[sys.argv.index("--bark") + 1]
    Image.open(src).convert("RGB").resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "tree_bark.jpg"), quality=82)
    print("bark", os.path.getsize(os.path.join(OUT, "tree_bark.jpg")) // 1024, "KB")
