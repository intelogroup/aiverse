#!/usr/bin/env python3
"""Replace the civic hall (hall-0: a facade-only box with a faked barrel vault) with the Lost Gecko Troyes Market Hall, in the world and collision GLBs.

Same machinery as bridge_citadel_townhouses.py (apply with prefix `Kit_hall`): the building is scaled to the plan rect's width, its depth is squashed to the
rect depth, and its front goes on the rect's south edge (plan S = GLB +z). The old triangles inside the rect are collapsed in the merged meshes, `RoofHall`
(the vault) included; the collision GLB gets the same cut and one box. Credits: assets/townhouses/troyes_market_hall (CC-BY-4.0, ASSETS.md).

  python3 tools/city3/bridge_civic_hall.py --dry-run
  python3 tools/city3/bridge_civic_hall.py [world.glb] [collision.glb] [--yaw RADIANS]
  python3 tools/city3/bridge_civic_hall.py --selftest
"""
import argparse
import json
import math
import os
import runpy
import shutil
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bridge_citadel_townhouses as c

MARK = "civic_hall_pass"
CUT_PAD = 1.0   # the vault's flat end caps (RoofFlat) stand 0.5 m outside the rect, past the default 0.4 m pad; the nearest neighbour is a street away
SLUG = "troyes_market_hall"


def hall_rect():
    here = os.getcwd()
    tmp = tempfile.mkdtemp()
    try:
        os.chdir(tmp)  # plan.py dumps plan.json into cwd
        ns = runpy.run_path(os.path.join(HERE, "plan.py"))
    finally:
        os.chdir(here)
        shutil.rmtree(tmp, ignore_errors=True)
    return ns["halls"][0]["rect"]


def fit(rect, W, H, D):
    """GLB rect [x0, z0, x1, z1] -> item for a building of W x D footprint facing +z: full width, depth squashed to the rect."""
    X0, Z0, X1, Z1 = rect
    s = (X1 - X0) / W
    sz = min(s, (Z1 - Z0) / D)
    return {"slug": SLUG, "t": (X0, 0.0, Z1), "yaw": c.YAW["S"], "s": (s, s, sz), "w": W * s, "h": H * s, "d": D * sz}


def build_plan(yaw=0.0):
    pr = hall_rect()
    a = c.load_asset(SLUG)
    rect = [pr[0], -pr[3], pr[2], -pr[1]]   # plan [x0, y0, x1, y1] -> GLB [x0, z0, x1, z1], z = -y
    it = fit(rect, a["W"], a["H"], a["D"])
    it["yaw"] = yaw
    return {0: {"lot": {"plan_rect": pr, "rect": rect, "face": "S"}, "items": [it]}}, {SLUG: a}


def selftest():
    it = fit([16.5, -118.5, 53.5, -76.5], 42.8, 21.6, 60.8)
    assert abs(it["w"] - 37.0) < 1e-9 and abs(it["d"] - 42.0) < 1e-9 and it["s"][0] > it["s"][2], it
    x0, z0, x1, z1 = c.footprint(it)
    assert (round(x0, 6), round(z0, 6), round(x1, 6), round(z1, 6)) == (16.5, -118.5, 53.5, -76.5), (x0, z0, x1, z1)
    print("selftest ok")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("world", nargs="?", default="apps/console/public/assets/world-city3.glb")
    ap.add_argument("collision", nargs="?", default="apps/console/public/assets/world-city3-collision.glb")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--yaw", type=float, default=0.0)
    a = ap.parse_args()
    if a.selftest:
        selftest(); sys.exit(0)
    from bridge_wave1 import Glb, save_glb
    plan, assets = build_plan(a.yaw)
    print(json.dumps({k: (round(v, 2) if isinstance(v, float) else v) for k, v in plan[0]["items"][0].items() if k != "slug"}, default=list))
    world, col = Glb(a.world), Glb(a.collision)
    if world.gltf.get("extras", {}).get(MARK):
        print({"already_patched": True}); sys.exit(0)
    import bridge_edge_landscape
    bridge_edge_landscape.PAD = CUT_PAD
    rep = c.apply(world, col, plan, assets, a.dry_run, mark=MARK, prefix="Kit_hall", visual_extra=("RoofHall",))
    print(json.dumps(rep))
    if not a.dry_run:
        print("wrote", a.world, save_glb(a.world, world.gltf, world.bin), "bytes")
        print("wrote", a.collision, save_glb(a.collision, col.gltf, col.bin), "bytes")
