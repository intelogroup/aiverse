#!/usr/bin/env python3
"""Bazaar demolition pass: remove whole shop buildings so the island gets open ground (lido, sports field, park; see bridge_bazaar_open_space.py).
Per lot id in DEMOLISH: the visual nodes Bones_shop/Roof_shop/Door_shop/Sign_shop<id> and SK_lantern.<id> leave the scene, facade (B_Facade_*) and baked cornice
(Props) triangles whose centroid lies in the lot rect (+0.3 m) are dropped, the collision node col_bones_shop<id> leaves the collision GLB, and the streamed
interiors/shop-<id>.{json,col.json} files and index entry are deleted. Run before bridge_bazaar_interiors.py (which skips these lots), then rebake the navmesh:
  python3 tools/city3/bridge_bazaar_demolish.py [glb] [--dry-run]   &&   bun run packages/world-sim/node/bakeNavmesh.ts
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
from bridge_landscape_kit import add_accessor, add_view
from bridge_wave1 import Glb, save_glb

DEMOLISH = {"lido": [124, 125, 126, 127, 128, 129], "sports": [156, 157, 158, 159, 160, 161, 162, 163], "park": [72, 73, 74, 75, 76]}
ALL = sorted(i for v in DEMOLISH.values() for i in v)
BLOCKS = {"lido": (12, 72, 58, 122), "sports": (72, 12, 122, 58), "park": (-122, -122, -72, -84)}  # whole block incl. courtyard: loose props (trees, stalls, benches) inside go too
CLEAR = ("Tree_", "SK_", "ls_tree", "ls_bush", "ls_flower", "ls_rock", "PartyCups")
HEROES = os.path.join(HERE, "out", "heroes.json")


def rects():
    h = {x["id"]: x["rect"] for x in json.load(open(HEROES))}
    return {i: h["shop-%d" % i] for i in ALL}


def drop_tris(g, prim, R, inflate=.3):
    P = g.acc_raw(prim["attributes"]["POSITION"]); I = g.indices_of(prim).reshape(-1, 3); c = P[I].mean(1); kill = np.zeros(len(I), bool)
    for r in R.values():  # heroes.json rects are world [x0, z0, x1, z1] (Bones_shop124 spans z 110.5..122.5)
        kill |= (c[:, 0] > r[0] - inflate) & (c[:, 0] < r[2] + inflate) & (c[:, 2] > r[1] - inflate) & (c[:, 2] < r[3] + inflate)
    if kill.any():
        keep = I[~kill].astype("<u4").ravel()
        if len(keep): prim["indices"] = add_accessor(g, add_view(g, keep.tobytes(), 34963), 5125, len(keep), "SCALAR")
        else: prim["indices"] = add_accessor(g, add_view(g, np.zeros(3, "<u4").tobytes(), 34963), 5125, 3, "SCALAR")
    return int(kill.sum())


def visual(path, dry):
    g = Glb(path); j = g.gltf
    if j.get("extras", {}).get("bazaar_demolish_pass"): print({"visual": "already"}); return
    R = rects(); RB = {**R, **{"block_" + k: v for k, v in BLOCKS.items()}}; names = {f"{p}{i}" for i in ALL for p in ("Bones_shop", "Roof_shop", "Door_shop", "Sign_shop", "SK_lantern.")}
    scene = j["scenes"][j.get("scene", 0)]["nodes"]; rem = [i for i, n in enumerate(j["nodes"]) if n.get("name") in names and i in scene]; tr = {"B_Facade": 0, "Props": 0, "Courtyards": 0, "Awnings": 0, "BladeSigns": 0}
    for n in j["nodes"]:
        nm = n.get("name", "")
        k = "B_Facade" if nm.startswith("B_Facade_") else nm if nm in ("Props", "Courtyards", "Awnings", "BladeSigns") else None
        if k and "mesh" in n:  # courtyard floors, awnings and blade signs of the removed buildings go too (whole blocks for lido and sports)
            for p in j["meshes"][n["mesh"]]["primitives"]:
                if "indices" in p: tr[k] += drop_tris(g, p, RB if k in ("Courtyards", "Awnings", "BladeSigns", "Props") else R) if not dry else 0
    loose = [i for i, n in enumerate(j["nodes"]) if i in scene and n.get("name", "").startswith(CLEAR) and "translation" in n and any(b[0] <= n["translation"][0] <= b[2] and b[1] <= n["translation"][2] <= b[3] for b in BLOCKS.values())]
    rem += loose; rep = {"nodes_removed": len(rem), "loose_props": len(loose), "tris_dropped": tr}; print(json.dumps(rep))
    if dry: return
    for i in rem: scene.remove(i)
    j.setdefault("extras", {})["bazaar_demolish_pass"] = ALL; print("wrote", path, save_glb(path, g.gltf, g.bin), "bytes")


def collision(path, dry):
    g = Glb(path); j = g.gltf
    if j.get("extras", {}).get("bazaar_demolish_pass"): print({"collision": "already"}); return
    names = {f"col_bones_shop{i}" for i in ALL}; scene = j["scenes"][j.get("scene", 0)]["nodes"]; rem = [i for i, n in enumerate(j["nodes"]) if n.get("name") in names and i in scene]
    print({"collision_nodes_removed": len(rem)})
    if dry: return
    for i in rem: scene.remove(i)
    j["extras"]["bazaar_demolish_pass"] = ALL; print("wrote", path, save_glb(path, g.gltf, g.bin), "bytes")


def interiors(adir, dry):
    idx = os.path.join(adir, "interiors", "index.json"); d = json.load(open(idx)); ids = {"shop-%d" % i for i in ALL}
    keep = [e for e in d if e["id"] not in ids]; print({"interiors_removed": len(d) - len(keep)})
    if dry: return
    json.dump(keep, open(idx, "w"), separators=(",", ":"))
    for i in ALL:
        for suf in (".json", ".col.json"):
            f = os.path.join(adir, "interiors", "shop-%d%s" % (i, suf))
            if os.path.exists(f): os.remove(f)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("glb", nargs="?", default="apps/console/public/assets/world-city3.glb"); ap.add_argument("--dry-run", action="store_true"); a = ap.parse_args()
    adir = os.path.dirname(os.path.abspath(a.glb)); visual(a.glb, a.dry_run); collision(os.path.join(adir, "world-city3-collision.glb"), a.dry_run); interiors(adir, a.dry_run)
