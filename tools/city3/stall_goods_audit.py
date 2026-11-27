#!/usr/bin/env python3
"""Audit whether the bazaar goods stand ON the stall counters.

    python3 tools/city3/stall_goods_audit.py            # report to stdout
    python3 tools/city3/stall_goods_audit.py --json out/stall-goods.json
    python3 tools/city3/stall_goods_audit.py --check    # non-zero above baseline
    python3 tools/city3/stall_goods_audit.py --map      # ASCII counter height map

Why this exists: `bridge_stalls.py` replaced the 600-tri `LIB_sk_med_stall` mesh
(counter top 1.164 m above the walk plane, which is what `build_city.py` places
goods at) with two downloaded stalls whose counters are **lower** -- 0.696-0.777 m
(variant A, a cloth-covered table tilted ~4.2 deg) and 0.833 m (variant B). The
goods were never moved, so every piece placed on a counter now hovers above it.

The check has to decode data nobody else in the gates touches:

* **Instance translations are meshopt-compressed** (`EXT_mesh_gpu_instancing`,
  mode ATTRIBUTES, filter EXPONENTIAL). `glb.py` deliberately reads only declared
  min/max, and these accessors declare none, so a gate built on it would be blind
  to the one number that matters. `meshopt_decode()` below handles it, and falls
  back to the accessor envelope when the codec is missing (report says which).
* **Goods origins are bottom-centre**, so the instance translation is the piece's
  *underside*. Comparing translation Y with the counter is the whole test; there is
  no half-height fudge factor to get wrong.
* **The stall nodes carry a yaw of 0 or pi** (facing S/N). Goods are placed in
  world space, the counter mesh in stall-local space, so the ray cast goes through
  the node's inverse world matrix.
* **Hanging goods and ground props are not counter goods.** A hanging basket's
  translation is the rail it hangs from and a side sack stands on the cobbles;
  counting either as "floating" would be a phantom finding. They are split out by
  their own surface: hang = translation above `HANG_Y`, ground = no stall surface
  under the point.

Findings:
  goods_floating   piece underside more than `TOL` above the surface below it
  goods_sunk       piece underside more than `TOL` below that surface
  goods_no_surface counter goods with no stall geometry underneath (in the aisle)
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
for p in (os.path.expanduser("~/tmp-pip/pylibs"), HERE):
    if p not in sys.path:
        sys.path.insert(0, p)
import glb                                                        # noqa: E402

GLB = f"{HERE}/../../apps/console/public/assets/world-city3.glb"
STALL_PREFIX = "SK_med_stall"
GOODS_PREFIX = "inst_goods_"
HANG_Y = 2.0            # glTF Y: goods translating above this hang from the rail
TOL = 0.02              # m: anything under this reads as "resting on it"
BAND = (0.55, 1.05)     # m above the walk plane: the counter table lives in here
LARGE = 0.05            # m^2: a counter plane, not a grape


# ---------------------------------------------------------------- decoding
def decode_plain(g, acc_i):
    """Float/uint accessor with no compression extension, or None.

    The stall meshes were appended by `bridge_stalls.append_mesh`, which asserts the
    source views are uncompressed -- so these are readable without the codec, unlike
    every original mesh in the world.
    """
    doc = g.doc
    a = doc["accessors"][acc_i]
    view = doc["bufferViews"][a["bufferView"]]
    if view.get("extensions"):
        return None
    nc = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
    dt = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32,
          5126: np.float32}[a["componentType"]]
    off = view.get("byteOffset", 0) + a.get("byteOffset", 0)
    raw = np.frombuffer(g.bin, dtype=dt, count=a["count"] * nc, offset=off)
    # copy: `g.bin` is a bytearray that bridges append to, and a view into it would
    # dangle if it reallocates mid-run
    raw = raw.copy()
    return raw.reshape(a["count"], nc) if nc > 1 else raw


def meshopt_decode(g, acc_i):
    """Decode an accessor whose bufferView carries EXT_meshopt_compression.

    Returns (values as float64, 'meshopt'|'envelope'|'plain'). The envelope fallback
    reports the declared min/max as a 2-row array, which is still enough to say "every
    instance sits at y=1.20" -- the defect this tool exists for.

    `componentType` matters: instancing ROTATION is a **normalized SHORT** quaternion
    (4 int16 per element, stride 8), so reading every accessor as float32 asks for twice
    the bytes it has. Normalized integers are scaled here so callers only ever see
    floats.
    """
    doc = g.doc
    a = doc["accessors"][acc_i]
    view = doc["bufferViews"][a["bufferView"]]
    ext = (view.get("extensions") or {}).get("EXT_meshopt_compression")
    ncomp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
    dtype = {5120: "<i1", 5121: "u1", 5122: "<i2", 5123: "<u2",
             5125: "<u4", 5126: "<f4"}[a["componentType"]]
    if ext is None:
        vals = decode_plain(g, acc_i)
        out = np.asarray(vals, dtype=np.float64).reshape(-1, ncomp)
        return _norm(out, a), "plain"
    try:
        import meshoptimizer as mo
    except ImportError:
        box = glb.accessor_aabb(doc, acc_i)
        return (None if box is None else np.vstack(box)), "envelope"
    assert ext["mode"] == "ATTRIBUTES", f"unexpected meshopt mode {ext['mode']}"
    enc = np.frombuffer(
        g.bin[ext["byteOffset"]:ext["byteOffset"] + ext["byteLength"]], dtype=np.uint8)
    buf = mo.decode_vertex_buffer(a["count"], ext["byteStride"], enc)
    raw = np.frombuffer(buf.tobytes(), dtype=np.uint8).copy()
    filt = ext.get("filter")
    if filt == "EXPONENTIAL":
        raw = mo.decode_filter_exp(raw, a["count"], ext["byteStride"])
    elif filt == "QUATERNION":
        raw = mo.decode_filter_quat(raw, a["count"], ext["byteStride"])
    elif filt == "OCTAHEDRAL":
        raw = mo.decode_filter_oct(raw, a["count"], ext["byteStride"])
    out = np.frombuffer(raw.tobytes(), dtype=dtype,
                        count=a["count"] * ncomp).reshape(-1, ncomp).astype(np.float64)
    return _norm(out, a), "meshopt"


def _norm(vals, acc):
    """Apply the accessor's `normalized` flag (SHORT quaternions are int16 / 32767)."""
    if not acc.get("normalized"):
        return vals
    ct = acc["componentType"]
    scale = {5120: 127.0, 5121: 255.0, 5122: 32767.0, 5123: 65535.0}.get(ct)
    return vals / scale if scale else vals



