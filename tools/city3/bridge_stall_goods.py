#!/usr/bin/env python3
"""Re-place the bazaar goods onto the stall counters -- one stall at a time.

    python3 tools/city3/bridge_stall_goods.py --stall SK_med_stall_BazaarPass_43 --dry
    python3 tools/city3/bridge_stall_goods.py --stall SK_med_stall_BazaarPass_43 --out /tmp/w.glb
    python3 tools/city3/bridge_stall_goods.py --stall ... --out ... --apply   # in place

`stall_goods_audit.py` measures the defect: `bridge_stalls.py` replaced the stall
meshes, so every counter piece stands 0.17-0.31 m above its table, a third of them
past the counter edge entirely, and 396 of 535 would land inside the stalls' own baked
produce if simply lowered. This bridge fixes one stall at a time so a single stall can
be looked at before 80 are touched.

What it does, per piece of the chosen stall:

1. **Nudge, then drop.** Try the piece where it is, then offsets along the counter
   (`--step`, up to `--reach`), and keep the first spot where (a) counter cells exist
   under the whole footprint and (b) the stall's baked produce does not already occupy
   it. Nothing valid -> the piece is dropped from that stall (and reported).
2. **Rest it on the table.** New translation y = ground + datum - local ymin, so the
   *underside* is on the counter. The datum is the **max** counter cell under the
   footprint: variant A's table is tilted ~12 deg and we cannot tilt the piece, so it
   sits on the high side and never sinks.
3. **Rewrite the instance accessors.** TRANSLATION / ROTATION / SCALE are re-encoded
   through `bridge_wave1.Glb.rewrite_accessor` (meshopt stream appended, old bytes left
   dead). Instances of every other stall keep their exact values, and the three arrays
   stay the same length -- glTF requires that.

Tilting and hanging are out of scope: a piece whose instance rotation is not about Y is
skipped (reported as `skipped_tilted`), and goods hung from the awning rail (translation
above `HANG_Y`) are left alone -- their rail height is a separate defect.
"""
import argparse
import json
import math
import os
import sys
import types

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
for p in (os.path.expanduser("~/tmp-pip/pylibs"), HERE):
    if p not in sys.path:
        sys.path.insert(0, p)
import glb                                                        # noqa: E402
import stall_goods_audit as audit_mod                             # noqa: E402
from bridge_drop_planters import components
from bridge_landscape_kit import add_accessor, add_view
from bridge_wave1 import Glb, save_glb                             # noqa: E402

GLB = f"{HERE}/../../apps/console/public/assets/world-city3.glb"
GOODS_PREFIX = "inst_goods_"
STALL_PREFIX = "SK_med_stall"
# world x/z of STALL_CONSUMABLES (packages/world-sim/src/stallConsumables.ts)
PINNED = ((26.15, 29.38), (17.39, 41.38))


def adapter(g):
    """The audit's decoder wants `.doc`/`.bin`; bridge_wave1.Glb calls them gltf/BIN.

    `bin` is handed over as the live bytearray, not a copy: `rewrite_accessor` appends
    to it, and a snapshot taken before the first rewrite makes every later decode read
    the old offsets (meshopt then fails with -2, or worse, decodes the wrong stream).
    """
    return types.SimpleNamespace(doc=g.gltf, bin=g.bin)


def stall_state(g, name):
    """Counter + clutter height fields for one stall, and its world transform."""
    doc = g.gltf
    idx = {n.get("name"): i for i, n in enumerate(doc["nodes"])}
    if name not in idx:
        raise SystemExit(f"no node named {name}")
    i = idx[name]
    node = doc["nodes"][i]
    world = glb.world_matrices(doc)
    W = world[i]
    adapter_g = adapter(g)
    tris, area = audit_mod.stall_tris(adapter_g)[node["mesh"]]
    counter, origin = audit_mod.counter_map(tris, area)
    return dict(node=node, name=name, mesh=node["mesh"],
                mesh_name=doc["meshes"][node["mesh"]].get("name"),
                T=np.array(node.get("translation", [0, 0, 0]), float),
                ground=float(node.get("translation", [0, 0, 0])[1]),
                W=W, W_inv=np.linalg.inv(W), counter=counter, origin=origin,
                clutter=audit_mod.clutter_map(tris))


