"""Halo Lagoon texture variants (plain Python + PIL/numpy): tinted copies of existing tex_m sets so the island reads pale peach
and the curtain glass turquoise, as in the concept. Writes tex_m/halo_*.jpg. Run after mtex.py, before halo.py."""
import os, shutil
import numpy as np
from PIL import Image
T = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tex_m")
def tint(src, dst, target, q=90, gamma=1.0):
    a = np.asarray(Image.open(f"{T}/{src}.jpg").convert("RGB"), float) / 255.0
    a = a ** gamma; m = a.reshape(-1, 3).mean(0); a = np.clip(a * (np.array(target) / 255.0) / m, 0, 1)
    Image.fromarray((a * 255 + 0.5).astype(np.uint8)).save(f"{T}/{dst}.jpg", quality=q); print(dst, (a.reshape(-1, 3).mean(0) * 255).round())
tint("plaza_herring_d", "halo_pave_d", (214, 182, 152)); shutil.copy(f"{T}/plaza_herring_n.jpg", f"{T}/halo_pave_n.jpg")
tint("terrazzo_d", "halo_terrazzo_d", (226, 216, 202)); shutil.copy(f"{T}/terrazzo_n.jpg", f"{T}/halo_terrazzo_n.jpg")
tint("glass_atlas", "halo_glass", (70, 142, 158), gamma=0.85)

# ---- foliage atlas (RGBA png, alpha-clipped in the GLB). Rows top->bottom (v from the top):
#  0: palm frond green, 1: palm frond sunlit yellow-green, 2: burgundy cordyline frond, 3: four flower-clump tiles (pink, white, yellow, lilac).
# Frond source: BlendSwap #5812 "Palm Tree Cycles Ready" by SSimpossible (CC0): PalmFrondDiffuse.png + PalmFrondAlpha.png.
A = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "blendswap", "palm_5812")
def frond_rows():
    d = np.asarray(Image.open(f"{A}/PalmFrondDiffuse.png").convert("RGB"), float) / 255.0; al = np.asarray(Image.open(f"{A}/PalmFrondAlpha.png").convert("L"), float) / 255.0
    ys, xs = np.where(al > 0.5); y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    d = d[y0:y1, x0:x1]; al = al[y0:y1, x0:x1]
    # un-premultiply: the diffuse fades to black where the alpha fades, which would give dark fringes after clipping
    lum = d.mean(2, keepdims=True); d = np.where(al[..., None] > 0.05, d / np.maximum(lum, 0.06) * np.clip(lum, 0.18, 1.0) ** 0.6, d)
    rgba = lambda c, tint: Image.fromarray((np.dstack([np.clip(c * tint, 0, 1), al]) * 255).astype(np.uint8), "RGBA").resize((1024, 256), Image.LANCZOS)
    g = d.mean(2, keepdims=True); d = d * 0.55 + g * 0.45                                    # desaturate the neon source
    return [rgba(d, (0.62, 0.8, 0.5)), rgba(d, (0.92, 0.95, 0.5)), rgba(g * np.array([1.0, 0.3, 0.38]), (1, 1, 1))]
def flower_tile(petal, rng):
    im = Image.new("RGBA", (256, 256), (0, 0, 0, 0)); from PIL import ImageDraw; dr = ImageDraw.Draw(im)
    for _ in range(260):                                           # leaf mass: a dome of dark-green ellipses
        x = np.clip(rng.normal(128, 46), 16, 240); y = 256 - min(abs(rng.normal(0, 60)), 200) - 10; r = rng.uniform(6, 13); g = rng.uniform(0.6, 1.0)
        dr.ellipse([x - r, y - r * 0.6, x + r, y + r * 0.6], fill=(int(40 * g), int(105 * g), int(38 * g), 255))
    for _ in range(170):                                           # blossoms on the upper surface
        x = np.clip(rng.normal(128, 42), 20, 236); y = 256 - min(abs(rng.normal(0, 55)), 190) - 22; r = rng.uniform(3.5, 7); k = rng.uniform(0.82, 1.08)
        dr.ellipse([x - r, y - r, x + r, y + r], fill=tuple(int(min(255, c * k)) for c in petal) + (255,))
    return im
atlas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
for i, row in enumerate(frond_rows()): atlas.paste(row, (0, i * 256))
rng = np.random.default_rng(7)
for j, col in enumerate(((236, 86, 150), (246, 242, 232), (250, 204, 64), (176, 132, 222))): atlas.paste(flower_tile(col, rng), (j * 256, 768))
atlas.save(f"{T}/halo_foliage.png"); print("halo_foliage.png", atlas.size)
# palm trunk bark: Poly Haven palm_tree_bark (CC0), 512 px
Image.open(os.path.join(os.path.dirname(T), "assets", "ptex", "palm_tree_bark", "d.jpg")).convert("RGB").resize((512, 512), Image.LANCZOS).save(f"{T}/halo_bark.jpg", quality=88)