# ---------------------------------------------------------------- stall counters
def support(hmap, origin, lx, lz, half, tol=2, need=6):
    """Datum under a piece's footprint, or None when it is not resting on a counter.

    Shared by the audit and the bridge, so "the piece is on the table" means exactly
    one thing in both -- the first version had a ±10 cm centre window in the audit and
    nine footprint samples in the bridge, and they disagreed on 2.8 cm steps like
    variant B's raised board.

    Nine samples (centre + eight around the footprint). The centre must find counter
    cells and `need` of the nine must too; anything less is a piece hanging over an
    edge. Returns the **max** height under the footprint: a piece cannot follow variant
    A's 12° table tilt, and standing on the high side never hides a gap underneath.
    """
    x0, z0, cell = origin
    hits, ys = 0, []
    for sx, sz in ((0, 0), (-1, 0), (1, 0), (0, -1), (0, 1),
                   (-1, -1), (1, -1), (-1, 1), (1, 1)):
        gi = int((lx + sx * half[0] - x0) / cell)
        gj = int((lz + sz * half[1] - z0) / cell)
        win = hmap[max(0, gi - tol):max(0, gi + tol + 1), max(0, gj - tol):max(0, gj + tol + 1)]
        if np.isfinite(win).any():
            hits += 1
            ys.append(float(np.nanmax(win)))
    if hits < need or not ys:
        return None
    gi = int((lx - x0) / cell)
    gj = int((lz - z0) / cell)
    centre = hmap[max(0, gi - tol):max(0, gi + tol + 1), max(0, gj - tol):max(0, gj + tol + 1)]
    if not np.isfinite(centre).any():
        return None
    return max(ys)


