#!/usr/bin/env python3
"""Stage B: apply index arrays from simplify_targets.mjs to a GLB -- vertices untouched.

Only primitive.indices changes. Each new index array is appended to the BIN chunk as a raw
(UNCOMPRESSED) bufferView and referenced by a fresh accessor; every position, normal, UV and
every existing EXT_meshopt_compression span stays byte-identical. That keeps the 12-bit
position-precision trap out of the picture entirely -- see the sibling note in
simplify_targets.mjs and docs/procedural-city/06-failures-log.md #9.

Refuses to write if a target mesh/primitive is missing, if an index is out of range, or if the
result would not reduce anything.

    python3 tools/city3/apply_indices.py <in.glb> <out.glb> <indices.json> [--dry]
"""
import json, struct, sys

def load(path):
    d = open(path, "rb").read()
    assert d[:4] == b"glTF", "not a GLB"
    total = struct.unpack("<I", d[8:12])[0]
    off, chunks = 12, []
    while off < total:
        ln, ty = struct.unpack("<II", d[off:off + 8])
        chunks.append([ty, d[off + 8:off + 8 + ln]])
        off += 8 + ln
    return (json.loads(next(c[1] for c in chunks if c[0] == 0x4E4F534A)),
            next((c[1] for c in chunks if c[0] == 0x004E4942), b""), chunks)

def pack(path, g, bin_, chunks):
    body = json.dumps(g, separators=(",", ":")).encode()
    body += b" " * (-len(body) % 4)
    binp = bin_ + b"\0" * (-len(bin_) % 4)
    out = bytearray()
    for ty, data in ([(0x4E4F534A, body)] + ([(0x004E4942, binp)] if binp else [])
                     + [[c[0], c[1]] for c in chunks if c[0] not in (0x4E4F534A, 0x004E4942)]):
        out += struct.pack("<II", len(data), ty) + data
    open(path, "wb").write(b"glTF" + struct.pack("<II", 2, 12 + len(out)) + bytes(out))

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry" in sys.argv
    src, dst, patch = args[0], args[1], args[2]
    g, bin_, chunks = load(src)
    plan = json.load(open(patch))
    if not plan:
        sys.exit("empty plan")

    bin_ = bytearray(bin_)
    for item in plan:
        mesh = g["meshes"][next(i for i, m in enumerate(g["meshes"]) if m.get("name") == item["mesh"])]
        prim = mesh["primitives"][item["primitives"]]
        acc_i = prim.get("indices")
        if acc_i is None:
            sys.exit(f"ABORT: {item['mesh']} primitive has no indices")
        nverts = g["accessors"][prim["attributes"]["POSITION"]]["count"]
        idx = item["indices"]
        if max(idx) >= nverts:
            sys.exit(f"ABORT: {item['mesh']} index {max(idx)} >= {nverts} vertices")
        if len(idx) // 3 >= item["triangles_before"]:
            sys.exit(f"ABORT: {item['mesh']} reduces nothing")

        data = struct.pack(f"<{len(idx)}I", *idx)
        bin_ += b"\0" * (-len(bin_) % 4)
        offset = len(bin_)
        bin_ += data
        g.setdefault("bufferViews", []).append(
            {"buffer": 0, "byteOffset": offset, "byteLength": len(data), "target": 34963})
        g.setdefault("accessors", []).append(
            {"bufferView": len(g["bufferViews"]) - 1, "componentType": 5125,
             "count": len(idx), "type": "SCALAR"})
        prim["indices"] = len(g["accessors"]) - 1
        print(f"  {item['mesh']}: {int(item['triangles_before'])} -> {int(item['triangles_after'])} tris")

    g["buffers"][0]["byteLength"] = len(bin_)
    print(f"indices applied to {len(plan)} primitive(s); BIN {len(bin_)/1e6:.1f} MB")
    if dry:
        print("--dry: not written"); return
    pack(dst, g, bytes(bin_), chunks)
    print("wrote", dst)

if __name__ == "__main__":
    main()
