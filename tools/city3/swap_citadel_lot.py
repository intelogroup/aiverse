#!/usr/bin/env python3
"""Re-dress one citadel lot with other townhouse kits, in the shipped world and collision GLBs.

bridge_citadel_townhouses.py is one-shot (it refuses a patched GLB). This removes lot N's Kit_shop<N> group and its collider box node, then places the
requested kits with the same place_seq/apply code, so the transform, depth squash and collider rules stay identical.
The old nodes are orphaned and emptied (renamed dead_*, no mesh); run bridge_compact.py --drop-dead --prefix dead_ afterwards to drop the bytes.

  python3 tools/city3/swap_citadel_lot.py 155 guingamp_shop_1 nivelles_house_1 bordeaux_flat_1_corner [--dry-run]
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))


def retire(gl, prefix):
    """drop every node named `prefix` or `prefix_*` from the scene roots and empty it; returns how many nodes were retired"""
    names = [n.get("name", "") for n in gl["nodes"]]
    hit = {i for i, nm in enumerate(names) if nm == prefix or nm.startswith(prefix + "_")}
    for sc in gl["scenes"]:
        sc["nodes"] = [i for i in sc["nodes"] if i not in hit]
    for i in hit:
        gl["nodes"][i].pop("mesh", None)
        gl["nodes"][i].pop("children", None)
        gl["nodes"][i]["name"] = "dead_" + names[i]
    return len(hit)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("lot", type=int)
    ap.add_argument("slugs", nargs="+")
    ap.add_argument("--world", default="apps/console/public/assets/world-city3.glb")
    ap.add_argument("--collision", default="apps/console/public/assets/world-city3-collision.glb")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    import bridge_citadel_townhouses as T
    from bridge_wave1 import Glb, save_glb
    plan, assets = T.build_plan()
    if a.lot not in plan:
        sys.exit(f"lot {a.lot} is not a citadel lot: {sorted(plan)}")
    lot = plan[a.lot]["lot"]
    items = T.place_seq(lot, assets, a.slugs)
    new = {a.lot: {"lot": lot, "items": items}}
    T.describe(new)
    world, col = Glb(a.world), Glb(a.collision)
    if not world.gltf.get("extras", {}).get(T.MARK):
        sys.exit("run bridge_citadel_townhouses.py first: this only swaps lots of an already patched world")
    print("retired", retire(world.gltf, f"Kit_shop{a.lot}"), "world nodes,", retire(col.gltf, f"col_kit_shop{a.lot}"), "collision nodes")
    # The original pass already collapsed the shim inside this lot's rect; cutting again would also catch the edge-adjacent colliders of lots 150 and 153.
    import bridge_edge_landscape
    bridge_edge_landscape.cut = lambda *args, **kw: {}
    rep = T.apply(world, col, new, {s: assets[s] for s in a.slugs}, a.dry_run)
    print(json.dumps(rep))
    if not a.dry_run:
        print("wrote", a.world, save_glb(a.world, world.gltf, world.bin), "bytes")
        print("wrote", a.collision, save_glb(a.collision, col.gltf, col.bin), "bytes")