def occupied_hit(cmap, origin, lx, lz, half, level, margin=0.05):
    """Is anything already standing on the counter at (lx, lz) above `level`?

    `cmap` is `clutter_map()`'s output: the height of the stall's own baked produce.
    A piece dropped into that area would rest *inside* a baked tomato rather than on
    the table, so both the audit and the bridge ask this before accepting a spot.
    """
    x0, z0, cell = origin
    hx = max(1, int(round(max(half[0], 0.08) / cell)))
    hz = max(1, int(round(max(half[1], 0.08) / cell)))
    gi = int((lx - x0) / cell)
    gj = int((lz - z0) / cell)
    win = cmap[max(0, gi - hx):max(0, gi + hx + 1), max(0, gj - hz):max(0, gj + hz + 1)]
    return bool(np.isfinite(win).any() and np.nanmax(win) > level + margin)


def stall_tris(g):
    """{mesh index: (tris, area)} for every stall mesh, in its own local space."""
    doc = g.doc
    out = {}
    for mi, mesh in enumerate(doc["meshes"]):
        if not (mesh.get("name") or "").startswith("STALL_"):
            continue
        P, T = [], []
        for prim in mesh["primitives"]:
            pos = decode_plain(g, prim["attributes"]["POSITION"])
            idx = decode_plain(g, prim["indices"])
            if pos is None or idx is None:
                continue
            idx = idx.astype(np.int64).reshape(-1, 3) + sum(len(x) for x in P)
            P.append(pos)
            T.append(idx)
        if not P:
            continue
        tri = np.vstack(P).astype(np.float64)[np.vstack(T)]
        n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        out[mi] = (tri, 0.5 * np.linalg.norm(n, axis=1))
    return out


def counter_map(tris, area, cell=0.02, span=((-1.55, 1.55), (-0.85, 0.85))):
    """Height field of the *counter planes* over the stall footprint.

    Only large, near-horizontal, low triangles count: that keeps the table (and the
    trays standing on it) and drops the canopy, posts and loose produce. Variant A's
    table is tilted, so the map is per cell rather than one datum. Heights are in
    mesh-local metres, and the stall mesh origin is the ground plane, so `BAND` is
    local too -- comparing it with a world height is the mistake this comment exists
    to prevent.
    """
    (x0, x1), (z0, z1) = span
    nx, nz = int(round((x1 - x0) / cell)), int(round((z1 - z0) / cell))
    h = np.full((nx, nz), np.nan)
    n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    ny = n[:, 1] / np.maximum(2 * area, 1e-12)
    ymid = tris[:, :, 1].mean(1)
    keep = (area > LARGE) & (ny > 0.9) & (ymid > BAND[0]) & (ymid < BAND[1])

    for t in tris[keep]:
        lo = np.maximum(t[:, [0, 2]].min(0), (x0, z0))
        hi = np.minimum(t[:, [0, 2]].max(0), (x1, z1))
        if (hi <= lo).any():
            continue
        i0, i1 = int((lo[0] - x0) / cell), int(np.ceil((hi[0] - x0) / cell))
        j0, j1 = int((lo[1] - z0) / cell), int(np.ceil((hi[1] - z0) / cell))
        gx = x0 + (np.arange(i0, i1) + 0.5) * cell
        gz = z0 + (np.arange(j0, j1) + 0.5) * cell
        X, Z = np.meshgrid(gx, gz, indexing="ij")
        a, b, c = t[0], t[1], t[2]
        det = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2])
        if abs(det) < 1e-9:
            continue
        wb = ((X - a[0]) * (c[2] - a[2]) - (Z - a[2]) * (c[0] - a[0])) / det
        wc = ((b[0] - a[0]) * (Z - a[2]) - (b[2] - a[2]) * (X - a[0])) / det

        wa = 1.0 - wb - wc
        inside = (wa >= -1e-6) & (wb >= -1e-6) & (wc >= -1e-6)
        if not inside.any():
            continue
        y = wa * a[1] + wb * b[1] + wc * c[1]
        sub = h[i0:i1, j0:j1]
        h[i0:i1, j0:j1] = np.fmax(sub, np.where(inside, y, np.nan))
    return h, (x0, z0, cell)


