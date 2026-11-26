"""Prop placement audit: room layout JSONs x shipped library GLB geometry.

    python3 tools/city3/placement_audit.py [--index out/interiors/index.json]
        [--layouts out/interiors] [--lib apps/console/public/assets/world-city3-library.glb]
        [--wall 0.05] [--pen 0.02] [--baseline out/placement-baseline.json]
        [--update-baseline] [--verbose] [--selftest]

A layout prop is `[key, x, y, z, rotY, scale]` in three space (y up). Its box is
the LIB_<key> subtree bounds from the GLB (-Y front, y-up), times `scale`, rotated
about Y by rotY, sitting from y to y + height*scale. No rendering, no Blender.

Four checks, each with a planted control in --selftest:
  1. unknown key      -- a layout naming a prop the library does not ship renders
                         nothing and says nothing; this is the silent one.
  2. through-wall     -- any footprint corner outside the room rect by > --wall.
  3. duplicate        -- the same key twice at the same point.
  4. interpenetration -- two boxes overlapping deeper than --pen in plan, with the
                         same support level (|y0 difference| <= 2 cm).

Two rules keep the pair check honest against axis-aligned bounds:
  * CONTAINMENT IS NOT COLLISION. Books sit inside a bookcase's bounds, an
    armchair sits inside a rug's bounds, a bottle sits inside a shelving unit's.
    A prop whose footprint is fully inside another's, based at or above it, is
    mounted -- skipped.
  * Different support levels never compare: a bottle on a shelf is not colliding
    with the shelf, and a wall shelf is not colliding with the floor unit below.

The shipped layouts have a known, pinned baseline (out/placement-baseline.json):
`--baseline` fails only on findings NOT in it, `--update-baseline` re-pins after a
triage. Without a baseline the audit is honest and exits 1 on any finding. The
baseline exists because the first pass is real: 47 `counter_2m` pairs overlap by
0.10 m -- the asset is 2.1 m wide but the layout packs it on a 2.0 m module grid.
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import glb as G  # noqa: E402

ROOT = os.path.abspath(f"{HERE}/../..")
DEFAULT_INDEX = f"{HERE}/out/interiors/index.json"
DEFAULT_LAYOUTS = f"{HERE}/out/interiors"
DEFAULT_LIB = f"{ROOT}/apps/console/public/assets/world-city3-library.glb"
DEFAULT_BASELINE = f"{HERE}/out/placement-baseline.json"


def library_dims(path):
    """key -> (width_x, height_y, depth_z) in glTF axes, from world-space bounds."""
    g = G.load(path)
    world = G.world_matrices(g.doc)
    out = {}
    for name in g.names("LIB_"):
        b = G.subtree_bounds(g.doc, world, g.node_index(name))
        if b:
            out[name[4:]] = tuple(float(v) for v in (b[1] - b[0]))
    return out


def corners(x, z, hx, hz, rot):
    """Four footprint corners of a box rotated about Y by `rot` (three space)."""
    c, s = math.cos(rot), math.sin(rot)
    return [(x + px * c + pz * s, z - px * s + pz * c)
            for px, pz in ((-hx, -hz), (hx, -hz), (hx, hz), (-hx, hz))]


def _axes(rot):
    c, s = math.cos(rot), math.sin(rot)
    return ((c, s), (-s, c))


def _radius(hx, hz, rot, ux, uz):
    c, s = math.cos(rot), math.sin(rot)
    return hx * abs(ux * c + uz * s) + hz * abs(-ux * s + uz * c)


def sat_depth(a, b):
    """Penetration depth of two rotated footprints; 0 when they only touch."""
    (ax, az, ahx, ahz, ar), (bx, bz, bhx, bhz, br) = a, b
    best = float("inf")
    for ux, uz in _axes(ar) + _axes(br):
        d = abs((bx - ax) * ux + (bz - az) * uz)
        overlap = _radius(ahx, ahz, ar, ux, uz) + _radius(bhx, bhz, br, ux, uz) - d
        if overlap <= 0:
            return 0.0
        best = min(best, overlap)
    return best


def in_rect(px, pz, b, tol=0.0):
    """Point inside a rotated footprint (inverse-rotate into the box's frame)."""
    c, s = math.cos(b["rot"]), math.sin(b["rot"])
    dx, dz = px - b["x"], pz - b["z"]
    return abs(dx * c - dz * s) <= b["hx"] + tol and abs(dx * s + dz * c) <= b["hz"] + tol


def contained(a, b, tol=0.02):
    """True when a sits mounted in b: footprint inside, base not below."""
    if a["y0"] < b["y0"] - tol:
        return False
    return all(in_rect(px, pz, b, tol)
               for px, pz in corners(a["x"], a["z"], a["hx"], a["hz"], a["rot"]))


def prop_box(p, dims):
    """-> box dict for one layout prop, or None when the key is not in the library."""
    key, x, y, z, rot, scale = p[:6]
    d = dims.get(key)
    if not d:
        return None
    w, h, dep = d
    return dict(key=key, x=x, y0=y, z=z, rot=rot, scale=scale,
                hx=w * scale / 2, hz=dep * scale / 2, y1=y + h * scale)


def finding(room_id, kind, keys, x, z, depth=None, detail=""):
    """Stable, JSON-serialisable finding; `sig` is what the baseline pins."""
    return dict(room=room_id, kind=kind, keys=list(keys), x=round(x, 2), z=round(z, 2),
                depth=None if depth is None else round(depth, 3), detail=detail,
                sig=f"{room_id}|{kind}|{'x'.join(sorted(keys))}|{x:.1f}|{z:.1f}")


def audit_room(room, props, dims, wall, pen, room_id=None):
    """-> list of findings for one room."""
    rid = room_id or room.get("id", "?")
    x0, z0, x1, z1 = room["rect"]
    out, boxes = [], []
    for n, p in enumerate(props):
        b = prop_box(p, dims)
        if b is None:
            out.append(finding(rid, "unknown key", [p[0]], p[1], p[3],
                               detail=f"{p[0]} at prop #{n}"))
            continue
        boxes.append(b)
        for cx, cz in corners(b["x"], b["z"], b["hx"], b["hz"], b["rot"]):
            over = max(x0 - cx, cx - x1, z0 - cz, cz - z1, 0.0)
            if over > wall:
                out.append(finding(rid, "through wall", [b["key"]], b["x"], b["z"],
                                   over, f"{b['key']} overshoots {over:.2f} m"))
                break
    for i, a in enumerate(boxes):
        for b in boxes[i + 1:]:
            same_point = (abs(a["x"] - b["x"]) < 1e-6 and abs(a["z"] - b["z"]) < 1e-6
                          and abs(a["y0"] - b["y0"]) < 1e-6)
            if a["key"] == b["key"] and same_point:
                out.append(finding(rid, "duplicate", [a["key"]], a["x"], a["z"],
                                   detail=f"{a['key']} twice at y={a['y0']:.2f}"))
                continue
            if abs(a["y0"] - b["y0"]) > 0.02:            # different support level
                continue
            depth = sat_depth((a["x"], a["z"], a["hx"], a["hz"], a["rot"]),
                              (b["x"], b["z"], b["hx"], b["hz"], b["rot"]))
            if depth <= pen or contained(a, b) or contained(b, a):
                continue
            out.append(finding(rid, "interpenetration", [a["key"], b["key"]],
                               a["x"], a["z"], depth,
                               f"{a['key']} x {b['key']} depth {depth:.2f} m"))
    return out


def load_rooms(index_path, layouts_dir):
    """-> [(room, props)] for every room whose layout file exists."""
    rooms = []
    for r in json.load(open(index_path)):
        path = os.path.join(layouts_dir, f"{r['id']}.json")
        if os.path.exists(path):
            rooms.append((r, json.load(open(path)).get("props", [])))
    return rooms


def audit(rooms, dims, wall, pen):
    """-> (per_room, all_findings) ; per_room = [(id, n_props, findings)]."""
    per_room, every = [], []
    for room, props in rooms:
        v = audit_room(room, props, dims, wall, pen)
        per_room.append((room["id"], len(props), v))
        every.extend(v)
    return per_room, every


def pin(findings):
    return sorted({f["sig"] for f in findings})


def compare(findings, baseline_sigs):
    """-> (new, pinned) findings relative to a pinned baseline."""
    known = set(baseline_sigs)
    new = [f for f in findings if f["sig"] not in known]
    return new, [f for f in findings if f["sig"] in known]


def selftest(index_path, layouts, dims, wall, pen):
    """Planted defects; each must be caught and a legitimate stack must stay quiet."""
    rooms = load_rooms(index_path, layouts)
    room, props = next((r for r in rooms if len(r[1]) > 10), rooms[0])
    x0, z0, _, _ = room["rect"]
    key = next(p[0] for p in props if p[0] in dims)
    h = dims[key][1]
    rid = room["id"]
    base = audit_room(room, props, dims, wall, pen)
    out = [("clean room", "no new finding",
            f"{len(base)} existing", True)]

    bad = json.loads(json.dumps(props))
    bad[0][1], bad[0][3] = x0 - 1.5, z0 - 1.5
    got = {f["kind"] for f in audit_room(room, bad, dims, wall, pen)}
    out.append(("prop moved through wall", "through wall", ",".join(sorted(got)) or "none",
                "through wall" in got))

    bad = json.loads(json.dumps(props))
    bad.append(list(bad[0]))
    got = {f["kind"] for f in audit_room(room, bad, dims, wall, pen)}
    out.append(("duplicate prop", "duplicate", ",".join(sorted(got)) or "none",
                "duplicate" in got))

    bad = json.loads(json.dumps(props))
    bad.append(["no_such_prop_xyz", 0.0, 0.0, 0.0, 0.0, 1.0])
    got = {f["kind"] for f in audit_room(room, bad, dims, wall, pen)}
    out.append(("unknown key", "unknown key", ",".join(sorted(got)) or "none",
                "unknown key" in got))

    stacked = json.loads(json.dumps(props))
    p = list(props[0])
    p[2] = p[2] + h                       # same footprint, resting exactly on top
    stacked.append(p)
    before = len(audit_room(room, props, dims, wall, pen))
    after = len(audit_room(room, stacked, dims, wall, pen))
    out.append(("legitimate stack", "no new finding", f"{before} -> {after}",
                after == before))
    return out


def main(argv):
    index_path, layouts, lib = DEFAULT_INDEX, DEFAULT_LAYOUTS, DEFAULT_LIB
    baseline_path, update = DEFAULT_BASELINE, "--update-baseline" in argv
    wall, pen, verbose = 0.05, 0.02, "--verbose" in argv
    for a in argv:
        if a.startswith("--wall="):
            wall = float(a[7:])
        elif a.startswith("--pen="):
            pen = float(a[6:])
        elif a.startswith("--index="):
            index_path = a[8:]
        elif a.startswith("--layouts="):
            layouts = a[10:]
        elif a.startswith("--lib="):
            lib = a[6:]
        elif a.startswith("--baseline="):
            baseline_path = a[11:]
    if update and baseline_path is None:
        baseline_path = DEFAULT_BASELINE

    dims = library_dims(lib)
    rooms = load_rooms(index_path, layouts)
    per_room, every = audit(rooms, dims, wall, pen)
    print(f"LIB {os.path.basename(lib)}  {len(dims)} props  ROOMS {len(rooms)}  "
          f"wall {wall} m  pen {pen} m")

    shown = every
    if "--strict" in argv:
        shown = every                     # pinned findings count as failures too
    elif baseline_path and os.path.exists(baseline_path) and not update:
        new, pinned = compare(every, json.load(open(baseline_path))["signatures"])
        shown = new
        print(f"BASELINE {os.path.basename(baseline_path)}: {len(pinned)} pinned, "
              f"{len(new)} new")
    if update and baseline_path:
        os.makedirs(os.path.dirname(baseline_path), exist_ok=True)
        with open(baseline_path, "w") as f:
            json.dump({"note": "pinned placement findings; re-pin with --update-baseline",
                       "signatures": pin(every)}, f, indent=1)
        print(f"PINNED {len(every)} findings -> {baseline_path}")

    dirty = [r for r in per_room if any(f in shown for f in r[2])]
    print(f"  {'room':12s} {'props':>6s} {'issues':>7s}")
    for rid, n, v in sorted(dirty, key=lambda r: -len([f for f in r[2] if f in shown]))[:20]:
        print(f"  {rid:12s} {n:6d} {len([f for f in v if f in shown]):7d}")
    if verbose:
        for f in shown:
            print(f"    {f['room']:12s} {f['kind']:18s} {f['detail']}")
    kinds = {}
    for f in shown:
        kinds[f["kind"]] = kinds.get(f["kind"], 0) + 1
    print(f"{'FAILED' if shown else 'ALL OK'}  {len(shown)} findings in "
          f"{len(dirty)}/{len(rooms)} rooms  {kinds or '{}'}")

    failures = len(shown)
    if "--selftest" in argv:
        print("\nNEGATIVE CONTROLS (planted defects must be caught)")
        for name, expected, got, ok in selftest(index_path, layouts, dims, wall, pen):
            print(f"  {'ok  ' if ok else 'FAIL'} {name:26s} expect {expected:17s} got {got}")
            failures += 0 if ok else 1
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main(sys.argv[1:])

