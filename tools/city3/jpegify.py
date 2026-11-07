"""PNG -> JPEG for opaque images inside a GLB (alpha ones stay PNG). usage: jpegify.py in.glb out.glb"""
import json, struct, sys, io
from PIL import Image
src, dst = sys.argv[1:3]
d = open(src, "rb").read(); jl, _ = struct.unpack("<II", d[12:20]); j = json.loads(d[20:20 + jl]); off = 20 + jl; bl, _ = struct.unpack("<II", d[off:off + 8]); bin_ = d[off + 8:off + 8 + bl]
views = j["bufferViews"]; new = {}
for im in j["images"]:
    v = views[im["bufferView"]]; raw = bin_[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]]
    img = Image.open(io.BytesIO(raw))
    opaque = img.mode in ("RGB", "L") or (img.mode == "RGBA" and img.getchannel("A").getextrema()[0] >= 250)
    if opaque:
        b = io.BytesIO(); img.convert("RGB").save(b, "JPEG", quality=85); new[im["bufferView"]] = b.getvalue(); im["mimeType"] = "image/jpeg"
out = bytearray(); 
for i, v in enumerate(views):
    data = new.get(i, bin_[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]])
    while len(out) % 4: out.append(0)
    v["byteOffset"] = len(out); v["byteLength"] = len(data); out += data
while len(out) % 4: out.append(0)
j["buffers"][0]["byteLength"] = len(out); js = json.dumps(j, separators=(",", ":")).encode()
while len(js) % 4: js += b" "
open(dst, "wb").write(b"glTF" + struct.pack("<II", 2, 12 + 8 + len(js) + 8 + len(out)) + struct.pack("<I", len(js)) + b"JSON" + js + struct.pack("<I", len(out)) + b"BIN\0" + bytes(out))
print("jpeg", len(new), "of", len(j["images"]), "->", len(out) // 1024, "KiB bin")
