#!/usr/bin/env python3
"""Drop the procedural hall's roofs left inside the Troyes market hall (Kit_hall0).

The old hall's gabled roof (RoofHall, all of it) and its flat roof (the RoofFlat triangles over plan.json's hall rect) sit under the Troyes
model's own roof, hidden up close. In the far LOD the Troyes model is simplified and the old flat roof showed through as a white box (the
opening aerial, 2026-11-24). The hall's far colour is set to the model's dark iron grey at the same time. Idempotent (extras mark);
bytes stay until bridge_compact.py --drop-dead.
  python3 tools/city3/bridge_drop_hall_shell.py [world.glb] [--dry-run]
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
from bridge_landscape_kit import add_accessor, add_view
from bridge_wave1 import Glb, save_glb

MARK = "hall_shell_dropped"


def run(path, dry):
    g = Glb(path); j = g.gltf
    if j.get("extras", {}).get(MARK):
        print({"already": True}); return
    h = json.load(open(os.path.join(HERE, "plan.json")))["halls"][0]["rect"]
    X0, X1, Z0, Z1 = h[0] - 1, h[2] + 1, -h[3] - 1, -h[1] + 1   # plan y -> glb -z; the roof overhangs the rect by 0.5 m
    scene = j["scenes"][j.get("scene", 0)]["nodes"]; rep = {}
    for ni in list(scene):
        n = j["nodes"][ni]
        if n.get("name") == "RoofHall":
            scene.remove(ni); rep["RoofHall"] = "removed"
        elif n.get("name") == "RoofFlat" and "mesh" in n:
            for p in j["meshes"][n["mesh"]]["primitives"]:
                P = g.acc_raw(p["attributes"]["POSITION"]); I = g.indices_of(p).reshape(-1, 3); c = P[I].mean(1)
                kill = (c[:, 0] > X0) & (c[:, 0] < X1) & (c[:, 2] > Z0) & (c[:, 2] < Z1)
                rep["RoofFlat_tris"] = int(kill.sum())
                if not dry and kill.all():   # nothing left: an empty primitive fails verify_tiles.mjs
                    scene.remove(ni); rep["RoofFlat"] = "removed"
                elif not dry and kill.any():
                    keep = I[~kill].astype("<u4").ravel()
                    p["indices"] = add_accessor(g, add_view(g, keep.tobytes(), 34963), 5125, len(keep), "SCALAR")
    for m in j["materials"]:
        if m.get("name") == "Townhouse_troyes_market_hall":
            m.setdefault("extras", {})["far_color"] = [0.13, 0.13, 0.14]; rep["far_color"] = "dark"
    print(json.dumps(rep))
    if not dry:
        j.setdefault("extras", {})[MARK] = True
        print("wrote", path, save_glb(path, j, g.bin), "bytes")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("world", nargs="?", default="apps/console/public/assets/world-city3.glb"); ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(); run(a.world, a.dry_run)