def datum(st, lx, lz, half):
    """Datum under a footprint -- the audit's `support()`, so both agree by construction."""
    # all nine samples: a placed piece may not hang over the counter edge
    return audit_mod.support(st["counter"], st["origin"], lx, lz, half, need=9)



def occupied(st, lx, lz, half, level, margin=0.05):
    """Is the stall's own baked produce already standing here?

    Same footprint rule as the audit's `occupied` check (full half-extents, no inner
    shrink) -- being laxer here just moves the finding from the bridge to the gate.
    """
    return audit_mod.occupied_hit(st["clutter"], st["origin"], lx, lz, half, level, margin)



def pinned(t):
    return any(math.hypot(t[0] - x, t[2] - z) < 0.3 for x, z in PINNED)


def clash(a, b, margin=0.02):
    """Two pieces overlapping in the counter plane (both (lx, lz, hx, hz))."""
    return (abs(a[0] - b[0]) < a[2] + b[2] - margin
            and abs(a[1] - b[1]) < a[3] + b[3] - margin)


def candidates(reach, step):
    """Offsets ordered by how little they move the piece (2D, both axes)."""
    n = int(reach / step)
    out = [(0.0, 0.0)]
    for k in range(1, n + 1):
        ring = []
        for i in range(-k, k + 1):
            for j in range(-k, k + 1):
                if max(abs(i), abs(j)) != k:
                    continue
                ring.append((i * step, j * step))
        out += sorted(ring, key=lambda o: (abs(o[0]) + abs(o[1]), -o[1]))
    return out




def target_states(g, names):
    """stall_state() for many stalls, with the counter/clutter maps cached per mesh.

    The 80 stalls share two meshes, so 44 of them need two height-field builds, not 44.
    """
    doc = g.gltf
    world = glb.world_matrices(doc)
    ad = adapter(g)
    by_name = {n.get("name"): i for i, n in enumerate(doc["nodes"])}
    tris_by_mesh = audit_mod.stall_tris(ad)
    maps = {}
    out = {}
    for nm in names:
        if nm not in by_name:
            raise SystemExit(f"no node named {nm}")
        i = by_name[nm]
        node = doc["nodes"][i]
        mi = node["mesh"]
        if mi not in maps:
            tris, area = tris_by_mesh[mi]
            maps[mi] = (audit_mod.counter_map(tris, area), audit_mod.clutter_map(tris))
        counter, origin = maps[mi][0]
        W = world[i]
        out[nm] = dict(node=node, name=nm, mesh=mi,
                       mesh_name=doc["meshes"][mi].get("name"),
                       T=np.array(node.get("translation", [0, 0, 0]), float),
                       ground=float(node.get("translation", [0, 0, 0])[1]),
                       W=W, W_inv=np.linalg.inv(W), counter=counter, origin=origin,
                       clutter=maps[mi][1])
    return out


