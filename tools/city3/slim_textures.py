#!/usr/bin/env python3
"""Shrink the textures inside a GLB, geometry untouched: every image is capped at MAX px on its long side (power-of-two sizes stay
power of two) and opaque images become JPEG q85; images with real alpha stay PNG. Run on a downloaded house before place_house.mjs.
  python3 tools/city3/slim_textures.py in.glb out.glb [--max 2048]
  python3 tools/city3/slim_textures.py --selftest
"""
import argparse
import io
import json
import struct

from PIL import Image


def slim_image(raw, cap):
    img = Image.open(io.BytesIO(raw)); img.load()
    w, h = img.size
    if max(w, h) > cap:
        k = cap / max(w, h); img = img.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS)
    opaque = img.mode in ("RGB", "L", "P") and "transparency" not in img.info or (img.mode in ("RGBA", "LA") and img.getchannel("A").getextrema()[0] >= 250)
    b = io.BytesIO()
    if opaque:
        img.convert("RGB").save(b, "JPEG", quality=85); return b.getvalue(), "image/jpeg"
    img.save(b, "PNG", optimize=True); return b.getvalue(), "image/png"


def slim(src, dst, cap):
    d = open(src, "rb").read(); jl = struct.unpack("<I", d[12:16])[0]; j = json.loads(d[20:20 + jl])
    off = 20 + jl; bl = struct.unpack("<I", d[off:off + 4])[0]; bin_ = d[off + 8:off + 8 + bl]
    views = j["bufferViews"]; new = {}
    for im in j.get("images", []):
        if "bufferView" not in im:
            continue
        v = views[im["bufferView"]]; raw = bin_[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]]
        data, mime = slim_image(raw, cap)
        if len(data) < len(raw):
            new[im["bufferView"]] = data; im["mimeType"] = mime
    out = bytearray()
    for i, v in enumerate(views):
        data = new.get(i, bin_[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]])
        while len(out) % 4:
            out.append(0)
        v["byteOffset"] = len(out); v["byteLength"] = len(data); out += data
    while len(out) % 4:
        out.append(0)
    j["buffers"][0]["byteLength"] = len(out); js = json.dumps(j, separators=(",", ":")).encode()
    while len(js) % 4:
        js += b" "
    open(dst, "wb").write(b"glTF" + struct.pack("<II", 2, 12 + 8 + len(js) + 8 + len(out)) + struct.pack("<I", len(js)) + b"JSON" + js + struct.pack("<I", len(out)) + b"BIN\0" + bytes(out))
    print(f"{src.split('/')[-2] if '/' in src else src}: {len(new)} of {len(j.get('images', []))} images slimmed, {len(d) // 1048576} -> {(len(out) + len(js)) // 1048576} MB")


def selftest():
    b = io.BytesIO(); Image.new("RGB", (4096, 2048), (200, 10, 10)).save(b, "PNG")
    data, mime = slim_image(b.getvalue(), 2048)
    im = Image.open(io.BytesIO(data)); assert im.size == (2048, 1024) and mime == "image/jpeg", (im.size, mime)
    b = io.BytesIO(); a = Image.new("RGBA", (64, 64), (0, 0, 0, 0)); a.save(b, "PNG")
    data, mime = slim_image(b.getvalue(), 2048); assert mime == "image/png"
    print("selftest ok")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("src", nargs="?"); ap.add_argument("dst", nargs="?"); ap.add_argument("--max", type=int, default=2048); ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    selftest() if a.selftest else slim(a.src, a.dst, a.max)