def clutter_map(tris, cell=0.02, span=((-1.55, 1.55), (-0.85, 0.85)), top=1.45):
    """Height field of everything standing on the counter: the baked-in produce.

    Both downloaded stalls carry their own goods (trays of tomatoes and potatoes on
    A, a bowl/potatoes/cups on B). Those are triangles above the counter plane, and
    they decide whether a procedural crate can be lowered onto the same spot or has
    to be dropped -- a crate resting inside a baked tomato is not a fix.
    """
    (x0, x1), (z0, z1) = span
    nx, nz = int(round((x1 - x0) / cell)), int(round((z1 - z0) / cell))
    h = np.full((nx, nz), np.nan)
    ymid = tris[:, :, 1].mean(1)
    keep = (ymid > BAND[0]) & (ymid < top)
    for t in tris[keep]:
        lo = np.maximum(t[:, [0, 2]].min(0), (x0, z0))
        hi = np.minimum(t[:, [0, 2]].max(0), (x1, z1))
        if (hi <= lo).any():
            continue
        i0, i1 = int((lo[0] - x0) / cell), int(np.ceil((hi[0] - x0) / cell))
        j0, j1 = int((lo[1] - z0) / cell), int(np.ceil((hi[1] - z0) / cell))
        X, Z = np.meshgrid(x0 + (np.arange(i0, i1) + 0.5) * cell,
                           z0 + (np.arange(j0, j1) + 0.5) * cell, indexing="ij")
        a, b, c = t[0], t[1], t[2]
        det = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2])
        if abs(det) < 1e-9:
            continue
        wb = ((X - a[0]) * (c[2] - a[2]) - (Z - a[2]) * (c[0] - a[0])) / det
        wc = ((b[0] - a[0]) * (Z - a[2]) - (b[2] - a[2]) * (X - a[0])) / det
        wa = 1.0 - wb - wc
        inside = (wa >= -1e-6) & (wb >= -1e-6) & (wc >= -1e-6)
        if not inside.any():
            continue
        y = wa * a[1] + wb * b[1] + wc * c[1]
        sub = h[i0:i1, j0:j1]
        h[i0:i1, j0:j1] = np.fmax(sub, np.where(inside, y, np.nan))
    return h


