#!/usr/bin/env python3
"""Vendor one single-material Sketchfab glTF into assets/townhouses/<slug>/ and register it in manifest.json (the loader of bridge_citadel_townhouses.py).

  python3 tools/city3/vendor_sketchfab.py SRC_DIR SLUG UID "Name [Country]" AUTHOR ROLE
SRC_DIR is the unzipped `gltf` download (scene.gltf, scene.bin, license.txt, textures/). Keeps the geometry and the base-colour texture only (JPEG, or PNG when it has
a cutout alpha); far_color is the texture's mean in linear light, used as the flat far-view colour (split_lod.mjs). ROLE: hall | prop (kept out of the citadel pool).
Credits (ASSETS.md, out/asset-credits.json) are added by hand in the same commit.
"""
import json
import os
import shutil
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))


def main(src, slug, uid, name, author, role):
    g = json.load(open(src + "/scene.gltf"))
    assert len(g["materials"]) == 1, "single-material models only"
    out = f"{HERE}/assets/townhouses/{slug}"
    os.makedirs(out, exist_ok=True)
    bc = g["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]["index"]
    uri = g["images"][g["textures"][bc]["source"]]["uri"]
    im = Image.open(f"{src}/{uri}")
    im.thumbnail((2048, 2048), Image.LANCZOS)   # a 4k texture on a prop is megabytes the far view and phones pay for
    a = np.array(im.convert("RGBA")).astype(float)
    alpha = bool((a[..., 3] < 250).any())
    tex = "diffuse.png" if alpha else "diffuse.jpg"
    (im.convert("RGBA").save(f"{out}/{tex}", optimize=True) if alpha else im.convert("RGB").save(f"{out}/{tex}", quality=88, optimize=True))
    w = a[..., 3] > 128
    far = [round(float(x), 3) for x in (a[w][:, :3] / 255.0).mean(0) ** 2.2]
    shutil.copy(src + "/scene.bin", out + "/scene.bin")
    shutil.copy(src + "/license.txt", out + "/license.txt")
    g["images"] = [{"uri": tex}]
    g["textures"] = [{"source": 0}]
    m = g["materials"][0]
    m["pbrMetallicRoughness"]["baseColorTexture"] = {"index": 0}
    for k in ("normalTexture", "occlusionTexture", "emissiveTexture"):
        m.pop(k, None)
    m["pbrMetallicRoughness"].pop("metallicRoughnessTexture", None)
    json.dump(g, open(out + "/scene.gltf", "w"))
    mp = f"{HERE}/assets/townhouses/manifest.json"
    old = {e["slug"]: e for e in json.load(open(mp))}.get(slug, {})
    man = [e for e in json.load(open(mp)) if e["slug"] != slug]
    man.append({**({"unit": old["unit"]} if "unit" in old else {}), "slug": slug, "name": name, "author": author, "source": f"https://sketchfab.com/3d-models/{uid}", "license": "CC-BY-4.0", "texture": tex,
                "alpha_cutoff": m.get("alphaCutoff", 0.5) if alpha else None, "far_color": far, "role": role})
    json.dump(man, open(mp, "w"), indent=1)
    print(slug, tex, "alpha" if alpha else "opaque", far, os.path.getsize(f"{out}/{tex}") // 1024, "KB")


if __name__ == "__main__":
    main(*sys.argv[1:7])
