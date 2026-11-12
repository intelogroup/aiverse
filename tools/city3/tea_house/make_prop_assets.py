#!/usr/bin/env python3
"""Furniture assets for bridge_tea_props.py. usage: make_prop_assets.py <polyhaven/models dir> <decimated glb dir (prep_props.py)>
Copies the decimated GLBs and builds 512 px JPEG colour (+ normal for the hero pieces) from the Poly Haven 1K textures."""
import json, os, shutil, sys
from PIL import Image
SRC, DEC = sys.argv[1], sys.argv[2]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "tea-props")
NORMALS = {"chinese_screen_panels", "chinese_cabinet", "chinese_commode", "chinese_tea_table", "chinese_stool", "chinese_armchair", "chinese_sofa", "chinese_console_table", "wooden_bookshelf_worn"}
os.makedirs(OUT, exist_ok=True)
_mp = os.path.join(OUT, "meta.json"); meta = json.load(open(_mp)) if os.path.exists(_mp) else {}  # merge: waves add to the library
auth = {a: v for a, v in json.load(open(os.path.join(DEC, "report.json"))).items()}
for pid in auth:
    j = json.load(open([os.path.join(SRC, pid, f) for f in os.listdir(os.path.join(SRC, pid)) if f.endswith(".gltf")][0]))
    shutil.copy(os.path.join(DEC, pid + ".glb"), os.path.join(OUT, pid + ".glb")); mats = {}
    for m in j["materials"]:
        def img(t):
            return os.path.join(SRC, pid, j["images"][j["textures"][t["index"]]["source"]]["uri"])
        c = img(m["pbrMetallicRoughness"]["baseColorTexture"]); cf = f"{pid}__{m['name']}_c.jpg"
        Image.open(c).convert("RGB").resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, cf), quality=84, optimize=True)
        e = {"color": cf, "normal": None, "doubleSided": bool(m.get("doubleSided"))}
        if pid in NORMALS and "normalTexture" in m:
            nf = f"{pid}__{m['name']}_n.jpg"
            Image.open(img(m["normalTexture"])).convert("RGB").resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, nf), quality=88, optimize=True)
            e["normal"] = nf
        mats[m["name"]] = e
    meta[pid] = {"source": f"https://polyhaven.com/a/{pid}", "license": "CC0", "materials": mats, "tris": auth[pid]["after"]}
json.dump(meta, open(os.path.join(OUT, "meta.json"), "w"), indent=1)
print(sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT)) // 1024, "KB")
