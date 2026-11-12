#!/usr/bin/env python3
"""Tea House surface wave 2, patched onto the shipped world-city3.glb (run after bridge_tea_surfaces.py / bridge_tea_props.py).
Swaps the colour (+ normal) texture on selected Tea House materials, keeping each material's per-floor tint:
  wainscot / panel fields -> Poly Haven CC0 wooden_panels; bar front -> rosewood_veneer1; restroom wall tile -> long_white_tiles.
Each swap sets a KHR_texture_transform scale so the new texture keeps its real-world size (old tile / new tile metres).
  python3 tools/city3/bridge_tea_wave2.py [--glb ...] [--dry-run]"""
import argparse, json, os, sys
sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from bridge_landscape_kit import add_view
from bridge_wave1 import Glb, save_glb
TEX = os.path.join(HERE, "assets", "tea-floors")
# material -> (new texture id, old tile metres, lift factor so a dark tint does not turn the new texture black)
SWAPS = {"L1_wainscot": ("wooden_panels", 1.0, 2.2), "L2_wainscot": ("wooden_panels", 1.0, 2.2), "L3_wainscot": ("wooden_panels", 1.0, 2.2),
         "L1_panel_inset": ("wooden_panels", 1.0, 1.6), "L2_panel_inset": ("wooden_panels", 1.0, 1.6),
         "G_bar_walnut": ("rosewood_veneer1", 1.0, 2.0), "TeaRestroom_wallTile": ("long_white_tiles", 1.27, 1.0)}


def run(path, dry):
    g = Glb(path); j = g.gltf
    if any(i.get("name") == "tea_wooden_panels_c" for i in j["images"]): sys.exit("already patched")
    meta = json.load(open(os.path.join(TEX, "sources.json"))); cache = {}; done = []

    def tex(tid):
        if tid not in cache:
            idx = []
            for suf in ("c", "n"):
                v = add_view(g, open(os.path.join(TEX, f"{tid}_{suf}.jpg"), "rb").read(), None); j["bufferViews"][v].pop("target", None)
                j["images"].append({"name": f"tea_{tid}_{suf}", "bufferView": v, "mimeType": "image/jpeg"})
                j["textures"].append({"source": len(j["images"]) - 1}); idx.append(len(j["textures"]) - 1)
            cache[tid] = idx
        return cache[tid]

    for m in j["materials"]:
        if m.get("name") not in SWAPS: continue
        tid, old, lift = SWAPS[m["name"]]; c, n = tex(tid); k = old / meta[tid]["tileMetres"]
        ext = {"KHR_texture_transform": {"scale": [k, k]}}
        pbr = m["pbrMetallicRoughness"]; f = pbr.get("baseColorFactor", [1, 1, 1, 1])
        pbr["baseColorFactor"] = [min(1.0, f[0] * lift), min(1.0, f[1] * lift), min(1.0, f[2] * lift), f[3]]
        pbr["baseColorTexture"] = {"index": c, "extensions": ext}
        m["normalTexture"] = {"index": n, "scale": 1.0, "extensions": ext}; done.append(m["name"])
    print("retextured", len(done), done)
    if dry: return
    print("wrote", path, save_glb(path, g.gltf, g.bin))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--glb", default="apps/console/public/assets/world-city3.glb"); ap.add_argument("--dry-run", action="store_true")
    run(ap.parse_args().glb, ap.parse_args().dry_run)
