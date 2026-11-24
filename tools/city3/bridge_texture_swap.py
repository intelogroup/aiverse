#!/usr/bin/env python3
"""Swap the colour and normal maps of one world material for a Poly Haven (CC0) texture, keeping its UVs and KHR_texture_transform.

  python3 tools/city3/bridge_texture_swap.py MATERIAL POLYHAVEN_ID [--res 2k] [--tint r,g,b] [world.glb]
e.g. the plaza: cobble.001 cobblestone_floor_08 (its pale cobble read as sand from walking height). Images are cached under
~/Developer/city3-downloads/polyhaven/<id>/ and embedded once; re-running with the same pair is a no-op (extras mark).
"""
import argparse
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
from bridge_landscape_kit import add_view
from bridge_wave1 import Glb, save_glb


def fetch(pid, kind, res):
    d = os.path.expanduser(f"~/Developer/city3-downloads/polyhaven/{pid}"); os.makedirs(d, exist_ok=True)
    p = os.path.join(d, f"{kind}_{res}.jpg")
    if not os.path.exists(p):
        name = {"diff": "diff", "nor": "nor_gl"}[kind]
        url = f"https://dl.polyhaven.org/file/ph-assets/Textures/jpg/{res}/{pid}/{pid}_{name}_{res}.jpg"
        open(p, "wb").write(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "aiverse-city3-builder/1.0"}), timeout=120).read())
    return open(p, "rb").read()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("material"); ap.add_argument("ph"); ap.add_argument("world", nargs="?", default="apps/console/public/assets/world-city3.glb")
    ap.add_argument("--res", default="2k"); ap.add_argument("--tint", default="1,1,1"); a = ap.parse_args()
    g = Glb(a.world); j = g.gltf; mark = j.setdefault("extras", {}).setdefault("texture_swaps", {})
    if mark.get(a.material) == a.ph:
        print({"already": True}); sys.exit(0)
    mats = [m for m in j["materials"] if m.get("name") == a.material]
    if not mats:
        raise SystemExit(f"no material named {a.material}")
    j.setdefault("samplers", []).append({"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}); smp = len(j["samplers"]) - 1
    tex = {}
    for kind in ("diff", "nor"):
        v = add_view(g, fetch(a.ph, kind, a.res), None); j["bufferViews"][v].pop("target")
        j.setdefault("images", []).append({"name": f"{a.ph}_{kind}", "mimeType": "image/jpeg", "bufferView": v})
        j.setdefault("textures", []).append({"sampler": smp, "source": len(j["images"]) - 1}); tex[kind] = len(j["textures"]) - 1
    tint = [float(x) for x in a.tint.split(",")] + [1.0]
    for m in mats:
        pb = m.setdefault("pbrMetallicRoughness", {})
        ext = (pb.get("baseColorTexture") or {}).get("extensions") or (m.get("normalTexture") or {}).get("extensions")
        pb["baseColorTexture"] = {"index": tex["diff"], **({"extensions": ext} if ext else {})}
        pb["baseColorFactor"] = tint; pb["metallicFactor"] = 0.0; pb["roughnessFactor"] = 0.9; pb.pop("metallicRoughnessTexture", None)
        m["normalTexture"] = {"index": tex["nor"], "scale": 1.0, **({"extensions": ext} if ext else {})}
    mark[a.material] = a.ph
    print(json.dumps({"material": a.material, "texture": a.ph, "materials_changed": len(mats)}))
    print("wrote", a.world, save_glb(a.world, j, g.bin), "bytes")