def place(g, targets, reach, step, max_pieces=None, gap=0.0, remove=()):
    """Plan the new instance transforms for every target stall in one pass.

    One pass, not one run per stall: each goods accessor is rewritten once, which
    matters because `rewrite_accessor` appends a stream and leaves the old one behind.
    Forty-four loads of this 70 MB file would leave 44 copies of every touched stream.
    """
    doc = g.gltf
    ad = adapter(g)
    all_stalls = [dict(node=n.get("name"),
                       T=np.array(n.get("translation", [0, 0, 0]), float))
                  for n in doc["nodes"]
                  if (n.get("name") or "").startswith(STALL_PREFIX) and "mesh" in n]
    plan = []
    reports = {nm: dict(stall=nm, variant=st["mesh_name"],
                        counter_local=[round(float(np.nanmin(st["counter"])), 3),
                                       round(float(np.nanmax(st["counter"])), 3)],
                        pieces=dict(total=0, kept=0, nudged=0, dropped=0, ground=0,
                                    hanging=0, hidden=0, skipped_tilted=0),
                        keys={})
               for nm, st in targets.items()}
    taken = {nm: [] for nm in targets}      # (lx, lz, hx, hz) placed by this run
    # reserve each pinned board's real footprint first: nothing may land on one
    for n in doc["nodes"]:
        name = n.get("name") or ""
        ext = (n.get("extensions") or {}).get("EXT_mesh_gpu_instancing")
        if not name.startswith(GOODS_PREFIX) or not ext or "mesh" not in n:
            continue
        T, _ = audit_mod.meshopt_decode(ad, ext["attributes"]["TRANSLATION"])
        R, _ = audit_mod.meshopt_decode(ad, ext["attributes"]["ROTATION"])
        S, _ = audit_mod.meshopt_decode(ad, ext["attributes"]["SCALE"])
        box = glb.mesh_aabb(doc, n["mesh"])
        for t, q, sc in zip(T, R, S):
            if box is None or min(abs(float(v)) for v in sc) < 1e-6 or not pinned(t):
                continue
            owner = min(all_stalls, key=lambda s: (s["T"][0] - t[0]) ** 2
                        + (s["T"][2] - t[2]) ** 2)["node"]
            if owner in targets:
                w_inv = targets[owner]["W_inv"]
                lx, _, lz = (w_inv @ np.array([t[0], t[1], t[2], 1.0]))[:3]
                half = audit_mod.footprint_half(
                    ((box[1][0] - box[0][0]) * sc[0] / 2,
                     (box[1][2] - box[0][2]) * sc[2] / 2), q, w_inv)
                taken[owner].append((lx, lz, half[0], half[1]))
    # food and bottles claim counter room first, so the cap drops props, not goods
    first = tuple(GOODS_PREFIX + p for p in ("bottles", "crate", "mound", "pyr"))
    for ni, n in sorted(enumerate(doc["nodes"]),
                        key=lambda e: not (e[1].get("name") or "").startswith(first)):
        name = n.get("name") or ""
        ext = (n.get("extensions") or {}).get("EXT_mesh_gpu_instancing")
        if not name.startswith(GOODS_PREFIX) or not ext or "mesh" not in n:
            continue
        at = ext["attributes"]
        T, mt = audit_mod.meshopt_decode(ad, at["TRANSLATION"])
        R, _ = audit_mod.meshopt_decode(ad, at["ROTATION"])
        S, _ = audit_mod.meshopt_decode(ad, at["SCALE"])
        if T is None or mt == "envelope":
            raise SystemExit("meshoptimizer missing: cannot decode instance translations")
        assert len(T) == len(R) == len(S), f"{name}: T/R/S lengths differ"
        box = glb.mesh_aabb(doc, n["mesh"])
        if box is None:
            continue
        key = name[len(GOODS_PREFIX):]
        for k in range(len(T)):
            t = T[k]
            owner = min(all_stalls, key=lambda s: (s["T"][0] - t[0]) ** 2
                        + (s["T"][2] - t[2]) ** 2)["node"]
            if owner not in targets:
                continue
            st, rep = targets[owner], reports[owner]
            ground = st["ground"]
            rep["pieces"]["total"] += 1
            scale = float(S[k][1]) if S[k][1] > 1e-6 else 1.0
            ymin = box[0][1] * scale
            bottom = t[1] + ymin
            if min(abs(float(v)) for v in S[k]) < 1e-6:
                # scale 0: the piece is not rendered at all (68 in this file), so
                # moving it would only produce a corrected transform for nothing
                rep["pieces"]["hidden"] += 1
                continue
            # the board a usable apple/bottle rests on stays exactly where it is
            if pinned(t):
                rep["pieces"]["kept"] += 1
                continue
            if t[1] > ground + audit_mod.HANG_Y:
                rep["pieces"]["hanging"] += 1
                continue
            if abs(bottom - ground) <= 0.05:
                rep["pieces"]["ground"] += 1
                if key in {"r_grainsack", "r_sack"}:
                    plan.append(("drop", ni, k, None))
                continue
            q = R[k]
            if abs(q[0]) > 0.02 or abs(q[2]) > 0.02:
                rep["pieces"]["skipped_tilted"] += 1
                continue
            loc = (st["W_inv"] @ np.array([t[0], t[1], t[2], 1.0]))[:3]
            half = audit_mod.footprint_half(
                (max(box[1][0] - box[0][0], 0.05) * S[k][0] / 2,
                 max(box[1][2] - box[0][2], 0.05) * S[k][2] / 2), q, st["W_inv"])
            d0 = datum(st, loc[0], loc[2], (0.0, 0.0))
            rec = dict(key=key, instance=k, old_y=round(float(t[1]), 3),
                       old_gap=None if d0 is None else round(bottom - (ground + d0), 3))
            spot = None
            full = key in remove or (max_pieces is not None and len(taken[owner]) >= max_pieces)
            for dx, dz in [] if full else candidates(reach, step):
                lx, lz = loc[0] + dx, loc[2] + dz
                d = datum(st, lx, lz, half)
                if d is None or occupied(st, lx, lz, half, d):
                    continue
                if any(clash((lx, lz, half[0], half[1]), t2, 0.02 - gap) for t2 in taken[owner]):
                    continue
                spot = (lx, lz, d, dx, dz)
                break
            if spot is None:
                plan.append(("drop", ni, k, None))
                rep["pieces"]["dropped"] += 1
                rec["action"] = "dropped"
            else:
                lx, lz, d, dx, dz = spot
                taken[owner].append((lx, lz, half[0], half[1]))
                w = (st["W"] @ np.array([lx, t[1], lz, 1.0]))[:3]
                ty = ground + d - ymin
                plan.append(("set", ni, k, np.array([w[0], ty, w[2]])))
                moved = math.hypot(dx, dz) > 1e-9
                rep["pieces"]["nudged" if moved else "kept"] += 1
                rec.update(action="nudged" if moved else "kept", new_y=round(float(ty), 3),
                           new_gap=round(float(ty + ymin - (ground + d)), 3),
                           dx=round(dx, 3), dz=round(dz, 3))
            rep["keys"].setdefault(key, []).append(rec)
    return plan, reports


