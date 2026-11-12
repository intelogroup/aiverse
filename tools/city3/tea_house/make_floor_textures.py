#!/usr/bin/env python3
"""Tea House floor textures: Poly Haven CC0 1K sources -> small JPEGs (colour + GL normal).
usage: make_floor_textures.py <dir with polyhaven/tex/<id>/<id>_{diff,nor}_1k.jpg>
Writes tools/city3/assets/tea-floors/<id>_c.jpg, <id>_n.jpg and sources.json (licence, author, tile size in metres)."""
import json, os, sys
from PIL import Image
SRC = sys.argv[1]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "tea-floors")
# id: (px, tile metres, authors)
TEX = {
 "hinoki_planks": (512, 1.9, "Charlotte Baglioni"),
 "oak_wood_planks": (512, 1.2, "Dimitrios Savva"),
 "herringbone_parquet": (1024, 2.4, "Jenelle van Heerden, Sergej Majboroda"),
 "tatami_mat": (512, 1.8, "Charlotte Baglioni"),
 "wooden_floor_02": (512, 1.9, "Charlotte Baglioni, Rico Cilliers"),
 "laminate_floor_02": (512, 1.7, "Dario Barresi, Charlotte Baglioni"),
 "interior_tiles": (512, 1.9, "Charlotte Baglioni"),
 "floor_tiles_06": (512, 2.0, "Rob Tuytel"),
 "patterned_terracotta_tiling": (512, 2.15, "Amal Kumar"),
 "marble_mosaic_tiles": (512, 2.0, "Amal Kumar"),
 "stair_planks": (512, 1.2, "Rob Tuytel"),
}
os.makedirs(OUT, exist_ok=True)
meta = {}
for k, (px, tile, auth) in TEX.items():
    for suf, name, q in (("diff", "c", 84), ("nor", "n", 88)):
        im = Image.open(os.path.join(SRC, "polyhaven", "tex", k, f"{k}_{suf}_1k.jpg")).convert("RGB").resize((px, px), Image.LANCZOS)
        im.save(os.path.join(OUT, f"{k}_{name}.jpg"), quality=q, optimize=True)
    meta[k] = {"source": f"https://polyhaven.com/a/{k}", "license": "CC0", "author": auth, "tileMetres": tile, "px": px}
json.dump(meta, open(os.path.join(OUT, "sources.json"), "w"), indent=2)
print(sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT)) // 1024, "KB")
