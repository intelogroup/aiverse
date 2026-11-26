"""Drop byte-identical duplicate images from a GLB by repointing, not re-encoding.

    python3 tools/city3/dedupe_images.py <in.glb> [out.glb] [--write]

Surgery, not a round trip: images that hash identically are repointed at one
bufferView, then image-only bufferViews that became unreferenced are removed and
the BIN chunk rebuilt with every index remapped. No image is decoded, resized or
re-encoded, so surviving pixels are byte-identical and only the file size changes.

Safety rules (asserted, not assumed):
  * a bufferView is droppable only if nothing but an image referenced it -- not an
    accessor, not an EXT_meshopt_compression primitive, not a skin's
    inverseBindMatrices, not a sparse block;
  * every image must still resolve to bytes that hash as before (checked by
    re-reading the output);
  * default is a dry run; `--write` replaces the file and keeps a .bak.

Why it matters here: world-city3.glb carries 429 images in 219 distinct payloads --
`townhouse_park_gazebo` x5 (701 KB each) and `townhouse_rose_arch` x5 (380 KB) --
because every placement exported its own copy: 4.65 MB of a 63.8 MB file.
"""
import hashlib
import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import glb as G  # noqa: E402

MAGIC = 0x46546C67
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942


def protected_views(doc):
    """bufferView indices that geometry, skins or sparse accessors depend on."""
    keep = set()
    for a in doc.get("accessors", []):
        if "bufferView" in a:
            keep.add(a["bufferView"])
        sp = a.get("sparse")
        if sp:
            for part in ("indices", "values"):
                if part in sp:
                    keep.add(sp[part]["bufferView"])
    for m in doc.get("meshes", []):
        for pr in m.get("primitives", []):
            ext = (pr.get("extensions") or {}).get("EXT_meshopt_compression")
            if ext and "bufferView" in ext:
                keep.add(ext["bufferView"])
    for s in doc.get("skins", []):
        if "inverseBindMatrices" in s:
            keep.add(doc["accessors"][s["inverseBindMatrices"]].get("bufferView"))
    return keep


def view_bytes(glb, i):
    bv = glb.doc["bufferViews"][i]
    start = bv.get("byteOffset", 0)
    return glb.bin[start:start + bv["byteLength"]]


def plan(glb):
    """-> dict(first=hash->(image,bv), repoint=image->image, droppable=[bv], ...)."""
    doc = glb.doc
    imgs = doc.get("images", [])
    protected = protected_views(doc)
    first, repoint, dup_bytes = {}, {}, 0
    for i, im in enumerate(imgs):
        bv = im.get("bufferView")
        if bv is None:
            continue
        data = view_bytes(glb, bv)
        h = hashlib.sha1(data).hexdigest()
        if h in first:
            repoint[i] = first[h][0]
            dup_bytes += len(data)
        else:
            first[h] = (i, bv)
    used = {bv for _, bv in first.values()}
    image_views = {im["bufferView"] for im in imgs if im.get("bufferView") is not None}
    droppable = sorted(v for v in image_views - used if v not in protected)
    # Some duplicate image views sit inside a shared fallback block (meshopt exports
    # views that overlap other views' byte ranges). Removing those would cut live
    # geometry, so only views whose range is untouched by any surviving view are
    # safe to delete; the rest stay and cost their bytes.
    live = [i for i in range(len(doc["bufferViews"])) if i not in set(droppable)]
    clean, shared = [], []
    for i in droppable:
        v = doc["bufferViews"][i]
        a0, a1 = v.get("byteOffset", 0), v.get("byteOffset", 0) + v["byteLength"]
        hit = [j for j in live
               if not (doc["bufferViews"][j].get("byteOffset", 0) >= a1
                       or doc["bufferViews"][j].get("byteOffset", 0)
                       + doc["bufferViews"][j]["byteLength"] <= a0)]
        (shared if hit else clean).append(i)
    return dict(first=first, repoint=repoint, clean=clean, shared=shared,
                protected=protected,
                stats=dict(images=len(imgs), unique=len(first), dup_bytes=dup_bytes,
                           groups=len({t for t in repoint.values()}),
                           clean_bytes=sum(doc["bufferViews"][i]["byteLength"] for i in clean),
                           shared_bytes=sum(doc["bufferViews"][i]["byteLength"] for i in shared)))



