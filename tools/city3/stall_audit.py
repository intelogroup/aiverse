#!/usr/bin/env python3
"""Audit the City 3 bazaar stalls: bare frames, floating awning sheets, repetition.

    python3 tools/city3/stall_audit.py [--glb PATH] [--json out/stall-audit.json]
    python3 tools/city3/stall_audit.py --check   # non-zero exit if above baseline

The bazaar has 80 stall positions (bridge_bazaar.stall_layout). Two populations share
them: 47 model stalls (`SK_med_stall*` nodes pointing at one 600-tri mesh) and 33
procedural fallbacks that promote_stalls() never replaced. The fallbacks are the
defect this tool exists for -- they keep only the shared `palette` posts/counter and a
two-triangle `awning` sheet, so from the ground they read as empty scaffolding with a
floating grey lid, which is why the plaza looks unfinished up close.

Findings:
  bare_frame      stall position with no model-stall node: procedural frame tris only
  floating_sheet  awning triangles above 2.9 m at a position with no stall node under
                  them (the supported model awnings sit at 3.05 m, so this is specific
                  to the unsupported sheets)
  thrifty_stalls  one mesh shared by every stall -> no variety at all
"""
import argparse
import json
import math
import os
import random
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
sys.path.insert(0, HERE)
from bridge_wave1 import Glb                                     # noqa: E402

GLB = f"{HERE}/../../apps/console/public/assets/world-city3.glb"
STALL_PREFIX = "SK_med_stall"
AWNING_Y = 2.9


def stall_layout():
    """The 80 positions, exactly as bridge_bazaar.py generates them."""
    out = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            for cx in (17, 26, 35, 44, 53):
                for cy in (18, 30, 42, 54):
                    if math.hypot(cx, cy) < 17:
                        continue
                    out.append((sx * cx, sy * cy, "N" if sy < 0 else "S"))
    return out


def selected_stalls(threshold=0.65):
    """Positions promote_stalls() turned into model stalls (seeded, deterministic)."""
    centers = stall_layout()
    return {i for i in range(len(centers))
            if random.Random(4000 + i).random() < threshold}


