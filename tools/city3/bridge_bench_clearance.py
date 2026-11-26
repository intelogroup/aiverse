#!/usr/bin/env python3
"""Slide the plaza-rim benches out of the stall footprints, in both shipped GLBs.

    python3 tools/city3/bridge_bench_clearance.py [--dry] [--report out/bench-clearance.json]

The defect: build_city.py's plaza-rim loop pulls each rim bench 3.2 m inward to face the
square, so eight of them land at (|x| = 26 or 52, z = +/-53.8) — inside the outer stall
row at z = +/-54. Measured on the shipped file: bench half extents 0.69 x 0.27 m, stall
1.50 x 0.77 m, so a bench centred 0.2 m from a stall centre overlaps it by
**1.04 x 0.54 m** — half the bench is inside the counter. Pinned as `bench_overlap` 8 in
out/stall-baseline.json since the stall replacement; this script is the fix.

Two files move, and they must move together or the walker bumps into nothing:
  1. world-city3.glb        — the 8 `SK_med_bench*` node translations
  2. world-city3-collision.glb — the oriented boxes inside the merged `col_props` mesh
     (collision.py:227 builds one obox per placed Sketchfab prop and merges them all)

The rule: slide the bench along x *toward the square* until it clears the stall by
0.15 m, which parks it in the gap between stalls instead of in front of a counter.
build_city.py carries the same rule so a regeneration lands in the same place.
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
sys.path.insert(0, HERE)
from bridge_wave1 import Glb, save_glb                           # noqa: E402
import stall_audit as audit_mod                                # noqa: E402

ASSETS = f"{HERE}/../../apps/console/public/assets"
WORLD = f"{ASSETS}/world-city3.glb"
COLLISION = f"{ASSETS}/world-city3-collision.glb"
MARGIN = 0.15          # clearance beyond touching, metres
# The authored model-stall envelope, NOT the measured mesh half (which is 1.39-1.50
# depending on variant). build_city.py de-conflicts BENCHES against the same 1.55 x 0.90
# constants, so using them here makes a regeneration land on exactly these numbers; the
# measured half would leave the two artifacts 0.15 m apart.
STALL_ENVELOPE = (1.55, 0.90)


def footprints(gltf, nodes):
    half = {}
    for n in nodes:
        if "mesh" not in n:
            continue
        half.setdefault(n["mesh"], audit_mod.mesh_footprint(gltf, n["mesh"]))
    out = {}
    for n in nodes:
        if "mesh" in n:
            hx, hz = half[n["mesh"]]
            s = n.get("scale", [1, 1, 1])
            out[id(n)] = (hx * abs(s[0]), hz * abs(s[2]))
    return out


def plan(gltf):
    """Decide every move: bench node -> new x, plus the delta applied to its collider."""
    stalls = [n for n in gltf["nodes"]
              if (n.get("name") or "").startswith(audit_mod.STALL_PREFIX) and "mesh" in n]
    benches = [n for n in gltf["nodes"]
               if (n.get("name") or "").startswith("SK_med_bench") and "mesh" in n]
    sh = footprints(gltf, stalls)
    bh = footprints(gltf, benches)
    moves = []
    for b in benches:
        t = b.get("translation", [0, 0, 0])
        bx, bz = t[0], t[2]
        hbx, hbz = bh[id(b)]
        for s in stalls:
            st = s.get("translation", [0, 0, 0])
            hx, hz = sh[id(s)]
            if abs(bx - st[0]) >= STALL_ENVELOPE[0] + hbx or abs(bz - st[2]) >= STALL_ENVELOPE[1] + hbz:
                continue
            sign = -1.0 if bx > 0 else 1.0          # slide toward the square's centre
            new_x = st[0] + sign * (STALL_ENVELOPE[0] + hbx + MARGIN)
            # never land inside a different stall
            for other in stalls:
                ot = other.get("translation", [0, 0, 0])
                ox, oz = sh[id(other)]
                if (abs(new_x - ot[0]) < ox + hbx
                        and abs(bz - ot[2]) < oz + hbz):
                    raise SystemExit(f"{b.get('name')} would move into "
                                     f"{other.get('name')} at x={new_x:.2f}")
            moves.append({"bench": b.get("name"), "old_x": round(bx, 3),
                          "new_x": round(new_x, 3), "z": round(bz, 3),
                          "stall": s.get("name"), "stall_x": round(st[0], 3),
                          "dx_before": round(abs(bx - st[0]), 3),
                          "dx_after": round(abs(new_x - st[0]), 3),
                          "required": round(hx + hbx + MARGIN, 3)})
            break
    return moves


def write_positions(g, ai, values):
    """Write a POSITION accessor back, compressed or plain, and keep min/max honest.

    `bridge_wave1.Glb.rewrite_accessor` always emits an EXT_meshopt_compression block;
    `col_props`' position view is *plain* float32, so calling it there produced a GLB
    Blender refuses with `KeyError: 'buffer'`. That is the second time this exact trap
    has bitten (see bridge_stalls.set_indices) and the lesson is the same: never assume
    a view is compressed, branch on it.
    """
    acc = g.gltf["accessors"][ai]
    view = g.gltf["bufferViews"][acc["bufferView"]]
    arr = np.asarray(values, dtype="<f4").reshape(-1, 3)
    if (view.get("extensions") or {}).get("EXT_meshopt_compression"):
        g.rewrite_accessor(ai, arr.tolist())
        return "meshopt"
    raw = arr.tobytes()
    assert len(raw) == view["byteLength"], (len(raw), view["byteLength"])
    off = view.get("byteOffset", 0)
    g.bin[off:off + len(raw)] = raw
    acc["min"] = [round(float(v), 5) for v in arr.min(axis=0)]
    acc["max"] = [round(float(v), 5) for v in arr.max(axis=0)]
    return "plain"


def move_colliders(moves, dry=False):
    """Shift the matching boxes inside the merged `col_props` mesh.

    collision.py merges one oriented box per placed prop into a single mesh, so the
    box for a bench is only findable by position: every vertex within the bench's
    footprint (plus a small slop) is translated with the visual node. Islands are
    separate, and the nearest other collider in these rows is the rim planter 3.2 m
    away, so a point selection is unambiguous -- asserted below before writing.
    """
    g = Glb(COLLISION)
    gltf = g.gltf
    node = next(n for n in gltf["nodes"] if (n.get("name") or "") == "col_props")
    prim = gltf["meshes"][node["mesh"]]["primitives"][0]
    ai = prim["attributes"]["POSITION"]
    pos = np.array(g.acc_raw(ai), dtype=np.float64, copy=True)
    report = []
    for m in moves:
        ox, oz = m["old_x"], m["z"]
        dx = m["new_x"] - ox
        sel = (np.abs(pos[:, 0] - ox) < 0.80) & (np.abs(pos[:, 2] - oz) < 0.36)
        n = int(sel.sum())
        if n == 0:
            report.append({**m, "collider_verts": 0, "note": "no collider found"})
            continue
        xs = pos[sel][:, 0]
        if xs.max() - xs.min() > 1.6:
            raise SystemExit(f"{m['bench']}: collider selection spans "
                             f"{xs.max() - xs.min():.2f} m, it caught two boxes")
        if not dry:
            pos[sel, 0] += dx
        report.append({**m, "collider_verts": n, "shift": round(dx, 3)})
    if not dry:
        mode = write_positions(g, ai, pos)
        save_glb(COLLISION, g.gltf, g.bin)
    return report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--report", default=f"{HERE}/out/bench-clearance.json")
    a = ap.parse_args()
    g = Glb(WORLD)
    moves = plan(g.gltf)
    print(f"{len(moves)} bench(es) inside a stall footprint")
    for m in moves:
        print(f"  {m['bench']:20s} x {m['old_x']:6.2f} -> {m['new_x']:6.2f}  z {m['z']:6.2f}"
              f"  vs {m['stall']} at {m['stall_x']:6.2f}  "
              f"dx {m['dx_before']:.2f} -> {m['dx_after']:.2f} (need {m['required']:.2f})")
    if a.dry:
        return 0
    for n in g.gltf["nodes"]:
        for m in moves:
            if (n.get("name") or "") == m["bench"]:
                n["translation"][0] = m["new_x"]
    save_glb(WORLD, g.gltf, g.bin)
    coll = move_colliders(moves)
    json.dump({"world": [m for m in moves], "collision": coll},
              open(a.report, "w"), indent=1)
    print(f"moved {sum(1 for c in coll if c.get('collider_verts'))} colliders, "
          f"wrote {a.report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

