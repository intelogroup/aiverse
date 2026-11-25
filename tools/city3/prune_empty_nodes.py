#!/usr/bin/env python3
"""Drop inert scene-graph nodes from a shipped GLB -- JSON-only, buffers untouched.

world-city3.glb carries 2,688 childless nodes: 861 ls_flower, 808 ls_bush, 247 ls_rock,
88 ls_tree, 56 SK_pot, 24 SK_lantern, ... with no mesh, no children and no extensions.
They draw nothing (GLTFLoader still allocates an Object3D each) and they survived export
because they are placement empties whose geometry was merged elsewhere.

Kept: anything with a mesh, children, extensions (KHR_lights_punctual is how the 29 real
lights ride) or a camera. Node indices are renumbered and every reference is remapped:
children, scenes[].nodes, skins[].joints/skeleton, animations' channel targets. The script
aborts instead of guessing if a skin or animation points at a node it would drop.

Because only the JSON chunk changes, EXT_meshopt_compression views and the BIN chunk stay
byte-identical -- no position re-quantisation, which is what the rug/sign 4 cm snapping in
docs/procedural-city/06-failures-log.md (#9) came from.

    python3 tools/city3/prune_empty_nodes.py <in.glb> <out.glb> [--dry]
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
    js = next(c for c in chunks if c[0] == 0x4E4F534A)
    return json.loads(js[1]), chunks

def save(path, g, chunks):
    body = json.dumps(g, separators=(",", ":")).encode()
    body += b" " * (-len(body) % 4)
    out = bytearray()
    parts = [[0x4E4F534A, body]] + [c for c in chunks if c[0] != 0x4E4F534A]
    for ty, data in parts:
        pad = b"\0" * (-len(data) % 4)
        out += struct.pack("<II", len(data) + len(pad), ty) + data + pad
    hdr = b"glTF" + struct.pack("<II", 2, 12 + len(out))
    open(path, "wb").write(hdr + bytes(out))

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry" in sys.argv
    src, dst = args[0], (args[1] if len(args) > 1 else args[0])
    g, chunks = load(src)
    nodes = g.get("nodes", [])

    keep_ = []
    for i, n in enumerate(nodes):
        inert = ("mesh" not in n and "children" not in n and "camera" not in n
                 and not (n.get("extensions") or {}))
        if not inert:
            keep_.append(i)
    drop = [i for i in range(len(nodes)) if i not in set(keep_)]
    if not drop:
        print("nothing to prune"); return

    dropped = set(drop)
    # refuse to guess about anything that still points at a dropped node
    for s in g.get("skins", []):
        refs = list(s.get("joints", [])) + ([s["skeleton"]] if "skeleton" in s else [])
        bad = [r for r in refs if r in dropped]
        if bad:
            sys.exit(f"ABORT: skin references dropped node(s) {bad[:5]}")
    for a in g.get("animations", []):
        bad = [c["target"]["node"] for c in a.get("channels", [])
               if "node" in c.get("target", {}) and c["target"]["node"] in dropped]
        if bad:
            sys.exit(f"ABORT: animation '{a.get('name')}' targets dropped node(s) {bad[:5]}")

    remap = {old: new for new, old in enumerate(keep_)}
    g["nodes"] = [nodes[i] for i in keep_]
    for n in g["nodes"]:
        if "children" in n:
            n["children"] = [remap[c] for c in n["children"] if c in remap]
            if not n["children"]:
                del n["children"]
    for sc in g.get("scenes", []):
        if "nodes" in sc:
            sc["nodes"] = [remap[m] for m in sc["nodes"] if m in remap]
    for s in g.get("skins", []):
        if "joints" in s:
            s["joints"] = [remap[j] for j in s["joints"]]
        if "skeleton" in s and s["skeleton"] in remap:
            s["skeleton"] = remap[s["skeleton"]]
    for a in g.get("animations", []):
        for c in a.get("channels", []):
            t = c.get("target", {})
            if "node" in t and t["node"] in remap:
                t["node"] = remap[t["node"]]

    print(f"nodes {len(nodes)} -> {len(g['nodes'])}  (dropped {len(drop)} inert; "
          f"{sum(1 for n in g['nodes'] if n.get('extensions'))} kept with extensions)")
    if dry:
        print("--dry: not written"); return
    save(dst, g, chunks)
    print("wrote", dst)

if __name__ == "__main__":
    main()