def tris_of(g, prim):
    if "indices" in prim:
        idx = g.indices_of(prim).astype(np.int64)
        return idx[:len(idx) // 3 * 3].reshape(-1, 3)
    pos = g.acc_raw(prim["attributes"]["POSITION"])
    return np.arange(len(pos) // 3 * 3).reshape(-1, 3)


def mesh_footprint(gltf, mi):
    """Union of every primitive's xz extents for one mesh (a stall has 3-5)."""
    lo = [1e9, 1e9]
    hi = [-1e9, -1e9]
    for prim in gltf["meshes"][mi]["primitives"]:
        acc = gltf["accessors"][prim["attributes"]["POSITION"]]
        lo = [min(lo[0], acc["min"][0]), min(lo[1], acc["min"][2])]
        hi = [max(hi[0], acc["max"][0]), max(hi[1], acc["max"][2])]
    return (hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2


def bench_overlaps(g, gltf, centers, nodes):
    """Benches standing inside a stall footprint.

    Pre-existing and NOT introduced by the stall replacement: build_city.py's baked
    BENCHES list puts eight of them 1.0 m off a stall centre, so half a bench sits
    inside the counter. Measured identically on the pre-edit GLB (overlap 1.04 x
    0.54 m), so the count is pinned in out/stall-baseline.json rather than moved --
    the bench layout belongs to the generator, which cannot run on this box.
    """
    half = {}
    for n in nodes:
        if "mesh" in n and n["mesh"] not in half:
            hx, hz = mesh_footprint(gltf, n["mesh"])
            s = n.get("scale", [1, 1, 1])
            half[n["mesh"]] = (hx * abs(s[0]), hz * abs(s[2]))
    out = []
    for n in gltf["nodes"]:
        name = n.get("name") or ""
        if not name.startswith(("SK_med_bench", "SK_med_crate")) or "mesh" not in n:
            continue
        t = n.get("translation", [0, 0, 0])
        s = n.get("scale", [1, 1, 1])
        bh = mesh_footprint(gltf, n["mesh"])
        bx, bz = bh[0] * abs(s[0]), bh[1] * abs(s[2])
        for i, (x, z, facing) in enumerate(centers):
            nodes_here = [k for k in nodes
                          if abs(k.get("translation", [0, 0, 0])[0] - x) < 1.0
                          and abs(k.get("translation", [0, 0, 0])[2] + z) < 1.0]
            if not nodes_here:
                continue
            sx, sz = half.get(nodes_here[0]["mesh"], (1.35, 0.69))
            dx, dz = abs(t[0] - x), abs(t[2] + z)
            if (bx + sx) > dx and (bz + sz) > dz and dx < sx and dz < sz:
                out.append({"type": "bench_overlap", "position": [x, z],
                            "bench": name, "facing": facing,
                            "overlap_m": [round(sx - dx + bx, 2),
                                          round(sz - dz + bz, 2)],
                            "why": "a bench/crate stands inside the stall counter "
                                   "(pre-existing: same overlap on the pre-edit GLB)"})
                break
    return out


def lantern_intersections(gltf, centers, nodes):
    """Lanterns whose body pokes through a stall roof.

    136 SK_lantern nodes hang over the stalls with their tops at y=2.82. The shipped
    stall roof was at 2.957, so there was 0.137 m of clearance; the first rebuild at
    2.45 m put the roof at 2.65 and drove 0.17 m of lantern through it. This check is
    why the map now says 2.72/2.66 m -- it is the regression the replacement could
    quietly ship.
    """
    roof = {}
    for n in nodes:
        t = n.get("translation", [0, 0, 0])
        s = n.get("scale", [1, 1, 1])
        top = -1e9
        for prim in gltf["meshes"][n["mesh"]]["primitives"]:
            acc = gltf["accessors"][prim["attributes"]["POSITION"]]
            top = max(top, acc["max"][1] * abs(s[1]) + t[1])
        for i, (x, z, _f) in enumerate(centers):
            if abs(t[0] - x) < 1.0 and abs(t[2] + z) < 1.0:
                roof[i] = max(roof.get(i, -1e9), top)
    out = []
    for n in gltf["nodes"]:
        if not (n.get("name") or "").startswith("SK_lantern"):
            continue
        t = n.get("translation", [0, 0, 0])
        s = n.get("scale", [1, 1, 1])
        acc = gltf["accessors"][gltf["meshes"][n["mesh"]]["primitives"][0]
                                ["attributes"]["POSITION"]]
        top = acc["max"][1] * abs(s[1]) + t[1]
        for i, (x, z, facing) in enumerate(centers):
            if i not in roof or abs(t[0] - x) >= 2.4 or abs(t[2] + z) >= 2.0:
                continue
            if top > roof[i] + 0.005:
                out.append({"type": "lantern_through_roof", "position": [x, z],
                            "lantern": n.get("name"), "facing": facing,
                            "through_m": round(top - roof[i], 3),
                            "why": "lantern body rises above the stall roof"})
    return out


def audit(path):
    g = Glb(path)
    gltf = g.gltf
    centers = stall_layout()
    nodes = [n for n in gltf["nodes"] if (n.get("name") or "").startswith(STALL_PREFIX)]
    occupied = set()          # a position is modelled if a stall node stands within 1 m
    for n in nodes:
        t = n.get("translation", [0, 0, 0])
        for i, (x, y, _f) in enumerate(centers):
            if abs(t[0] - x) < 1.0 and abs(t[2] + y) < 1.0:
                occupied.add(i)
    findings = []
    meshes = {}
    for n in nodes:
        if "mesh" in n:
            meshes[n["mesh"]] = meshes.get(n["mesh"], 0) + 1
    # Leftover procedural stall geometry: promote_stalls() only deleted the frame at
    # the positions it promoted on THAT run, so every earlier-promoted position still
    # carries ~66 `palette` tris (four posts, rails, a counter) under the model stall.
    # Measured before the fix: 59 of 80 positions, and each with a 2-triangle `awning`
    # sheet at y=3.50 floating above the model's own 2.76 m canopy.
    leftover, sheets = {}, {}
    for mesh in gltf["meshes"]:
        name = mesh.get("name") or ""
        if name not in ("palette", "awning"):
            continue
        for prim in mesh["primitives"]:
            pos = g.acc_raw(prim["attributes"]["POSITION"])
            tri = tris_of(g, prim)
            if not len(tri):
                continue
            mid = pos[tri].mean(1)
            # Degenerate tris are how this repo deletes geometry (the bridge collapses
            # a killed triangle onto one vertex). Their midpoint still sits in the
            # box, so counting them would report the same finding after the fix.
            area = 0.5 * np.linalg.norm(np.cross(pos[tri[:, 1]] - pos[tri[:, 0]],
                                                 pos[tri[:, 2]] - pos[tri[:, 0]]), axis=1)
            live = area > 1e-9
            if not live.any():
                continue
            mid, tri = mid[live], tri[live]
            area = area[live]
            for i, (x, y, facing) in enumerate(centers):
                sel = ((np.abs(mid[:, 0] - x) < 2.4) & (np.abs(mid[:, 2] + y) < 2.0)
                       & (mid[:, 1] > 0.1))
                if not sel.any():
                    continue
                ys = mid[sel][:, 1]
                if name == "awning" and ys.max() > AWNING_Y:
                    sheets.setdefault(i, []).append(round(float(ys.mean()), 2))
                else:
                    leftover[i] = leftover.get(i, 0) + int(sel.sum())
    for i, n in sorted(leftover.items()):
        if n < 20:
            continue
        x, y, facing = centers[i]
        findings.append({"type": "leftover_frame", "position": [x, y], "facing": facing,
                         "tris": n,
                         "why": "procedural posts/rails/counter still stand under the "
                                "model stall (promote_stalls never cleaned this position)"})
    for i, ys in sorted(sheets.items()):
        x, y, facing = centers[i]
        findings.append({"type": "floating_sheet", "position": [x, y], "facing": facing,
                         "tris": 2 * len(ys), "y": max(ys),
                         "why": "two-triangle awning sheet floating above the canopy"})
    if len(nodes) > 1 and len(meshes) <= 1:
        findings.append({"type": "thrifty_stalls", "count": len(nodes),
                         "why": "every stall is the same mesh: no variety in the "
                                "largest open space in the city"})
    findings.extend(bench_overlaps(g, gltf, centers, nodes))
    findings.extend(lantern_intersections(gltf, centers, nodes))
    rep = {"glb": os.path.relpath(path, HERE), "stalls": len(centers),
           "model_nodes": len(nodes),
           "procedural_positions": len(centers) - len(occupied),
           "distinct_stall_meshes": len(meshes),
           "mesh_instances": {gltf["meshes"][k].get("name"): v for k, v in meshes.items()},
           "findings": findings, "counts": {}}
    for f in findings:
        rep["counts"][f["type"]] = rep["counts"].get(f["type"], 0) + 1
    return rep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--glb", default=GLB)
    ap.add_argument("--json", default=f"{HERE}/out/stall-audit.json")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--baseline", default=f"{HERE}/out/stall-baseline.json")
    a = ap.parse_args()
    rep = audit(a.glb)
    print(f"stalls {rep['stalls']}  model nodes {rep['model_nodes']}  procedural "
          f"positions {rep['procedural_positions']}  distinct stall meshes "
          f"{rep['distinct_stall_meshes']}")
    for k, v in sorted(rep["counts"].items()):
        print(f"  {k:16s} {v}")
    if not a.check:
        json.dump(rep, open(a.json, "w"), indent=1)
        print(f"wrote {a.json}")
        return 0
    base = json.load(open(a.baseline)) if os.path.exists(a.baseline) else {"findings": []}
    allowed = {}
    for f in base.get("findings", []):
        allowed[f["type"]] = allowed.get(f["type"], 0) + 1
    bad = {k: v for k, v in rep["counts"].items() if v > allowed.get(k, 0)}
    if bad:
        print(f"FAIL: {bad} exceeds baseline {allowed}")
        return 1
    print(f"OK: nothing above baseline {allowed or '{}'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