def rebuild(glb, p):
    """-> (new_doc, new_bin, stats).

    Copies the BIN once and deletes only the byte ranges that belonged to dropped
    image views, shifting every later offset by the bytes removed. It must NOT
    re-copy view-by-view: in a meshopt GLB the declared views overlap each other
    (world-city3.glb declares 71.3 MB of views inside a 60.8 MB chunk), so copying
    each view independently duplicates shared ranges and makes the file bigger.
    """
    doc = json.loads(json.dumps(glb.doc))
    views = doc["bufferViews"]
    for i, target in p["repoint"].items():
        doc["images"][i]["bufferView"] = doc["images"][target]["bufferView"]
    drop = set(p["clean"])          # shared-range duplicates stay: removing them cuts live data
    removed = []
    for i in drop:
        v = views[i]
        o = v.get("byteOffset", 0)
        removed.append((o, o + v["byteLength"]))
    removed.sort()
    for i, v in enumerate(views):
        if i in drop:
            continue
        a0 = v.get("byteOffset", 0)
        a1 = a0 + v["byteLength"]
        for r0, r1 in removed:
            if a0 < r1 and r0 < a1:
                raise SystemExit(f"refuse: dropped range {r0}-{r1} overlaps live "
                                 f"bufferView {i} ({a0}-{a1})")
    # keep-segments between removed ranges, with their new offsets
    segs, prev = [], 0
    for r0, r1 in removed:
        if r0 > prev:
            segs.append((prev, r0))
        prev = max(prev, r1)
    if prev < len(glb.bin):
        segs.append((prev, len(glb.bin)))
    new_bin = bytearray()
    spans = []
    for s0, s1 in segs:
        start = len(new_bin)
        new_bin.extend(glb.bin[s0:s1])
        spans.append((s0, s1, start))
    def shift(off):
        for s0, s1, start in spans:
            if s0 <= off < s1:
                return start + (off - s0)
        raise SystemExit(f"refuse: offset {off} falls inside a removed range")
    for i, v in enumerate(views):
        if i in drop:
            continue
        v["byteOffset"] = shift(v.get("byteOffset", 0))
    order = [i for i in range(len(views)) if i not in drop]
    remap = {old: new for new, old in enumerate(order)}
    doc["bufferViews"] = [views[i] for i in order]
    for a in doc.get("accessors", []):
        if "bufferView" in a:
            a["bufferView"] = remap[a["bufferView"]]
        for part in ("indices", "values"):
            if a.get("sparse") and part in a["sparse"]:
                a["sparse"][part]["bufferView"] = remap[a["sparse"][part]["bufferView"]]
    for m in doc.get("meshes", []):
        for pr in m.get("primitives", []):
            ext = (pr.get("extensions") or {}).get("EXT_meshopt_compression")
            if ext and "bufferView" in ext:
                ext["bufferView"] = remap[ext["bufferView"]]
    for s in doc.get("skins", []):
        if "inverseBindMatrices" in s:
            a = doc["accessors"][s["inverseBindMatrices"]]
            a["bufferView"] = remap[a["bufferView"]]
    for im in doc.get("images", []):
        if "bufferView" in im:
            im["bufferView"] = remap[im["bufferView"]]
    doc["buffers"] = [{"byteLength": len(new_bin)}]
    return doc, bytes(new_bin), dict(views_before=len(views), views_after=len(order),
                                     dropped=len(drop), order=order,
                                     bytes_before=len(glb.bin), bytes_after=len(new_bin))



