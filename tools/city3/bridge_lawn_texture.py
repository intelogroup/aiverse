#!/usr/bin/env python3
"""Give the yard and garden lawns a real grass texture.

The lawns bridge_garden_block.py lays (materials Bz<Block>_grass) are flat colour, which reads as pale felt next to the prebuilt houses. Poly Haven's
"Leafy Grass" (CC0, polyhaven.com/a/leafy_grass) 1k colour + normal maps are embedded once and shared by every Bz*_grass material, tinted toward lawn green (the scan is a dry, leafy brown-green) and tiled every 2 m
(the lawn UVs run one unit per 4 m, so KHR_texture_transform scale 2). Idempotent (extras mark).
  python3 tools/city3/bridge_lawn_texture.py [world.glb] [--dry-run]
"""
import argparse
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
from bridge_landscape_kit import add_view
from bridge_wave1 import Glb, save_glb

MARK = "lawn_texture_pass"
CACHE = os.path.expanduser("~/Developer/city3-downloads/polyhaven/leafy_grass")
URLS = {"diff": "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/leafy_grass/leafy_grass_diff_1k.jpg",
        "nor": "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/leafy_grass/leafy_grass_nor_gl_1k.jpg"}


def fetch(kind):
    os.makedirs(CACHE, exist_ok=True); p = os.path.join(CACHE, kind + ".jpg")
    if not os.path.exists(p):
        open(p, "wb").write(urllib.request.urlopen(urllib.request.Request(URLS[kind], headers={"User-Agent": "aiverse-city3-builder/1.0"}), timeout=60).read())
    return open(p, "rb").read()


def run(path, dry):
    g = Glb(path); j = g.gltf
    if j.get("extras", {}).get(MARK):
        print({"already": True}); return
    mats = [m for m in j["materials"] if m.get("name", "").startswith("Bz") and m["name"].endswith("_grass")]
    print({"lawn_materials": [m["name"] for m in mats]})
    if dry or not mats:
        return
    j.setdefault("samplers", []).append({"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}); smp = len(j["samplers"]) - 1
    tex = {}
    for kind in ("diff", "nor"):
        v = add_view(g, fetch(kind), None); j["bufferViews"][v].pop("target")   # image views carry no target
        j.setdefault("images", []).append({"name": f"leafy_grass_{kind}", "mimeType": "image/jpeg", "bufferView": v})
        j.setdefault("textures", []).append({"sampler": smp, "source": len(j["images"]) - 1}); tex[kind] = len(j["textures"]) - 1
    tt = {"KHR_texture_transform": {"scale": [2.0, 2.0]}}
    for m in mats:
        m["pbrMetallicRoughness"] = {"baseColorTexture": {"index": tex["diff"], "extensions": tt}, "baseColorFactor": [0.6, 1.0, 0.5, 1.0], "metallicFactor": 0.0, "roughnessFactor": 0.95}
        m["normalTexture"] = {"index": tex["nor"], "scale": 0.8, "extensions": tt}
    if "KHR_texture_transform" not in j.get("extensionsUsed", []):
        j.setdefault("extensionsUsed", []).append("KHR_texture_transform")
    j.setdefault("extras", {})[MARK] = True
    print("wrote", path, save_glb(path, j, g.bin), "bytes")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("world", nargs="?", default="apps/console/public/assets/world-city3.glb"); ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(); run(a.world, a.dry_run)