# ---------------------------------------------------------------- audit
def audit(path=GLB, verbose=True, only_stall=None):
    g = glb.load(path)
    doc = g.doc
    world = glb.world_matrices(doc)

    stalls = []
    for i, n in enumerate(doc["nodes"]):
        if not (n.get("name") or "").startswith(STALL_PREFIX) or "mesh" not in n:
            continue
        W = world[i]
        stalls.append(dict(node=n.get("name"), mesh=n["mesh"],
                           mesh_name=doc["meshes"][n["mesh"]].get("name"),
                           W_inv=np.linalg.inv(W),
                           T=np.array(n.get("translation", [0, 0, 0]), float)))
    if not stalls:
        raise SystemExit("no stall nodes found -- is this the bazaar build?")
    ground = float(np.median([s["T"][1] for s in stalls]))

    tris_by_mesh = stall_tris(g)
    maps, origins, clutter = {}, {}, {}
    for mi in sorted({s["mesh"] for s in stalls}):
        tris, area = tris_by_mesh[mi]
        maps[mi], origins[mi] = counter_map(tris, area)
        clutter[mi] = clutter_map(tris)

        h = maps[mi][np.isfinite(maps[mi])]
        if verbose and len(h):
            print(f"  {doc['meshes'][mi].get('name'):9s} counter cells {len(h):5d}  "
                  f"local y {h.min():.3f}..{h.max():.3f}  "
                  f"abs {ground + h.min():.3f}..{ground + h.max():.3f} m")

    rows, modes = [], set()
    for i, n in enumerate(doc["nodes"]):
        name = n.get("name") or ""
        if not name.startswith(GOODS_PREFIX) or "mesh" not in n:
            continue
        ext = (n.get("extensions") or {}).get("EXT_mesh_gpu_instancing")
        if not ext:
            continue
        T, mode = meshopt_decode(g, ext["attributes"]["TRANSLATION"])
        modes.add(mode)
        if T is None or mode == "envelope":
            # without the codec only the accessor envelope is readable, and counting
            # its two rows as instances would be a plausible-looking wrong answer
            continue
        box = glb.mesh_aabb(doc, n["mesh"])
        if box is None:
            continue
        S, _ = meshopt_decode(g, ext["attributes"]["SCALE"])
        if S is None or len(S) != len(T):
            S = np.ones((len(T), 3))
        W = world[i] if world[i] is not None else np.eye(4)
        node_scale = float(np.linalg.norm(W[:3, 1]))
        for t, s in zip(T, S):
            p = (W @ np.array([t[0], t[1], t[2], 1.0]))[:3]
            # the instance's own SCALE multiplies the node's: a basket at 1.15 is
            # 0.37 m tall, not 0.32, and its underside is 15% further down
            sx, sy, sz = node_scale * s[0], node_scale * s[1], node_scale * s[2]
            rows.append(dict(key=name[len(GOODS_PREFIX):], p=p,
                             ymin=box[0][1] * sy, ymax=box[1][1] * sy,
                             hidden=bool(abs(sx) < 1e-6 or abs(sy) < 1e-6
                                         or abs(sz) < 1e-6),
                             half=(max(box[1][0] - box[0][0], 0.05) * sx / 2,
                                   max(box[1][2] - box[0][2], 0.05) * sz / 2)))

    # each instance belongs to the stall nearest its translation (0.9-1.5 m away
    # from other counters, so nearest is unambiguous; side sacks land on the stall
    # they lean against and are then caught by the "no surface" branch below)
    for r in rows:
        r["stall"] = min(stalls, key=lambda s: (s["T"][0] - r["p"][0]) ** 2
                         + (s["T"][2] - r["p"][2]) ** 2)
    if only_stall:
        # one stall at a time: the bridge fixes a single stall, and the aggregate is
        # too blunt to tell whether that one worked
        rows = [r for r in rows if r["stall"]["node"] == only_stall]

    findings, per_stall, counter, ground_props, hanging, hidden = [], {}, [], [], [], []
    for r in rows:
        s = r["stall"]
        bottom = r["p"][1] + r["ymin"]
        if r["p"][1] > ground + HANG_Y:
            hanging.append(r)
            continue
        if abs(bottom - ground) <= 0.05:
            ground_props.append((r, bottom - ground))      # standing on the cobbles
            continue
        if r["hidden"]:
            # 68 instances in this file carry scale 0 (all of mound_oranges,
            # mound_tomatoes, pots_terra, and half of four other keys): they render
            # nothing, so a gap for them is a number about a piece nobody can see.
            # Left alone by the bridge too -- resurrecting them is a separate call.
            hidden.append(r)
            continue
        sx0, sz0, cell = origins[s["mesh"]]
        hmap = maps[s["mesh"]]
        loc = (s["W_inv"] @ np.array([r["p"][0], r["p"][1], r["p"][2], 1.0]))[:3]
        gi, gj = int((loc[0] - sx0) / cell), int((loc[2] - sz0) / cell)
        # judged against the counter under the piece's own footprint, never against
        # the highest surface under the point (that is the canopy at 2.17-2.72 m,
        # which reads as a 1.4 m sink)
        d = support(hmap, origins[s["mesh"]], loc[0], loc[2], r["half"])
        if d is None:
            findings.append(dict(type="goods_no_surface", key=r["key"],
                                 stall=s["node"], variant=s["mesh_name"],
                                 bottom=round(bottom, 3),
                                 above_ground=round(bottom - ground, 3),
                                 x=round(float(r["p"][0]), 2),
                                 z=round(float(r["p"][2]), 2),
                                 why="goods hanging in the aisle: no counter "
                                     "geometry under the piece"))
            continue
        datum = ground + d
        gap = bottom - datum
        # would a lowered piece land inside the stall's own baked produce?
        clash = occupied_hit(clutter[s["mesh"]], origins[s["mesh"]], loc[0], loc[2],
                             r["half"], d, 0.05)

        rec = dict(key=r["key"], stall=s["node"], variant=s["mesh_name"],
                   bottom=round(bottom, 3), datum=round(datum, 3),
                   gap=round(gap, 3), occupied=clash, x=round(float(r["p"][0]), 2),
                   z=round(float(r["p"][2]), 2),
                   lz=round(float(loc[2]), 3), lx=round(float(loc[0]), 3),
                   h=round(float(r["ymax"] - r["ymin"]), 3))

        counter.append(rec)
        per_stall.setdefault(s["node"], []).append(gap)
        if gap > TOL:
            findings.append(dict(type="goods_floating", **rec,
                                 why="goods underside floats above the counter"))
        elif gap < -TOL:
            findings.append(dict(type="goods_sunk", **rec,
                                 why="goods underside is buried in the counter"))


    gaps = np.array([c["gap"] for c in counter]) if counter else np.zeros(0)
    rep = dict(glb=os.path.relpath(path, HERE), stalls=len(stalls), ground=ground,
               decode=sorted(modes),
               variants={doc["meshes"][mi].get("name"):
                         dict(counter_local=[round(float(np.nanmin(maps[mi])), 3),
                                             round(float(np.nanmax(maps[mi])), 3)],
                              cells=int(np.isfinite(maps[mi]).sum()))
                         for mi in maps},
               goods=dict(total=len(rows), counter=len(counter),
                          ground=len(ground_props), hanging=len(hanging),
                          hidden=len(hidden)),
               gap=dict(median=round(float(np.median(gaps)), 3) if len(gaps) else None,
                        lo=round(float(gaps.min()), 3) if len(gaps) else None,
                        hi=round(float(gaps.max()), 3) if len(gaps) else None),
               stalls_with_float=sum(1 for v in per_stall.values() if max(v) > TOL),
               counter_occupied=sum(1 for c in counter if c["occupied"]),
               counter_clear=sum(1 for c in counter if not c["occupied"]),
               mesh_of_variant={doc["meshes"][mi].get("name"): mi for mi in maps},
               findings=findings, counts={})
    for f in findings:
        rep["counts"][f["type"]] = rep["counts"].get(f["type"], 0) + 1
    return rep, counter, ground_props, hanging, maps, origins






