#!/usr/bin/env python3
"""Make the Villa reachable on foot: the dam collision pass (collision GLB only).

The Villa (apps/console/public/assets/villa.glb, placed by VillaEstate.tsx) stands on its
slab beyond the rim at (0, 0.2, 252), footprint x -25.59..28.41, z 203.61..314.40. The
structure that joins it to the city already stands in the world: the south link bridge
(tools/city3/links.py, shipped as world-links.glb) carries the avenue's road surface,
side walks, glass rails and lamps from the quay gap (z 180) to z 220, landing on the
slab. What was missing is the sim half: nothing loaded the links collision, the resident
collision set ended at the quay (col_ground |x|,|z| <= 180), and the navmesh ended with
it, so no agent could walk the crossing and city3-places.json had no villa entry.

This pass appends to world-city3-collision.glb, in three.js coords (y up, ground 0.2):

  * col_ground += the deck quad (x -10.2..10.2, z 179.5..221.0 — links.py's own
    collision spec for the bridge: road + both walks) and the forecourt quad
    (the slab's open apron, x -25.59..28.41, z 203.61..222.5, up to the house's
    colonnade line). Deck height is the world ground height, so the walk is level
    from the avenue, across the dam, onto the slab.
  * col_villa_dam (new, closed boxes): the bridge's glass rails as 0.4 m walls
    (links.py's spec, y -0.5..1.25), its ten lamp posts, the house itself as one
    solid over its ground-floor footprint (wall_065's bounds, x -17.9..19.5,
    z 222.5..305.0 — visitors arrive at the forecourt; the house has no interior
    contract), and the small forecourt sign at (10.2, 219.1).

No visual GLB is touched: the dam's geometry is the shipped bridge. After this pass,
rebake the navmesh (`bun run packages/world-sim/node/bakeNavmesh.ts`) — the verse-sim
test pins the bake to this GLB's sha256. Idempotent via the extras marker.

  python3 tools/city3/bridge_villa_dam.py [--dry-run]      (run from the repo root)
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
from bridge_landscape_kit import add_accessor, add_view
from bridge_wave1 import Glb, save_glb

COL = "apps/console/public/assets/world-city3-collision.glb"
G = 0.2  # world ground height; the deck and the slab top both sit flush at it

# ground quads (x0, x1, z0, z1) at y = G, appended to col_ground
GROUND = [(-10.2, 10.2, 179.5, 221.0),      # the dam deck (links bridge: road + walks)
          (-25.59, 28.41, 203.61, 222.5)]  # the villa forecourt apron
# closed boxes (x0, x1, z0, z1, y0, y1) in a new col_villa_dam node
BOXES = [(-10.4, -10.0, 180.0, 220.0, -0.5, 1.25),   # west glass rail (links.py spec)
         (10.0, 10.4, 180.0, 220.0, -0.5, 1.25),     # east glass rail
         (-17.9, 19.5, 222.5, 305.0, -0.3, 10.4),    # the house, one solid
         (9.8, 10.55, 218.7, 219.45, G, 1.05)]       # forecourt sign
for z in (184.0, 192.0, 200.0, 208.0, 216.0):        # bridge lamp posts (links.py: u = 4 + k*(L-8)/4, x = +-9.2)
    BOXES.append((-9.35, -9.05, z - 0.15, z + 0.15, -0.1, 4.0))
    BOXES.append((9.05, 9.35, z - 0.15, z + 0.15, -0.1, 4.0))


def ground_tris():
    """Upward-facing triangles for the GROUND quads (three.js frame, +y normal)."""
    P = []
    for (x0, x1, z0, z1) in GROUND:
        P += [(x0, G, z0), (x0, G, z1), (x1, G, z1), (x0, G, z0), (x1, G, z1), (x1, G, z0)]
    return P


def box_tris():
    """Closed-box triangles, the exact corner/quad order bridge_bazaar_open_space.py emits."""
    P, I = [], []
    for (x0, x1, z0, z1, y0, y1) in BOXES:
        base = len(P)
        P += [(x, y, z) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]
        for q in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
            I += [base + q[0], base + q[1], base + q[2], base + q[0], base + q[2], base + q[3]]
    return P, I


def prim(g, P, I, mat):
    Pa = np.array(P, "<f4"); Na = np.zeros_like(Pa); Na[:, 1] = 1
    pa = add_accessor(g, add_view(g, Pa.tobytes(), 34962), 5126, len(Pa), "VEC3", Pa.min(0).tolist(), Pa.max(0).tolist())
    na = add_accessor(g, add_view(g, Na.tobytes(), 34962), 5126, len(Na), "VEC3")
    ia = add_accessor(g, add_view(g, np.array(I, "<u4").tobytes(), 34963), 5125, len(I), "SCALAR")
    return {"attributes": {"POSITION": pa, "NORMAL": na}, "indices": ia, "material": mat}


def run(colpath, dry):
    g = Glb(colpath); j = g.gltf
    if j.get("extras", {}).get("villa_dam_pass"):
        print({"already": True}); return
    rep = {"ground_quads": len(GROUND), "boxes": len(BOXES)}
    print(json.dumps(rep))
    if dry: return
    mat = j["meshes"][0]["primitives"][0]["material"]
    # ground: append a primitive to the existing col_ground mesh (check_collision skips col_ground for closedness)
    gnode = next(n for n in j["nodes"] if n.get("name") == "col_ground")
    P = ground_tris()
    j["meshes"][gnode["mesh"]]["primitives"].append(prim(g, P, list(range(len(P))), mat))
    # solids: a new node, closed boxes only
    P, I = box_tris()
    j["meshes"].append({"name": "col_villa_dam", "primitives": [prim(g, P, I, mat)]})
    j["nodes"].append({"name": "col_villa_dam", "mesh": len(j["meshes"]) - 1})
    j["scenes"][j.get("scene", 0)]["nodes"].append(len(j["nodes"]) - 1)
    j.setdefault("extras", {})["villa_dam_pass"] = "v1"
    print("wrote", colpath, save_glb(colpath, g.gltf, g.bin), "bytes")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--dry-run", action="store_true"); a = ap.parse_args()
    run(COL, a.dry_run)
