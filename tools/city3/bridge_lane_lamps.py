#!/usr/bin/env python3
"""Lane lamps pass: remove street-lamp poles that stand in a carriageway (collision GLB: col_props).

plan.py puts lamps at c +- (w/2 - 0.8) of every street, every 25 m along it. Where that spot falls inside a CROSSING street's carriageway
(e.g. x = 5 on the 20 m avenue at x = 0) the pole stands mid-lane: a car in the right lane of the avenue stopped 1 m short of the (0, -65) junction
against the pole at plan (5, -60.8). Found by apps/sim/src/driveMatrix.test.ts. Poles inside a junction cell (a turn sweeps through it) go too; the rest stay.
col_props is one merged mesh, so removal is per triangle: any triangle whose centroid lies within R m of a lane lamp (plan frame, GLB z = -plan y)
and above the walk slab collapses out of the index buffer, the same trick bridge_bazaar_demolish.py uses.

  python3 tools/city3/bridge_lane_lamps.py [apps/console/public/assets/world-city3-collision.glb] [--dry-run]
Then rebake the navmesh: bun run packages/world-sim/node/bakeNavmesh.ts
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
from bridge_landscape_kit import add_accessor, add_view
from bridge_wave1 import Glb, save_glb

PLAN = os.path.join(HERE, "plan.json")
DEFAULT = os.path.join(HERE, "..", "..", "apps", "console", "public", "assets", "world-city3-collision.glb")
MARK = "lane_lamps_pass"
CLEAR = 1.2   # a lamp this far inside a carriageway edge or deeper is a lane lamp (sidewalk lamps sit 0.8 m inside the edge)
CELL_PAD = 0.3   # a lamp on the edge line of a cell is inside it
R = 0.35      # lamp cylinders are r 0.12; neighbours are >= 25 m away
Y_MIN = 0.3   # keep the walk slab (0.2)


def lane_lamps():
    p = json.load(open(PLAN)); streets = p["streets"]
    inside = lambda v: any(abs(v - s["c"]) < s["w"] / 2 - CLEAR for s in streets)
    # A lamp inside a junction cell sits on the arc of a turn: a right turn out of the avenue's right lane swings through (9.2, -70).
    in_cell = lambda x, y: any(abs(x - a["c"]) <= a["w"] / 2 + CELL_PAD and abs(y - b["c"]) <= b["w"] / 2 + CELL_PAD for a in streets for b in streets)
    # The generator skips the plaza (abs < 58 on both axes); so do collision.py and build_city.py.
    return [(x, y) for x, y in p["lamps"] if not (abs(x) < 58 and abs(y) < 58) and (inside(x) or inside(y) or in_cell(x, y))]


def run(path, dry):
    g = Glb(path); j = g.gltf
    if j.get("extras", {}).get(MARK): print({"collision": "already"}); return
    L = lane_lamps(); killed = 0
    for n in j["nodes"]:
        if n.get("name") != "col_props" or "mesh" not in n: continue
        for prim in j["meshes"][n["mesh"]]["primitives"]:
            P = g.acc_raw(prim["attributes"]["POSITION"]); I = g.indices_of(prim).reshape(-1, 3); c = P[I].mean(1); kill = np.zeros(len(I), bool)
            for x, y in L: kill |= (np.hypot(c[:, 0] - x, c[:, 2] + y) < R) & (c[:, 1] > Y_MIN)
            killed += int(kill.sum())
            if dry or not kill.any(): continue
            keep = I[~kill].astype("<u4").ravel()
            prim["indices"] = add_accessor(g, add_view(g, keep.tobytes(), 34963), 5125, len(keep), "SCALAR")
    print(json.dumps({"lane_lamps": len(L), "triangles_dropped": killed}))
    if dry: return
    j.setdefault("extras", {})[MARK] = len(L); print("wrote", path, save_glb(path, g.gltf, g.bin), "bytes")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("glb", nargs="?", default=DEFAULT); ap.add_argument("--dry-run", action="store_true"); a = ap.parse_args()
    run(a.glb, a.dry_run)
