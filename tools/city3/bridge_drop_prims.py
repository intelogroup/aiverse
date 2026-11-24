#!/usr/bin/env python3
"""Drop every primitive of one material from one named mesh (e.g. the lido's 0.8 m box loungers, BzOpen_lounger in BzOpenSpace, now that
props-lido places real ones). Visual only; idempotent. Run bridge_compact.py --drop-dead after it.
  python3 tools/city3/bridge_drop_prims.py --mesh BzOpenSpace --material BzOpen_lounger [world.glb] [--dry-run] [--selftest]"""
import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))


def drop(j, mesh_name, mat_name):
    n = 0
    for m in j["meshes"]:
        if m.get("name") != mesh_name:
            continue
        keep = [p for p in m["primitives"] if j["materials"][p["material"]].get("name") != mat_name] if "materials" in j else m["primitives"]
        n += len(m["primitives"]) - len(keep)
        if not keep:
            raise SystemExit(f"{mesh_name}: would drop every primitive")
        m["primitives"] = keep
    return n


def selftest():
    j = {"materials": [{"name": "a"}, {"name": "b"}], "meshes": [{"name": "M", "primitives": [{"material": 0}, {"material": 1}, {"material": 1}]}, {"name": "N", "primitives": [{"material": 1}]}]}
    assert drop(j, "M", "b") == 2 and [p["material"] for p in j["meshes"][0]["primitives"]] == [0] and len(j["meshes"][1]["primitives"]) == 1
    assert drop(j, "M", "b") == 0
    print("selftest ok")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("world", nargs="?", default="apps/console/public/assets/world-city3.glb")
    ap.add_argument("--mesh"); ap.add_argument("--material"); ap.add_argument("--dry-run", action="store_true"); ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        selftest(); sys.exit(0)
    from bridge_wave1 import Glb, save_glb
    w = Glb(a.world); n = drop(w.gltf, a.mesh, a.material)
    print({"dropped": n})
    if n and not a.dry_run:
        print("wrote", a.world, save_glb(a.world, w.gltf, w.bin), "bytes")
