"""GLB dimensions vs a kit spec JSON, at 3% tolerance, transform-aware.

    python3 tools/city3/dims_gate.py [glb] [--spec out/interior-kit.json]
                                     [--tol 0.03] [--selftest]

The spec (`out/interior-kit.json`, written by kit_interiors.py) records each
asset's dims as measured in Blender: Z-up [x, depth, height]. A shipped GLB is
Y-up [x, height, depth], so the comparison permutes the GLB axes first -- without
that, 10 of the 11 kit assets read as 17-2778% wrong while being perfect.

Bounds come from accessor min/max through the composed scene graph (glb.py), so
this works on EXT_meshopt_compression GLBs whose buffers Blender-free code cannot
decode. The scene graph is the point: a node scaled 1.25 at export still has
life-size accessor extents, and a transform-blind gate misses exactly that.

--selftest plants four defects and requires each to be caught, and requires the
transform-blind variant to MISS the scaled one -- that miss is the proof the
composition is load-bearing, not decoration. Exit 1 on any real failure.
"""
import copy
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import glb as G  # noqa: E402

DEFAULT_GLB = os.path.abspath(f"{HERE}/../../apps/console/public/assets/interior-kit.glb")
DEFAULT_SPEC = os.path.abspath(f"{HERE}/out/interior-kit.json")


def check_pinned(g, pinned, tol):
    """Compare every node named in a pinned spec (all LIB_ dims, not just the kit)."""
    rows, failures = [], []
    for name, ref in pinned["props"].items():
        dims = dims_of(g.doc, name)
        if dims is None:
            rows.append(dict(key=name, node=name, verdict="NO GEOMETRY"))
            failures.append(name)
            continue
        shown = G.to_blender(dims)
        ok, err, axis_i = verdict(dims, ref, tol)
        rows.append(dict(key=name[4:] if name.startswith("LIB_") else name, node=name,
                         glb=[round(float(v), 3) for v in shown], spec=ref,
                         err=round(err, 4), axis="xyz"[axis_i],
                         verdict="ok" if ok else "OUT OF TOLERANCE"))
        if not ok:
            failures.append(name)
    return rows, failures


def pin(g, path):
    """Write every LIB_ node's world dims (Blender axes) as a pinned spec."""
    world = G.world_matrices(g.doc)
    props = {}
    for name in g.names("LIB_"):
        b = G.subtree_bounds(g.doc, world, g.node_index(name))
        if b:
            props[name] = [round(float(v), 4) for v in G.to_blender(b[1] - b[0])]
    with open(path, "w") as f:
        json.dump({"note": "pinned LIB_ dims (Blender axes); re-pin after an intended change",
                   "source": os.path.basename(g.path), "props": props}, f, indent=1,
                  sort_keys=True)
    print(f"PINNED {len(props)} LIB_ dims -> {path}")


def node_for(g, key, asset_id=None):
    """First existing node name for an asset: LIB_<key>, LIB_<id>, <key>, <id>."""
    for name in (f"LIB_{key}", f"LIB_{asset_id}", key, asset_id):
        if name and g.node_index(name) is not None:
            return name
    return None


def dims_of(doc, node_name):
    """World-space dims of a named node's subtree, in glTF axes, or None."""
    g = G.GLB("", doc, b"", 0)
    i = g.node_index(node_name)
    if i is None:
        return None
    b = G.subtree_bounds(doc, G.world_matrices(doc), i)
    return None if b is None else b[1] - b[0]


def dims_blind(doc, node_name):
    """Dims with NO scene-graph composition: raw accessor extents, unioned.

    The naive measurement this gate replaced. It ignores node scale, rotation and
    parent chains, so it exists only as a negative control.
    """
    g = G.GLB("", doc, b"", 0)
    i = g.node_index(node_name)
    if i is None:
        return None
    lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
    stack = [i]
    while stack:
        n = doc["nodes"][stack.pop()]
        if "mesh" in n:
            box = G.mesh_aabb(doc, n["mesh"])
            if box:
                lo, hi = np.minimum(lo, box[0]), np.maximum(hi, box[1])
        stack.extend(n.get("children", []))
    return None if not np.isfinite(lo).all() else hi - lo


