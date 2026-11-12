#!/usr/bin/env python3
"""Read the shipped world-city3.glb back and check every BzInt_<lot>_F<n> mesh straight from its accessors (no screenshots):
finite positions, inside the lot's footprint, standing on that floor's slab, valid indices, materials present, size budget.
  python3 tools/city3/verify_bazaar_interiors.py [glb]   (exit 1 on any failure)"""
import json, os, sys, tempfile
sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs")); HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
from bridge_wave1 import Glb


def main(path):
    g = Glb(path); j = g.gltf
    lots = {l["id"]: l for l in json.load(open(os.path.join(tempfile.gettempdir(), "bones_all.json")))}
    bad = []; tris = 0; meshes = 0
    for n in j["nodes"]:
        nm = n.get("name", "")
        if not nm.startswith("BzInt_"): continue
        _, lot, fl = nm.split("_"); lot = int(lot); fl = int(fl[1:]); r = lots[lot]["rect"]; meshes += 1
        tops = sorted({rm["z"] + .2 for rm in lots[lot]["rooms"] if rm["floor"] == fl})[0]
        for p in j["meshes"][n["mesh"]]["primitives"]:
            P = g.acc_raw(p["attributes"]["POSITION"]).astype(float); I = g.indices_of(p)
            if not np.isfinite(P).all(): bad.append((nm, "non-finite")); continue
            if I.max() >= len(P): bad.append((nm, "index out of range")); continue
            tris += len(I) // 3
            if P[:, 0].min() < r[0] - .2 or P[:, 0].max() > r[2] + .2 or -P[:, 2].max() < r[1] - .2 or -P[:, 2].min() > r[3] + .2: bad.append((nm, "outside lot rect", [round(float(v), 2) for v in (P[:, 0].min(), P[:, 0].max(), P[:, 2].min(), P[:, 2].max())]))
            if P[:, 1].min() < tops - .05: bad.append((nm, "below floor", round(float(P[:, 1].min() - tops), 2)))
            if "material" not in p: bad.append((nm, "no material"))
    sz = os.path.getsize(path) / 1e6
    print(json.dumps({"meshes": meshes, "tris": tris, "mb": round(sz, 1), "problems": len(bad)})); [print(" ", b) for b in bad[:25]]
    if sz > 100: bad.append(("size", sz))
    sys.exit(1 if bad or not meshes else 0)


if __name__ == "__main__": main(sys.argv[1] if len(sys.argv) > 1 else "apps/console/public/assets/world-city3.glb")