def write_glb(path, doc, binchunk):
    js = json.dumps(doc, separators=(",", ":")).encode()
    while len(js) % 4:
        js += b" "
    body = bytearray(binchunk)
    while len(body) % 4:
        body.append(0)
    total = 12 + 8 + len(js) + (8 + len(body) if body else 0)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", MAGIC, 2, total))
        f.write(struct.pack("<II", len(js), JSON_CHUNK))
        f.write(js)
        if body:
            f.write(struct.pack("<II", len(body), BIN_CHUNK))
            f.write(bytes(body))


def check(src, dst, order=None):
    """Re-read the output and assert payload identity + untouched geometry counts."""
    a, b = G.load(src), G.load(dst)
    problems = []
    for key in ("nodes", "meshes", "materials", "accessors"):
        na, nb = len(a.doc.get(key, [])), len(b.doc.get(key, []))
        if na != nb:
            problems.append(f"{key} {na} -> {nb}")
    ia, ib = G.images(a), G.images(b)
    ha = [hashlib.sha1(d).hexdigest() for _, _, _, d in ia]
    hb = [hashlib.sha1(d).hexdigest() for _, _, _, d in ib]
    if ha != hb:
        problems.append(f"image payloads differ ({len(ha)} vs {len(hb)} images)")
    if sorted(set(ha)) != sorted(set(hb)):
        problems.append("distinct image payload set changed")
    if order is not None:
        bad = 0
        for new_i, old_i in enumerate(order):
            va, vb = a.doc["bufferViews"][old_i], b.doc["bufferViews"][new_i]
            da = a.bin[va.get("byteOffset", 0):va.get("byteOffset", 0) + va["byteLength"]]
            db = b.bin[vb.get("byteOffset", 0):vb.get("byteOffset", 0) + vb["byteLength"]]
            if da != db:
                bad += 1
        if bad:
            problems.append(f"{bad} retained bufferViews changed bytes after the shift")
    return problems, dict(images=len(ib), unique=len(set(hb)),
                          bytes_before=a.size, bytes_after=b.size)



def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    if not args:
        sys.exit(__doc__)
    src = args[0]
    write = "--write" in argv
    dst = args[1] if len(args) > 1 else (
        src if write else os.path.splitext(src)[0] + "-deduped.glb")
    g = G.load(src)
    p = plan(g)
    s = p["stats"]
    print(f"IMAGES {s['images']}  unique {s['unique']}  duplicate groups {s['groups']}  "
          f"duplicate bytes {s['dup_bytes'] / 1024 / 1024:.2f} MB")
    print(f"  removable {len(p['clean'])} views ({s['clean_bytes'] / 1024 / 1024:.2f} MB)  "
          f"shared-range {len(p['shared'])} views ({s['shared_bytes'] / 1024 / 1024:.2f} MB, kept)")
    if not p["clean"]:
        print("ALL OK  nothing removable")
        return
    doc, binchunk, rs = rebuild(g, p)
    tmp = dst + ".tmp"
    write_glb(tmp, doc, binchunk)
    problems, cs = check(src, tmp, rs["order"])
    print(f"REBUILT views {rs['views_before']} -> {rs['views_after']}  "
          f"bin {rs['bytes_before'] / 1024 / 1024:.2f} -> {rs['bytes_after'] / 1024 / 1024:.2f} MB  "
          f"file {g.size / 1024 / 1024:.2f} -> {os.path.getsize(tmp) / 1024 / 1024:.2f} MB")
    if problems:
        os.remove(tmp)
        print("FAILED  refusing to write:")
        for x in problems:
            print("  " + x)
        sys.exit(1)
    if write:
        bak = src + ".bak"
        if not os.path.exists(bak):
            os.replace(src, bak)
        os.replace(tmp, dst)
        print(f"WROTE {dst}  (backup {bak})")
    else:
        os.replace(tmp, dst)
        print(f"WROTE {dst}  (dry run; pass --write to replace the source)")
    print("ALL OK  0 failures")


if __name__ == "__main__":
    main(sys.argv[1:])