def verdict(glb_dims, spec_dims, tol, axis=True):
    """(ok, worst relative error, worst axis index) for one asset."""
    d = np.array(G.to_blender(glb_dims) if axis else glb_dims, dtype=np.float64)
    s = np.array(spec_dims, dtype=np.float64)
    rel = np.abs(d - s) / np.maximum(np.abs(s), 1e-9)
    k = int(np.argmax(rel))
    return bool(rel[k] <= tol), float(rel[k]), k


def check(g, spec, tol, axis=True):
    """-> (rows, failures); rows are dicts ready for printing or serialising."""
    rows, failures = [], []
    for a in spec["assets"]:
        key = a["key"]
        name = node_for(g, key, a.get("id"))
        dims = dims_of(g.doc, name) if name else None
        if name is None:
            rows.append(dict(key=key, node=None, verdict="NO NODE"))
            failures.append(key)
            continue
        if dims is None:
            rows.append(dict(key=key, node=name, verdict="NO GEOMETRY"))
            failures.append(key)
            continue
        ok, err, axis_i = verdict(dims, a["dims"], tol, axis)
        shown = G.to_blender(dims) if axis else list(dims)
        rows.append(dict(key=key, node=name, glb=[round(float(v), 3) for v in shown],
                         spec=a["dims"], err=round(err, 4), axis="xyz"[axis_i],
                         verdict="ok" if ok else "OUT OF TOLERANCE"))
        if not ok:
            failures.append(key)
    return rows, failures



def mutate(doc, node_name, kind):
    """Planted defect on a deep copy: scale 1.25, rotY 90, or move a child 0.5 m."""
    d = copy.deepcopy(doc)
    i = G.GLB("", d, b"", 0).node_index(node_name)
    n = d["nodes"][i]
    if kind == "scale":
        n["scale"] = [1.25, 1.25, 1.25]
    elif kind == "rotate":
        s = 2 ** -0.5
        n["rotation"] = [0.0, s, 0.0, s]
    elif kind == "translate":
        kids = n.get("children") or []
        (d["nodes"][kids[0]] if kids else n)["translation"] = [0.5, 0.0, 0.0]
    n.pop("matrix", None)
    return d


def world_box(doc, node_name):
    """World AABB (lo, hi) of a named node's subtree, or None."""
    g = G.GLB("", doc, b"", 0)
    i = g.node_index(node_name)
    return None if i is None else G.subtree_bounds(doc, G.world_matrices(doc), i)


def wrap_scale(doc, node_name, factor):
    """Reparent the node under a fresh empty scaled by `factor`.

    This is the parent-chain case: the mesh's own node stays untouched, so any
    gate that composes only the leaf node's matrix misses it entirely.
    """
    d = copy.deepcopy(doc)
    i = G.GLB("", d, b"", 0).node_index(node_name)
    root = d["nodes"][i]
    root["translation"] = [-(v * (factor - 1)) / factor for v in
                           (root.get("translation") or [0, 0, 0])]
    new_i = len(d["nodes"])
    d["nodes"].append({"name": f"W_scale_{node_name}", "scale": [factor] * 3,
                       "children": [i]})
    sc = d.setdefault("scenes", [{"nodes": []}])[d.get("scene", 0)]
    sc["nodes"] = [new_i if r == i else r for r in sc.get("nodes", [])] or [new_i]
    return d