def ascii_map(h, origin, title):
    """Coarse height map, so a counter can be judged in a terminal.

    Printed as centimetres/3 (so 0.69 m reads '2', 0.83 m reads '2'); a '.' cell
    has no counter plane. Rows are local +z, columns local +x.
    """
    x0, z0, cell = origin
    step = max(1, int(round(0.05 / cell)))
    sub = h[::step, ::step]
    print(f"\n{title}  columns = local +x, rows = local +z, 5 cm cells, "
          f"'.' = no counter")
    for j in range(sub.shape[1]):
        line = "".join("." if not np.isfinite(sub[i, j])
                       else str(int(round(sub[i, j] * 100 / 3)) % 10)
                       for i in range(sub.shape[0]))
        print("  " + line)


def elevation(counter, mesh_of_variant, maps, origins, ground, path, height=340):
    """Draw a side elevation through one stall of each variant.

    x = stall-local depth (z, the customer side on the right), y = metres above the
    walk plane. The counter profile is the height map sampled down the middle of the
    stall; every goods piece of that variant is drawn at its own depth with its measured
    underside (a projection: x is not shown, only "what is at what height"). A floating
    piece reads as white between the counter line and the red box's bottom edge -- the
    same number `gap` reports, but seeable.
    """
    from PIL import Image, ImageDraw
    variants = sorted({c["variant"] for c in counter})
    panel_w, panel_h = height * 2, height
    img = Image.new("RGB", (panel_w * len(variants), panel_h), (250, 250, 248))
    dr = ImageDraw.Draw(img)
    z0, z1, y0, y1 = -0.85, 0.85, 0.0, 1.7
    for vi, vn in enumerate(variants):
        ox = vi * panel_w
        px = lambda zz: ox + 12 + (zz - z0) / (z1 - z0) * (panel_w - 24)
        py = lambda yy: panel_h - 22 - (yy - y0) / (y1 - y0) * (panel_h - 40)
        dr.text((ox + 12, 8), f"{vn}  side elevation: local z / m above ground",
                fill=(20, 20, 20))
        for yy in (0.0, 0.5, 1.0, 1.5):
            dr.line((px(z0), py(yy), px(z1), py(yy)), fill=(226, 226, 222))
            dr.text((ox + 2, py(yy) - 4), f"{yy:.1f}", fill=(120, 120, 120))
        hmap = maps[mesh_of_variant[vn]]
        xs, zs, cell = origins[mesh_of_variant[vn]]
        ic = int((0.0 - xs) / cell)
        pts = [(zs + (j + 0.5) * cell, float(np.nanmax(hmap[max(0, ic - 12):ic + 13, j])))
               for j in range(hmap.shape[1])
               if np.isfinite(hmap[max(0, ic - 12):ic + 13, j]).any()]
        if len(pts) > 1:
            dr.line([(px(z), py(y)) for z, y in pts], fill=(150, 60, 30), width=3)
        for c in counter:
            if c["variant"] != vn:
                continue
            lz = c["lz"]
            bot = c["bottom"] - ground          # both axes are "above the walk plane"
            top = bot + c.get("h", 0.12)
            dr.rectangle((px(lz) - 7, py(top), px(lz) + 7, py(bot)),
                         outline=(180, 40, 40), width=2)
        dr.text((px(-0.8), panel_h - 16), "stall front ->", fill=(120, 120, 120))
    img.save(path)
    print(f"wrote {path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--glb", default=GLB)
    ap.add_argument("--json", default=f"{HERE}/out/stall-goods.json")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--baseline", default=f"{HERE}/out/stall-goods-baseline.json")
    ap.add_argument("--map", action="store_true")
    ap.add_argument("--stall", default=None, help="report one stall node only")
    ap.add_argument("--png", default=None, help="write a side-elevation chart here")
    ap.add_argument("--all", action="store_true", help="list every finding")
    a = ap.parse_args()

    rep, counter, ground_props, hanging, maps, origins = audit(
        a.glb, only_stall=a.stall)
    g = rep["goods"]
    print(f"\nstalls {rep['stalls']}  ground {rep['ground']:.3f}  "
          f"decode {','.join(rep['decode'])}"
          + (f"  filtered to {a.stall}" if a.stall else ""))
    if "envelope" in rep["decode"]:
        print("  WARNING: meshoptimizer missing -- instance translations unreadable; "
              "install it into ~/tmp-pip/pylibs (see stall_audit.py)")
    print(f"goods instances {g['total']}: counter {g['counter']}  ground {g['ground']}  "
          f"hanging {g['hanging']}  hidden (scale 0) {g['hidden']}")
    print(f"counter gap  median {rep['gap']['median']} m  range "
          f"{rep['gap']['lo']}..{rep['gap']['hi']} m")
    for k, v in sorted(rep["counts"].items()):
        print(f"  {k:16s} {v}")
    print(f"  stalls with floating goods {rep['stalls_with_float']}/{rep['stalls']}")
    print(f"  counter area clear of baked produce {rep['counter_clear']} pieces, "
          f"already occupied {rep['counter_occupied']}")
    if ground_props:
        d = [x for _r, x in ground_props]
        print(f"  ground props {len(d)}  bottom-vs-ground "
              f"{min(d):+.3f}..{max(d):+.3f} m")
    if a.map:
        doc = glb.load(a.glb).doc
        for mi in maps:
            ascii_map(maps[mi], origins[mi], doc["meshes"][mi].get("name") or str(mi))
    if a.png:
        elevation(counter, rep["mesh_of_variant"], maps, origins,
                  rep["ground"], a.png)
    if a.all:
        for f in rep["findings"][:300]:
            print(" ", f["type"], f["variant"], f["key"], f"x={f['x']} z={f['z']} "
                  f"bottom={f['bottom']} datum={f['datum']} gap={f['gap']:+}")
    json.dump(rep, open(a.json, "w"), indent=1)
    print(f"wrote {a.json}")

    if a.check:
        base = {"counts": {}, "stalls_with_float": 0, "gap": {"median": 0.0}}
        try:
            base.update(json.load(open(a.baseline)))
        except (OSError, ValueError):
            pass                        # no baseline yet: everything must be clean
        bad = []
        if "envelope" in rep["decode"]:
            bad.append("could not decode instance placements")
        if ground_props:
            bad.append(f"{len(ground_props)} loose goods on the plaza floor")
        for k in ("goods_floating", "goods_sunk", "goods_no_surface"):
            now, pin = rep["counts"].get(k, 0), base.get("counts", {}).get(k, 0)
            if now > pin:
                bad.append(f"{k} {pin} -> {now}")
        if rep["stalls_with_float"] > base.get("stalls_with_float", 0):
            bad.append(f"stalls_with_float {base.get('stalls_with_float', 0)} -> "
                       f"{rep['stalls_with_float']}")
        med = rep["gap"]["median"] or 0.0
        if abs(med) > max(abs(base.get("gap", {}).get("median") or 0.0), TOL):
            bad.append(f"median gap {base.get('gap', {}).get('median')} -> {med}")
        if bad:
            print("FAIL " + "; ".join(bad))
            return 1
        print("OK against baseline")
    return 0


if __name__ == "__main__":
    sys.exit(main())
