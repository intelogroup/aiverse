#!/usr/bin/env python3
"""Check that plan.py and the shipped world GLB agree about every building.

plan.json is a generated, gitignored file, and later bridge_* passes change the GLB without touching the plan, so the two drift. This reads the plan
fresh (plan.py in a temp cwd, as bridge_edge_landscape.py does) and classifies each plan building against the GLB scene:

  real       Bones_shop<n> (walls, floors, interiors) or Kit_shop<n> or Kit_hall<n> (a prebuilt kit building row, no interior) is in the scene and its box sits on the plan footprint.
  landscape  an `edge` (ring) block building, or an id in bridge_bazaar_demolish.ALL; no facade triangle left inside the footprint.
  shim       no Bones_shop<n> in the scene, but merged facade triangles still stand there (a hollow facade-only box). The hall counts as one.
  FAIL       anything else: a landscape building that still stands, a real building off its footprint, a market building with nothing at all.

KNOWN_SHIMS lists the shims that exist today. The check fails if a shim appears that is not listed (regression) or a listed one is no longer a shim
(delete it from the list). The rebuild is done when KNOWN_SHIMS is empty.

  python3 tools/city3/check_plan_vs_glb.py [glb]      exit 0 = plan and GLB agree
  python3 tools/city3/check_plan_vs_glb.py --selftest
"""
import argparse
import os
import runpy
import shutil
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# None left: the citadel block (4,1) is Kit_shop148-155 (bridge_citadel_townhouses.py) and the civic hall is Kit_hall0 (bridge_civic_hall.py).
KNOWN_SHIMS = set()
PAD = 0.3        # metres around a footprint, as bridge_bazaar_demolish.drop_tris
Y_MIN = 0.3      # ignore the walk slab and sidewalks
BOX_TOL = 2.0    # a real box may overhang its plan rect by this much (the Tea House porch sticks out 1.8 m); a node on the wrong lot is off by a building width
FACADE = "B_Facade_"
ALIAS = {"TeaHouseStructure": "shop-102"}   # the Tea House is its own building pipeline (tea_house/), not a Bones_shop node


def classify(item, scene_bones, box, tris, demolished, known_shims):
    """item: {id, kind, rect}; kind is the plan block kind or 'hall'. rect is [x0, z0, x1, z1] in GLB frame.
    scene_bones: ids with a Bones node in the scene. box: {id: [x0, z0, x1, z1]} of those nodes. tris: facade triangles inside the rect.
    Returns (class, problem or None)."""
    i = item["id"]
    if item["kind"] == "hall":
        return ("shim", None) if tris > 0 and i not in scene_bones else ("real", None) if i in scene_bones else ("FAIL", "hall has no geometry")
    if i in scene_bones:
        if tris and item["kind"] == "edge":
            return "FAIL", "edge building has a Bones node"
        x0, z0, x1, z1 = item["rect"]
        b = box[i]
        if b[0] < x0 - BOX_TOL or b[1] < z0 - BOX_TOL or b[2] > x1 + BOX_TOL or b[3] > z1 + BOX_TOL:
            return "FAIL", f"Bones box {np.round(b, 1).tolist()} is off the plan rect {item['rect']}"
        return "real", None
    if item["kind"] == "edge" or i in demolished:
        return ("FAIL", f"{tris} facade triangles still stand on a cleared lot") if tris else ("landscape", None)
    if tris > 0:
        return "shim", None
    return "FAIL", "market or citadel building has no Bones node and no facade"


def load_plan():
    here = os.getcwd()
    tmp = tempfile.mkdtemp()
    try:
        os.chdir(tmp)  # plan.py dumps plan.json into cwd
        return runpy.run_path(os.path.join(HERE, "plan.py"))
    finally:
        os.chdir(here)
        shutil.rmtree(tmp, ignore_errors=True)


def glb_rect(r, pad=0.0):
    """plan [x0, y0, x1, y1] to GLB [x0, z0, x1, z1] (z = -y)."""
    return [r[0] - pad, -r[3] - pad, r[2] + pad, -r[1] + pad]


def facade_centroids(g):
    out = []
    for n in g.gltf["nodes"]:
        if n.get("name", "").startswith(FACADE) and "mesh" in n:
            for p in g.gltf["meshes"][n["mesh"]]["primitives"]:
                P = g.acc_raw(p["attributes"]["POSITION"])
                T = P[g.indices_of(p).reshape(-1, 3)]
                # bridge_edge_landscape and bridge_bazaar collapse removed triangles to a point instead of deleting them
                live = np.linalg.norm(np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]), axis=1) > 1e-6
                c = T[live].mean(1)
                out.append(c[c[:, 1] > Y_MIN])
    return np.concatenate(out) if out else np.zeros((0, 3))


