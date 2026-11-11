#!/usr/bin/env python3
"""Shrink the visual GLB: meshopt-encode the raw Bones_/Sign_ streams and
compact the BIN chunk.

bridge_bones.py / add_signs append raw float and index streams to the BIN
(no EXT_meshopt_compression), 8.7 MB of the 58 MB file. This encodes each of
those views losslessly (no filter, so no position precision loss, see
03-blender-gltf-lessons.md) and rebuilds the BIN from only the spans that are
still referenced, remapping every offset. Dead bytes (views of rebuilt or
removed meshes) are dropped with --drop-dead.

Layout (see bridge_wave1.Glb): EXT_meshopt byteOffset/byteLength are absolute
into buffer 0; the view itself lives in the fallback buffer 1 (no data).

  python3 tools/city3/bridge_compact.py IN.glb OUT.glb [--drop-dead] [--prefix Bones_shop,Sign_shop]
Verifies: every live accessor decodes to identical values before and after.
"""
import argparse
import copy
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
from meshoptimizer import encode_index_buffer, encode_vertex_buffer  # noqa: E402
from bridge_wave1 import Glb, save_glb                                # noqa: E402

NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
SIZE = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
DT = {5120: "i1", 5121: "u1", 5122: "<i2", 5123: "<u2", 5125: "<u4", 5126: "<f4"}
EXT = "EXT_meshopt_compression"


def live_accessors(g):
    acc = set()
    for m in g["meshes"]:
        for p in m["primitives"]:
            acc.update(p["attributes"].values())
            if "indices" in p:
                acc.add(p["indices"])
            for t in p.get("targets", []):
                acc.update(t.values())
    for n in g["nodes"]:
        acc.update(n.get("extensions", {}).get("EXT_mesh_gpu_instancing", {})
                   .get("attributes", {}).values())
    for a in g.get("animations", []):
        for s in a["samplers"]:
            acc.update((s["input"], s["output"]))
    for s in g.get("skins", []):
        if "inverseBindMatrices" in s:
            acc.add(s["inverseBindMatrices"])
    return acc


def target_accessors(g, prefixes):
    """Accessors of nodes named <prefix>*, split into (attribute, index)."""
    attr, idx = set(), set()
    for n in g["nodes"]:
        if "mesh" in n and n.get("name", "").startswith(prefixes):
            for p in g["meshes"][n["mesh"]]["primitives"]:
                attr.update(p["attributes"].values())
                if "indices" in p:
                    idx.add(p["indices"])
    return attr, idx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--drop-dead", action="store_true")
    ap.add_argument("--prefix", default="Bones_shop,Sign_shop")
    a = ap.parse_args()
    prefixes = tuple(a.prefix.split(","))

    old = Glb(a.src)
    g, binb = copy.deepcopy(old.gltf), old.bin   # old stays pristine for verify
    assert not any("sparse" in x for x in g["accessors"]), "sparse accessors unsupported"
    live = live_accessors(g)
    t_attr, t_idx = target_accessors(g, prefixes)

    # view -> accessors using it (live only)
    users = {}
    for i in live:
        users.setdefault(g["accessors"][i]["bufferView"], []).append(i)
    img_views = {im["bufferView"] for im in g.get("images", []) if "bufferView" in im}
    live_views = set(users) | img_views

    out = bytearray()
    placed = {}                       # (old_off, len) -> new_off

    def place(off, ln):
        key = (off, ln)
        if key not in placed:
            while len(out) % 4:
                out.append(0)
            placed[key] = len(out)
            out.extend(binb[off:off + ln])
        return placed[key]

    fb = g["buffers"][1]["byteLength"] if len(g["buffers"]) > 1 else 0
    stat = {"encoded": 0, "raw_before": 0, "enc_after": 0, "dead": 0, "skipped": 0}
    if len(g["buffers"]) < 2:
        g["buffers"].append({"byteLength": 0, "extensions": {EXT: {"fallback": True}}})
        g.setdefault("extensionsUsed", [])
        for k in ("extensionsUsed", "extensionsRequired"):
            if EXT not in g.setdefault(k, []):
                g[k].append(EXT)

    for vi, v in enumerate(g["bufferViews"]):
        ext = v.get("extensions", {}).get(EXT)
        if vi not in live_views:
            stat["dead"] += ext["byteLength"] if ext else v["byteLength"]
            if a.drop_dead:
                v.pop("extensions", None)
                v.update(buffer=0, byteOffset=0, byteLength=4)
                v.pop("byteStride", None)
            elif ext:
                ext["byteOffset"] = place(ext["byteOffset"], ext["byteLength"])
            else:
                v["byteOffset"] = place(v.get("byteOffset", 0), v["byteLength"])
            continue
        us = users.get(vi, [])
        encodable = (not ext and us and all(
            u in t_attr or u in t_idx for u in us) and len(us) == 1)
        if encodable:
            ac = g["accessors"][us[0]]
            ct, n = ac["componentType"], ac["count"]
            nc = NCOMP[ac["type"]]
            esz = SIZE[ct] * nc
            raw = bytes(binb[v.get("byteOffset", 0) + ac.get("byteOffset", 0):][:n * esz])
            is_idx = us[0] in t_idx and us[0] not in t_attr
            if (len(raw) == n * esz and not ac.get("byteOffset", 0) and
                    v["byteLength"] == n * esz and esz % 4 == 0 and
                    (not is_idx or (n % 3 == 0 and ct in (5123, 5125)))):
                if is_idx:
                    arr = np.frombuffer(raw, dtype=DT[ct]).astype(np.uint32)
                    enc = encode_index_buffer(arr, index_count=n,
                                              vertex_count=int(arr.max()) + 1)
                    mode, stride = "TRIANGLES", SIZE[ct]
                else:
                    enc = encode_vertex_buffer(np.frombuffer(raw, dtype=np.uint8).reshape(n, esz), n, esz)
                    mode, stride = "ATTRIBUTES", esz
                while len(out) % 4:
                    out.append(0)
                off = len(out)
                out.extend(enc)
                stat["encoded"] += 1
                stat["raw_before"] += len(raw)
                stat["enc_after"] += len(enc)
                v["buffer"] = 1
                v["byteOffset"] = fb
                fb += (n * esz + 3) & ~3
                v["extensions"] = {EXT: {"buffer": 0, "byteOffset": off,
                                         "byteLength": len(enc),
                                         "byteStride": stride, "count": n,
                                         "mode": mode}}
                v.pop("byteStride", None)
                continue
            stat["skipped"] += 1
        if ext:
            ext["byteOffset"] = place(ext["byteOffset"], ext["byteLength"])
        else:
            v["byteOffset"] = place(v.get("byteOffset", 0), v["byteLength"])

    g["buffers"][0]["byteLength"] = len(out)
    g["buffers"][1]["byteLength"] = fb
    save_glb(a.dst, g, bytes(out))

    # verify: every live accessor identical before and after
    new = Glb(a.dst)
    bad = 0
    for i in sorted(live):
        if not np.array_equal(old.acc_raw(i), new.acc_raw(i)):
            bad += 1
    print("encoded views", stat["encoded"], "skipped", stat["skipped"],
          "raw->enc bytes", stat["raw_before"], stat["enc_after"],
          "dead bytes", stat["dead"], "(dropped)" if a.drop_dead else "(kept)")
    print("size", os.path.getsize(a.src), "->", os.path.getsize(a.dst),
          "| live accessors", len(live), "mismatch", bad)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