def write_plain(g, values, type_str):
    """Append float data as a self-contained accessor; return its index.

    Not `rewrite_accessor`: that re-encodes a meshopt stream into the *existing*
    bufferView, and instancing accessors here are **shared between goods keys** (one
    all-1.0 SCALE accessor feeds four of them). Rewriting in place with a smaller count
    corrupts every sibling that still points at it, and converting a normalized SHORT
    quaternion to float32 inside the same view leaves the fallback byteLength half the
    size the accessor now needs.

    A fresh view + accessor per touched node costs ~50 KB in total (922 instances ×
    3 attributes × 12 B) and is exactly what it says it is.
    """
    doc = g.gltf
    vals = np.ascontiguousarray(np.asarray(values, dtype="<f4"))
    ncomp = {"VEC3": 3, "VEC4": 4}[type_str]
    assert vals.ndim == 2 and vals.shape[1] == ncomp
    while len(g.bin) % 4:
        g.bin += b"\x00"
    off = len(g.bin)
    payload = vals.tobytes()
    g.bin += payload
    doc["bufferViews"].append(dict(buffer=0, byteOffset=off, byteLength=len(payload)))
    acc = dict(bufferView=len(doc["bufferViews"]) - 1, componentType=5126,
               count=len(vals), type=type_str,
               min=[float(v) for v in vals.min(axis=0)],
               max=[float(v) for v in vals.max(axis=0)])
    doc["accessors"].append(acc)
    doc["buffers"][0]["byteLength"] = len(g.bin)
    return len(doc["accessors"]) - 1


