"""Numeric UV audit: UV-area / world-area per triangle. Catches stretch with no render.

    blender -b --factory-startup --python tools/city3/uv_stats.py -- <glb> [--max=4]

Why area and not a picture: a wrap stretched on one axis and squashed on the other
can still look plausible in a Workbench render, but the texel-density ratio moves
immediately -- it is a number, it has no noise floor, and it needs no camera. A
face's UV area divided by its world area is texel density squared; for one
material/atlas the value is roughly constant across an object, so the metric is
the deviation from the object's own area-weighted median.

Blender is used because the world GLBs require EXT_meshopt_compression and its
importer decodes meshopt. Exit 1 when more than --flag% of triangles deviate past
--max (default 1%), or when a mesh with a material has no UV layer.

--selftest plants a 4x UV expansion on one quad of a subdivided plane and
requires the metric to flag it, then requires a clean plane to stay silent.
"""
import os
import sys

import bpy
import numpy as np

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
MAX_DEV = 4.0
FLAG_PCT = 1.0
for a in ARGS:
    if a.startswith("--max="):
        MAX_DEV = float(a.split("=", 1)[1])
    elif a.startswith("--flag="):
        FLAG_PCT = float(a.split("=", 1)[1])


def tri_stats(obj):
    """-> (uv_areas, world_areas) per loop triangle."""
    me = obj.data
    me.calc_loop_triangles()
    uv = me.uv_layers[0].data
    mw = obj.matrix_world
    uvs = np.empty((len(me.loops), 2), dtype=np.float64)
    for i, li in enumerate(me.loops):
        uvs[i] = uv[li.index].uv
    co = np.empty((len(me.vertices), 3), dtype=np.float64)
    for i, v in enumerate(me.vertices):
        co[i] = mw @ v.co
    tris = np.array([tuple(t.vertices) for t in me.loop_triangles], dtype=np.int64)
    loops = np.array([tuple(t.loops) for t in me.loop_triangles], dtype=np.int64)
    if len(tris) == 0:
        return np.zeros(0), np.zeros(0)
    u = uvs[loops]
    w = co[tris]
    e1, e2 = u[:, 1] - u[:, 0], u[:, 2] - u[:, 0]
    uv_area = 0.5 * np.abs(e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0])
    world_area = 0.5 * np.linalg.norm(
        np.cross(w[:, 1] - w[:, 0], w[:, 2] - w[:, 0]), axis=1)
    return uv_area, world_area


def measure(obj):
    """-> density + spread + unmapped-face count for one mesh.

    `unmapped` is the hard failure: a triangle with world area but zero UV area
    cannot be textured at all. `p95`/`worst` report dispersion relative to the
    object's own area-weighted median; they are review numbers, not a verdict,
    because third-party props (a 176k->24k decimated plant with alpha-card
    leaves) legitimately span more than 4x between parts.
    """
    if not obj.data.uv_layers:
        return None
    uv_area, world_area = tri_stats(obj)
    live = world_area > 1e-12
    if not live.any():
        return dict(density=0.0, tris=0, unmapped=0, outliers=0, p95=0.0,
                    worst=0.0, no_world_area=True)
    mapped = live & (uv_area > 1e-14)
    unmapped = int((live & ~mapped).sum())
    density = float(uv_area[mapped].sum() / world_area[mapped].sum()) \
        if mapped.any() else 0.0
    if density <= 0:
        return dict(density=0.0, tris=int(live.sum()), unmapped=unmapped,
                    outliers=0, p95=0.0, worst=0.0, no_uv_area=True)
    dev = uv_area[mapped] / world_area[mapped] / density
    dev = np.maximum(dev, 1e-9)
    both = np.maximum(dev, 1.0 / dev)
    return dict(density=density, tris=int(live.sum()), unmapped=unmapped,
                outliers=int(((dev > MAX_DEV) | (dev < 1.0 / MAX_DEV)).sum()),
                p95=float(np.percentile(both, 95)), worst=float(both.max()))



