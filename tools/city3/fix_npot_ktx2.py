"""KTX2 images whose width or height is not a multiple of 4 fail to upload on S3TC/BPTC GPUs
(`glTexStorage2D: ... not multiples of 4`) and render black. For each such image in the shipped GLB,
put the original JPEG/PNG (same image name in --source, a pre-KTX2 GLB) back as a plain texture.
usage: python3 fix_npot_ktx2.py --source old_jpeg.glb [--glb apps/console/public/assets/world-city3.glb]
Run bridge_compact.py afterwards (the old KTX2 bytes become dead)."""
import argparse, os, struct, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bridge_bones import Glb, save_glb
from bridge_landscape_kit import add_view

def ktx_dims(k):
    return struct.unpack("<II", k[20:28])

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True)
    ap.add_argument("--glb", default="apps/console/public/assets/world-city3.glb")
    a = ap.parse_args()
    g, src = Glb(a.glb), Glb(a.source)
    sj = src.gltf
    by_name = {im.get("name"): im for im in sj["images"]}
    fixed = []
    for i, im in enumerate(g.gltf["images"]):
        if im.get("mimeType") != "image/ktx2":
            continue
        bv = g.gltf["bufferViews"][im["bufferView"]]
        off = bv.get("byteOffset", 0)
        w, h = ktx_dims(g.bin[off:off + bv["byteLength"]])
        if w % 4 == 0 and h % 4 == 0:
            continue
        old = by_name[im["name"]]
        obv = sj["bufferViews"][old["bufferView"]]
        data = src.bin[obv.get("byteOffset", 0):][:obv["byteLength"]]
        im["bufferView"] = add_view(g, data, None)
        g.gltf["bufferViews"][im["bufferView"]].pop("target")      # image views carry no target
        im["mimeType"] = old["mimeType"]
        for t in g.gltf["textures"]:
            if t.get("source") == i:
                t.get("extensions", {}).pop("KHR_texture_basisu", None)
                if not t["extensions"]:
                    del t["extensions"]
        fixed.append((im["name"], w, h, old["mimeType"], len(data)))
    for f in fixed:
        print("restored", f)
    if fixed:
        save_glb(a.glb, g.gltf, g.bin)
    print(len(fixed), "images restored")

if __name__ == "__main__":
    main()
