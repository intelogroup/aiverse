#!/usr/bin/env python3
"""Swap the buildings at the street-facing ends of the citadel rows for ones whose end wall has windows.

bridge_citadel_townhouses.py packs each lot at random; three of the four outer ends came out as a blank plaster or brick gable (angers_shop_2 west end of lot 148,
nivelles_house_1 east end of 150, mons_shop_2 east end of 153). Contact sheet of every asset's two ends (2026-11-23): only nivelles_house_2 is windowed at both.
This rewrites those three lots in place (group node children, collider box mesh), reusing meshes already in the world and adding only the ones missing;
the rest of the citadel is untouched. Row order: S row runs west to east, the N row too (its yaw only turns the buildings), so the first item is the west end.

  python3 tools/city3/bridge_citadel_ends.py [world.glb] [collision.glb] [--dry-run | --selftest]
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
import bridge_citadel_townhouses as c

MARK = "citadel_ends_pass"
WINDOWED = "nivelles_house_2"
SEQ = {148: [WINDOWED, "nivelles_house_9"],        # west end of the S row
       150: [WINDOWED],                             # east end of the S row (a 10 m lot: scale 0.83, below SCALE_MIN, accepted for one corner)
       153: ["guingamp_shop_1", WINDOWED]}          # east end of the N row


def plan_ends(plan, assets):
    out = {}
    for lid, seq in SEQ.items():
        lot = plan[lid]["lot"]
        out[lid] = {"lot": lot, "items": c.place_seq(lot, assets, seq)}
    return out


def apply(world, col, ends, assets, dry):
    g, cg = world.gltf, col.gltf
    if g.get("extras", {}).get(MARK):
        return {"already_patched": True}
    meshes = {m["name"]: i for i, m in enumerate(g["meshes"]) if m.get("name")}
    need = sorted({it["slug"] for p in ends.values() for it in p["items"] if "Townhouse_" + it["slug"] not in meshes})
    if dry:
        return {"lots": sorted(ends), "meshes_to_add": need}
    from bridge_landscape_kit import add_accessor, add_view
    meshes.update({k: v for k, v in c.add_asset_meshes(world, assets, need).items()})
    mesh_of = lambda slug: meshes.get(slug, meshes.get("Townhouse_" + slug))
    for lid, p in sorted(ends.items()):
        grp = next(n for i, n in enumerate(g["nodes"]) if n.get("name") == f"Kit_shop{lid}" and i in g["scenes"][g.get("scene", 0)]["nodes"])
        kids, bx = [], []
        for it in p["items"]:
            g["nodes"].append({"name": f"Kit_shop{lid}_{it['slug']}", "mesh": mesh_of(it["slug"]), "translation": list(it["t"]), "rotation": c._quat_y(it["yaw"]), "scale": list(it["s"])})
            kids.append(len(g["nodes"]) - 1)
            bx.append((*c.footprint(it), it["h"]))
        grp["children"] = kids                      # the old children stay in the node list, in no scene
        Ps, Is, base = [], [], 0
        for x0, z0, x1, z1, h in bx:
            P, I = c.box_mesh(x0, z0, x1, z1, h)
            Ps.append(P); Is.append(I + base); base += len(P)
        P, I = np.concatenate(Ps), np.concatenate(Is).astype("<u2")
        prim = {"attributes": {"POSITION": add_accessor(col, add_view(col, P.tobytes(), 34962), 5126, len(P), "VEC3", P.min(0).tolist(), P.max(0).tolist())},
                "indices": add_accessor(col, add_view(col, I.tobytes(), 34963), 5123, len(I), "SCALAR"), "material": 0}
        node = next(n for n in cg["nodes"] if n.get("name") == f"col_kit_shop{lid}")
        cg["meshes"][node["mesh"]]["primitives"] = [prim]
    for gl in (g, cg):
        gl.setdefault("extras", {})[MARK] = "v1"
    return {"lots": sorted(ends), "meshes_added": need}


def selftest():
    assets = {k: {"W": w, "H": 12.0, "D": 12.0} for k, w in (("nivelles_house_2", 12.1), ("nivelles_house_9", 9.9), ("guingamp_shop_1", 6.9))}
    lot = {"id": 153, "face": "N", "rect": [104.5, 72.5, 122.5, 84.5], "plan_rect": [0, 0, 1, 1]}
    items = c.place_seq(lot, assets, SEQ[153])
    x0, _, x1, _ = c.footprint(items[-1])
    assert items[-1]["slug"] == WINDOWED and abs(x1 - 122.5) < 1e-6, (items[-1]["slug"], x1)   # the windowed house stands at the east end
    assert abs(sum(i["w"] for i in items) - 18.0) < 1e-6
    print("selftest ok")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("world", nargs="?", default="apps/console/public/assets/world-city3.glb")
    ap.add_argument("collision", nargs="?", default="apps/console/public/assets/world-city3-collision.glb")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        selftest(); sys.exit(0)
    from bridge_wave1 import Glb, save_glb
    plan, assets = c.build_plan()
    ends = plan_ends(plan, assets)
    c.describe(ends)
    world, col = Glb(a.world), Glb(a.collision)
    rep = apply(world, col, ends, assets, a.dry_run)
    print(json.dumps(rep))
    if not a.dry_run and "already_patched" not in rep:
        print("wrote", a.world, save_glb(a.world, world.gltf, world.bin), "bytes")
        print("wrote", a.collision, save_glb(a.collision, col.gltf, col.bin), "bytes")
