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
