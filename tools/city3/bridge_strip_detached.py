#!/usr/bin/env python3
"""Strip what the demolition passes left in world-city3.glb but out of the scene, keeping the file layout the bridge scripts read.

Demolitions take buildings out of the scene and leave their nodes, meshes and textures in the file (about two thirds of it by 2026-11-24, pushing it
toward GitHub's 100 MiB file limit). gltf-transform's prune would drop them but repacks accessors into shared meshopt views, which bridge_wave1.Glb
cannot read. So this keeps every index stable and only empties the dead parts: meshes no scene node uses get one 3-vertex placeholder primitive,
detached nodes lose their mesh and instancing, images no live material samples become a 1x1 PNG. bridge_compact.py --drop-dead then drops the bytes.
Visible content is unchanged (gate: verify_tiles.mjs against tiles built before the strip).
  python3 tools/city3/bridge_strip_detached.py IN.glb OUT.glb && python3 tools/city3/bridge_compact.py OUT.glb OUT2.glb --drop-dead
"""
import io
import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
from PIL import Image
from bridge_landscape_kit import add_accessor, add_view
from bridge_wave1 import Glb, save_glb


def textures_in(obj, out):
    """every texture index a material (or its extensions) samples"""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k.endswith("Texture") and isinstance(v, dict) and "index" in v:
                out.add(v["index"])
            textures_in(v, out)
    elif isinstance(obj, list):
        for v in obj:
            textures_in(v, out)
    return out


def strip(src, dst):
    g = Glb(src); j = g.gltf; nodes = j["nodes"]
    live = set()
    def walk(i):
        live.add(i); [walk(c) for c in nodes[i].get("children", [])]
    for s in j["scenes"]:
        for i in s["nodes"]:
            walk(i)
    live_meshes = {nodes[i]["mesh"] for i in live if "mesh" in nodes[i]}
    for i, n in enumerate(nodes):
        if i not in live:
            n.pop("mesh", None)
            if "extensions" in n:
                n["extensions"].pop("EXT_mesh_gpu_instancing", None)
    # one shared placeholder primitive for every dead mesh (a mesh must keep at least one primitive)
    pos = struct.pack("<9f", 0, 0, 0, 0, 0, 0, 0, 0, 0)
    pa = add_accessor(g, add_view(g, pos, 34962), 5126, 3, "VEC3", [0, 0, 0], [0, 0, 0])
    dead = 0
    for mi, m in enumerate(j["meshes"]):
        if mi not in live_meshes:
            m["primitives"] = [{"attributes": {"POSITION": pa}, "mode": 4}]; m.pop("weights", None); dead += 1
    live_mats = {p["material"] for mi in live_meshes for p in j["meshes"][mi]["primitives"] if "material" in p}
    live_tex = set()
    for mi in live_mats:
        textures_in(j["materials"][mi], live_tex)
    live_img = set()
    for ti in live_tex:
        t = j["textures"][ti]
        if "source" in t:
            live_img.add(t["source"])
        for e in t.get("extensions", {}).values():
            if "source" in e:
                live_img.add(e["source"])
    b = io.BytesIO(); Image.new("RGB", (1, 1), (128, 128, 128)).save(b, "PNG")
    tiny = add_view(g, b.getvalue(), None); j["bufferViews"][tiny].pop("target")
    blanked = 0
    for ii, im in enumerate(j.get("images", [])):
        if ii not in live_img and "bufferView" in im:
            im["bufferView"] = tiny; im["mimeType"] = "image/png"; blanked += 1
    print(json.dumps({"live_nodes": len(live), "dead_meshes": dead, "live_materials": len(live_mats), "blanked_images": blanked}))
    print("wrote", dst, save_glb(dst, j, g.bin), "bytes")


if __name__ == "__main__":
    strip(*sys.argv[1:3])