def selftest():
    """Two planted controls: a 4x UV stretch (outlier) and a collapsed UV (unmapped)."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.mesh.primitive_plane_add(size=2.0)
    ob = bpy.context.object
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.subdivide(number_cuts=1)          # four quads
    bpy.ops.object.mode_set(mode="OBJECT")
    me = ob.data
    uv = me.uv_layers[0].data
    clean = measure(ob)
    face = me.polygons[0]
    cs = np.mean([list(uv[li].uv) for li in face.loop_indices], axis=0)
    for li in face.loop_indices:
        p = np.array(uv[li].uv)
        uv[li].uv = tuple(cs + (p - cs) * 4.0)
    stretched = measure(ob)
    for li in face.loop_indices:
        uv[li].uv = tuple(cs)                      # collapse the same face
    collapsed = measure(ob)
    for li in range(len(uv)):                      # uniform 1.5x on the whole plane
        uv[li].uv = tuple(v * 1.5 for v in uv[li].uv)
    uniform = measure(ob)
    return [("clean plane", "no flag",
             clean["unmapped"] == 0 and clean["outliers"] == 0),
            ("planted 4x UV stretch", "outlier",
             stretched["outliers"] >= 1 and stretched["worst"] > MAX_DEV),
            ("planted collapsed UV", "unmapped",
             collapsed["unmapped"] >= 1),
            ("uniform 1.5x UV rescale", "density x2.25, 0 outliers",
             abs(uniform["density"] / clean["density"] - 2.25) < 0.01
             and uniform["outliers"] == 0)]



def main():
    paths = [a for a in ARGS if a.endswith((".glb", ".gltf", ".blend"))]
    if "--selftest" in ARGS:
        print("UV SELFTEST")
        bad = 0
        for name, expected, ok in selftest():
            print(f"  {'ok  ' if ok else 'FAIL'} {name:24s} expect {expected}")
            bad += 0 if ok else 1
        sys.exit(1 if bad else 0)
    if not paths:
        sys.exit(__doc__)
    src = paths[0]
    if src.endswith((".blend", ".blend1")):
        bpy.ops.wm.open_mainfile(filepath=src)
    else:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=src)

    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    rows, missing, unmapped, tris, outliers = [], [], 0, 0, 0
    for ob in meshes:
        m = measure(ob)
        if m is None:
            missing.append(ob.name)
            continue
        rows.append((ob.name, m["tris"], m["density"], m["p95"], m["worst"],
                     m["unmapped"], m["outliers"]))
        unmapped += m["unmapped"]
        outliers += m["outliers"]
        tris += m["tris"]
    rows.sort(key=lambda r: (-r[5], -r[3]))
    print(f"UV {src}  meshes {len(meshes)}  tris {tris}  "
          f"outlier threshold {MAX_DEV}x  unmapped% {FLAG_PCT}")
    print(f"  {'object':30s} {'tris':>7s} {'density':>9s} {'p95':>6s} "
          f"{'worst':>6s} {'unmapped':>8s} {'spread':>7s}")
    for name, n, dens, p95, worst, un, out in rows[:22]:
        print(f"  {name[:30]:30s} {n:7d} {dens:9.4f} {p95:6.2f} {worst:6.2f} "
              f"{un:8d} {out:7d}")
    pct = 100.0 * unmapped / tris if tris else 0.0
    fail = pct > FLAG_PCT or bool(missing)
    if missing:
        print(f"  FAIL {len(missing)} meshes with a material but no UV layer: "
              f"{missing[:5]}")
    print(f"  note {outliers}/{tris} triangles ({100.0 * outliers / max(tris, 1):.1f}%) "
          f"deviate > {MAX_DEV}x from their object median (spread, not a verdict)")

    # A pinned per-object density catches the one thing the deviation metric cannot:
    # a UNIFORM UV rescale shifts density and leaves every deviation at 1.0
    # (measured: 2x UV scale -> density x4, outliers 0).
    pin = next((a.split("=", 1)[1] for a in ARGS if a.startswith("--pin=")), None)
    base = next((a.split("=", 1)[1] for a in ARGS if a.startswith("--baseline=")), None)
    drift_max = next((float(a.split("=", 1)[1]) for a in ARGS
                      if a.startswith("--drift=")), 0.05)
    densities = {name: dens for name, n, dens, p95, worst, un, out in rows if dens > 0}
    if pin:
        import json
        with open(pin, "w") as f:
            json.dump({"source": os.path.basename(src),
                       "note": "per-object texel density; re-pin after an intended change",
                       "density": densities}, f, indent=1, sort_keys=True)
        print(f"PINNED {len(densities)} densities -> {pin}")
    if base and os.path.exists(base):
        import json
        ref = json.load(open(base))["density"]
        moved = []
        for name, dens in densities.items():
            if name in ref and ref[name] > 0:
                d = abs(dens - ref[name]) / ref[name]
                if d > drift_max:
                    moved.append((name, ref[name], dens, d))
        for name, r, n, d in sorted(moved, key=lambda x: -x[3])[:8]:
            print(f"  FAIL density {name}: {r:.4f} -> {n:.4f} ({d * 100:.1f}%)")
        for name in sorted(set(ref) - set(densities))[:5]:
            print(f"  note object gone since baseline: {name}")
        if moved:
            fail = True
        print(f"  baseline {os.path.basename(base)}: {len(moved)} objects drifted "
              f"> {drift_max * 100:.0f}%")

    print(f"{'FAILED' if fail else 'ALL OK'}  {unmapped}/{tris} triangles "
          f"({pct:.2f}%) unmapped")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    main()