def scene_bones_boxes(g):
    j = g.gltf
    scene = set(j["scenes"][j.get("scene", 0)]["nodes"])
    ids, box = set(), {}

    def local(n):
        m = np.eye(4)
        if "matrix" in n:
            return np.array(n["matrix"], float).reshape(4, 4).T
        x, y, z, w = n.get("rotation", [0, 0, 0, 1])
        r = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
        m[:3, :3] = r * np.array(n.get("scale", [1, 1, 1]))
        m[:3, 3] = n.get("translation", [0, 0, 0])
        return m

    def extent(i, parent, lo, hi):  # the node's own mesh and every descendant's, accessor-box corners through the node chain
        n = j["nodes"][i]
        m = parent @ local(n)
        if "mesh" in n:
            for p in j["meshes"][n["mesh"]]["primitives"]:
                a = j["accessors"][p["attributes"]["POSITION"]]
                for c in np.array(np.meshgrid(*zip(a["min"], a["max"]))).reshape(3, -1).T:
                    q = m[:3, :3] @ c + m[:3, 3]
                    lo[:] = np.minimum(lo, q)
                    hi[:] = np.maximum(hi, q)
        for c in n.get("children", []):
            extent(c, m, lo, hi)

    for i, n in enumerate(j["nodes"]):
        nm = n.get("name", "")
        if i in scene and (nm.startswith(("Bones_shop", "Kit_shop", "Kit_hall")) or nm in ALIAS):
            lo, hi = np.full(3, 1e9), np.full(3, -1e9)
            extent(i, np.eye(4), lo, hi)
            if lo[0] > hi[0]:
                continue  # an empty group is not a building
            key = ALIAS.get(nm) or ("hall-" + nm[8:] if nm.startswith("Kit_hall") else "shop-" + nm[nm.index("shop") + 4:])
            ids.add(key)
            box[key] = [lo[0], lo[2], hi[0], hi[2]]
    return ids, box


def run(glb_path):
    from bridge_bazaar_demolish import ALL
    from bridge_wave1 import Glb
    ns = load_plan()
    kinds = {(b["i"], b["j"]): b["kind"] for b in ns["blocks"]}
    items = [{"id": f"shop-{n}", "kind": kinds[tuple(bd["block"])], "rect": glb_rect(bd["rect"])} for n, bd in enumerate(ns["buildings"])]
    items.append({"id": "hall-0", "kind": "hall", "rect": glb_rect(ns["halls"][0]["rect"])})
    g = Glb(glb_path)
    c = facade_centroids(g)
    scene_bones, box = scene_bones_boxes(g)
    demolished = {f"shop-{i}" for i in ALL}
    rep = {"real": [], "landscape": [], "shim": [], "FAIL": []}
    for it in items:
        r = glb_rect(ns["halls"][0]["rect"] if it["id"] == "hall-0" else ns["buildings"][int(it["id"][5:])]["rect"], PAD)
        tris = int(((c[:, 0] > r[0]) & (c[:, 0] < r[2]) & (c[:, 2] > r[1]) & (c[:, 2] < r[3])).sum())
        cls, why = classify(it, scene_bones, box, tris, demolished, KNOWN_SHIMS)
        rep[cls].append((it["id"], it["kind"], tris, why))
    return rep


def verdict(rep):
    shims = {x[0] for x in rep["shim"]}
    problems = [f"{i} ({k}): {w}" for i, k, _, w in rep["FAIL"]]
    problems += [f"new shim not in KNOWN_SHIMS: {i}" for i in sorted(shims - KNOWN_SHIMS)]
    problems += [f"KNOWN_SHIMS entry is no longer a shim, delete it: {i}" for i in sorted(KNOWN_SHIMS - shims)]
    return problems


def selftest():
    it = lambda i, k: {"id": i, "kind": k, "rect": [0, 0, 10, 10]}
    box = {"shop-1": [0, 0, 10, 10], "shop-2": [30, 30, 40, 40]}
    assert classify(it("shop-1", "market"), {"shop-1"}, box, 0, set(), set())[0] == "real"
    assert classify(it("shop-2", "market"), {"shop-2"}, box, 0, set(), set())[0] == "FAIL"        # box off its rect
    assert classify(it("shop-3", "edge"), set(), box, 0, set(), set())[0] == "landscape"
    assert classify(it("shop-3", "edge"), set(), box, 40, set(), set())[0] == "FAIL"              # ring house still standing
    assert classify(it("shop-4", "market"), set(), box, 0, {"shop-4"}, set())[0] == "landscape"   # demolished lot
    assert classify(it("shop-5", "citadel"), set(), box, 90, set(), set())[0] == "shim"
    assert classify(it("shop-6", "market"), set(), box, 0, set(), set())[0] == "FAIL"             # nothing there at all
    assert classify(it("hall-0", "hall"), set(), box, 16, set(), set())[0] == "shim"
    assert verdict({"real": [], "landscape": [], "shim": [("shop-9", "citadel", 9, None)], "FAIL": []})  # unlisted shim is a problem
    print("selftest ok")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("glb", nargs="?", default="apps/console/public/assets/world-city3.glb")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        selftest()
        sys.exit(0)
    rep = run(a.glb)
    print({k: len(v) for k, v in rep.items()}, "known shims left:", len(KNOWN_SHIMS))
    problems = verdict(rep)
    for p in problems:
        print("FAIL", p)
    sys.exit(1 if problems else 0)