def selftest(g, spec, tol):
    """Planted controls -> [(control, expected, got, ok)]."""
    probe = spec["assets"][0]
    for a in spec["assets"]:                      # prefer a non-cubic probe
        if a["key"] == "mirror":
            probe = a
    name = node_for(g, probe["key"], probe.get("id"))
    out = []

    _, fails = check(g, spec, tol, axis=True)
    out.append(("clean + axis permute", "all pass",
                "all pass" if not fails else f"FAIL {fails}", not fails))

    _, fails_na = check(g, spec, tol, axis=False)
    out.append(("axis permute skipped", "many false failures",
                f"{len(fails_na)}/{len(spec['assets'])} fail", len(fails_na) > 0))

    d = mutate(g.doc, name, "scale")
    caught = not verdict(dims_of(d, name), probe["dims"], tol)[0]
    blind = not verdict(dims_blind(d, name), probe["dims"], tol)[0]
    out.append((f"node scale 1.25 on {probe['key']}", "caught, blind misses",
                f"caught={caught} blind_caught={blind}", caught and not blind))

    d = mutate(g.doc, name, "rotate")
    caught = not verdict(dims_of(d, name), probe["dims"], tol)[0]
    out.append((f"node rotY 90 on {probe['key']}", "caught",
                f"caught={caught}", caught))

    d = wrap_scale(g.doc, name, 1.25)
    caught = not verdict(dims_of(d, name), probe["dims"], tol)[0]
    out.append((f"parent empty scale 1.25 over {probe['key']}", "caught",
                f"caught={caught}", caught))

    before = np.array(world_box(g.doc, name)[0])
    after = np.array(world_box(mutate(g.doc, name, "translate"), name)[0])
    moved = bool(np.abs(after - before).max() > 1e-6)
    out.append((f"child moved 0.5m under {probe['key']}", "bounds move",
                f"moved={moved}", moved))
    return out



def main(argv):
    src, spec_path, tol = DEFAULT_GLB, DEFAULT_SPEC, 0.03
    rest, i = [], 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("--tol="):
            tol = float(a[6:])
        elif a == "--tol":
            i += 1
            tol = float(argv[i])
        elif a.startswith("--spec="):
            spec_path = a[7:]
        elif a == "--spec":
            i += 1
            spec_path = argv[i]
        elif not a.startswith("--"):
            rest.append(a)
        i += 1
    if rest:
        src = rest[0]

    g = G.load(src)
    pin_path = next((a.split("=", 1)[1] for a in argv if a.startswith("--pin=")), None)
    if pin_path:
        pin(g, pin_path)
        sys.exit(0)
    spec = json.load(open(spec_path))
    pinned = "props" in spec
    print(f"SPEC {os.path.basename(spec_path)}  GLB {os.path.basename(src)}  "
          f"tol {tol * 100:.0f}%  requires={g.requires() or '-'}  "
          f"mode={'pinned' if pinned else 'kit-spec'}")
    print(f"  {'asset':17s} {'node':20s} {'glb (blender axes)':24s} {'spec':24s} "
          f"{'err':>6s}  axis  verdict")
    rows, failures = (check_pinned(g, spec, tol) if pinned else check(g, spec, tol))
    shown = rows if not pinned else [r for r in rows if r["verdict"] != "ok"][:20]
    for r in shown:
        if r.get("node") is None:
            print(f"  {r['key']:17s} {'-':20s}  {r['verdict']}")
            continue
        print(f"  {r['key']:17s} {r['node']:20s} {str(r['glb']):24s} {str(r['spec']):24s} "
              f"{r['err'] * 100:5.1f}%  {r['axis']:>4s}  {r['verdict']}")
    if pinned:
        print(f"  ({len(rows) - len(shown)} of {len(rows)} LIB_ assets within tolerance)")
    print(f"{'FAILED' if failures else 'ALL OK'}  {len(failures)}/{len(rows)} out of tolerance")

    if "--selftest" in argv:
        print("\nNEGATIVE CONTROLS (every planted defect must be caught)")
        for name, expected, got, ok in selftest(g, spec, tol):
            print(f"  {'ok  ' if ok else 'FAIL'} {name:42s} expect {expected:22s} got {got}")
            if not ok:
                failures.append("control:" + name)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main(sys.argv[1:])