def apply_plan(g, plan):
    """Write the planned transforms back, one fresh accessor set per goods node."""
    doc = g.gltf
    ad = adapter(g)
    for ni, n in enumerate(doc["nodes"]):
        name = n.get("name") or ""
        ext = (n.get("extensions") or {}).get("EXT_mesh_gpu_instancing")
        mine = [(act, k, val) for act, tni, k, val in plan if tni == ni]
        if not name.startswith(GOODS_PREFIX) or not ext or not mine:
            continue
        at = ext["attributes"]
        T, _ = audit_mod.meshopt_decode(ad, at["TRANSLATION"])
        R, _ = audit_mod.meshopt_decode(ad, at["ROTATION"])
        S, _ = audit_mod.meshopt_decode(ad, at["SCALE"])
        newT, drop = T.copy(), set()
        for act, k, val in mine:
            if act == "set":
                newT[k] = val
            else:
                drop.add(k)
        keep = [k for k in range(len(T)) if k not in drop]
        if not keep:
            n.pop("mesh")
            n["extensions"].pop("EXT_mesh_gpu_instancing")
            if not n["extensions"]:
                n.pop("extensions")
            continue
        for key, arr in (("TRANSLATION", newT[keep]),
                         ("ROTATION", R[keep]),
                         ("SCALE", S[keep])):
            at[key] = write_plain(g, arr, "VEC4" if key == "ROTATION" else "VEC3")


def floor_crates(g, targets):
    """Find the loose shipping crates staged beside the selected stalls."""
    world = glb.world_matrices(g.gltf)
    crates = {}
    for i, node in enumerate(g.gltf["nodes"]):
        if world[i] is None or not node.get("name", "").startswith("SK_med_crate"):
            continue
        x, y, z = world[i][:3, 3]
        if any(abs(x - st["T"][0]) <= 4.0 and abs(z - st["T"][2]) <= 0.85
               and abs(y - st["ground"]) < 0.05 for st in targets.values()):
            crates[i] = (x, z)
    return crates


def edit_collision(g, crates, pickup_stalls, apply):
    """Remove matching half-metre crate solids and tighten the two pickup stall fronts."""
    for node in g.gltf["nodes"]:
        name = node.get("name")
        if name not in {"col_props", "col_stalls"} or "mesh" not in node:
            continue
        for prim in g.gltf["meshes"][node["mesh"]]["primitives"]:
            positions = g.acc_raw(prim["attributes"]["POSITION"]).copy()
            indices = g.indices_of(prim).reshape(-1, 3)
            remove = np.zeros(len(indices), dtype=bool)
            tightened = 0
            crate_boxes = 0
            for vertices in components(positions, indices):
                lo, hi = vertices.min(0), vertices.max(0)
                if len(vertices) != 8:
                    continue
                x, z = ((lo + hi) / 2)[[0, 2]]
                inside = ((positions >= lo - 0.001) & (positions <= hi + 0.001)).all(1)
                if name == "col_props" and abs(hi[1] - lo[1] - 0.5) < 0.001 and any(
                        math.hypot(x - cx, z - cz) < 0.002 for cx, cz in crates.values()):
                    matches = (np.abs(positions[:, None] - vertices) < 0.001).all(2).any(1)
                    remove |= matches[indices].all(1)
                    crate_boxes += 1
                if name == "col_stalls" and (round(x), round(z)) in pickup_stalls:
                    front = inside & (np.abs(positions[:, 2] - lo[2]) < 0.001)
                    positions[front, 2] = z - 0.77
                    tightened += 1
            if name == "col_props" and remove.any():
                print(f"crate collision boxes: {crate_boxes} ({remove.sum()} triangles)")
                if apply:
                    keep = indices[~remove].astype("<u4").ravel()
                    prim["indices"] = add_accessor(g, add_view(g, keep.tobytes(), 34963), 5125, len(keep), "SCALAR")
            if name == "col_stalls" and tightened:
                print(f"pickup stall collision fronts: {tightened}")
                if apply:
                    prim["attributes"]["POSITION"] = add_accessor(
                        g, add_view(g, positions.astype("<f4").tobytes(), 34962),
                        5126, len(positions), "VEC3", positions.min(0).tolist(), positions.max(0).tolist())


def stall_names(g, args):
    doc = g.gltf
    named = [(n.get("name"), n.get("mesh")) for n in doc["nodes"]
             if (n.get("name") or "").startswith(STALL_PREFIX) and "mesh" in n]
    if args.stall:
        return args.stall
    if args.variant:
        want = f"STALL_{args.variant.upper()}"
        return [nm for nm, mi in named
                if doc["meshes"][mi].get("name") == want]
    return [nm for nm, _mi in named]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--glb", default=GLB)
    ap.add_argument("--stall", action="append",
                    help="node name, repeatable (e.g. --stall SK_med_stall_BazaarPass_43)")
    ap.add_argument("--variant", choices=["A", "B", "a", "b"],
                    help="every stall using that mesh variant")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--out", default=None, help="defaults to --glb, but only with --apply")
    ap.add_argument("--apply", action="store_true", help="write --out (or --glb)")
    ap.add_argument("--reach", type=float, default=0.75,
                    help="max nudge along the counter, m (the back row starts 0.3 m off it)")
    ap.add_argument("--step", type=float, default=0.04)
    ap.add_argument("--max-pieces", type=int, help="declutter: counter pieces kept per stall")
    ap.add_argument("--gap", type=float, default=0.0, help="declutter: free space between pieces, m")
    ap.add_argument("--remove", action="append", default=[], help="declutter: goods key to hide everywhere")
    ap.add_argument("--verbose", action="store_true", help="one line per piece")
    ap.add_argument("--collision", help="collision GLB to clean alongside the visual")
    ap.add_argument("--collision-out", help="collision output path for --apply")
    ap.add_argument("--report", default=f"{HERE}/out/stall-goods-bridge.json")
    a = ap.parse_args()
    if not (a.stall or a.variant or a.all):
        ap.error("one of --stall / --variant / --all is required")

    g = Glb(a.glb)
    names = stall_names(g, a)
    targets = target_states(g, names)
    print(f"{len(targets)} stall(s); variants "
          f"{sorted({st['mesh_name'] for st in targets.values()})}")
    plan, reports = place(g, targets, a.reach, a.step, a.max_pieces, a.gap, set(a.remove))
    crates = floor_crates(g, targets)
    print(f"ground shipping crates: {len(crates)}")
    if a.collision:
        collision = Glb(a.collision)
        pickup_stalls = {(26, 30), (17, 42)} if a.all else set()
        edit_collision(collision, crates, pickup_stalls, a.apply)

    tot = dict(total=0, kept=0, nudged=0, dropped=0, ground=0, hanging=0,
               hidden=0, skipped_tilted=0)
    for nm in sorted(reports):
        rep = reports[nm]
        p = rep["pieces"]
        for k in tot:
            tot[k] += p[k]
        print(f"  {nm:32s} {rep['variant']:7s} total {p['total']:3d}  "
              f"kept {p['kept']:2d}  nudged {p['nudged']:2d}  dropped {p['dropped']:2d}"
              f"  ground {p['ground']}  hang {p['hanging']}  hidden {p['hidden']}"
              f"  tilted {p['skipped_tilted']}")
        if a.verbose:
            for key, rows in sorted(rep["keys"].items()):
                for r in rows:
                    print(f"      {key:14s} #{r['instance']:3d} {r['action']:8s} "
                          f"y {r['old_y']} -> {str(r.get('new_y', '-')):>6}  "
                          f"gap {str(r['old_gap']):>6} -> {str(r.get('new_gap', '-')):>6}  "
                          f"d=({r.get('dx', 0):+.2f},{r.get('dz', 0):+.2f})")
    print("TOTAL", json.dumps(tot))
    out_report = dict(glb=os.path.relpath(a.glb, HERE), stalls=len(targets),
                      totals=tot, plan=dict(sets=sum(1 for p in plan if p[0] == "set"),
                                            drops=sum(1 for p in plan if p[0] == "drop")),
                      reports=reports)
    json.dump(out_report, open(a.report, "w"), indent=1)
    if not a.apply:
        print("dry run: nothing written (pass --apply [--out PATH])")
        return 0
    apply_plan(g, plan)
    for scene in g.gltf["scenes"]:
        scene["nodes"] = [i for i in scene.get("nodes", []) if i not in crates]
    for node in g.gltf["nodes"]:
        if "children" in node:
            node["children"] = [i for i in node["children"] if i not in crates]
    for i in crates:
        g.gltf["nodes"][i].pop("mesh")
    if a.collision:
        save_glb(a.collision_out or a.collision, collision.gltf, collision.bin)
    out = a.out or a.glb
    before = os.path.getsize(a.glb)
    save_glb(out, g.gltf, g.bin)
    print(f"WROTE {out}  {before} -> {os.path.getsize(out)} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
