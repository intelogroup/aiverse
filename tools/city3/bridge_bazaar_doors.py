#!/usr/bin/env python3
"""Bazaar entrance doors from a real CC0 asset (loafbrr "Low Poly Doors", assets/bazaar-doors), patched onto world-city3.glb.

Replaces the procedural hero-shop doors (inst_door_* statics + baked Door_shop<id> leaf) for every shop that has an interior
(interiors/index.json): door frame, wall surround and an open leaf from the asset, placed at the real opening (index `door` + `front`,
which is where the Bones shell is cut, not where the old statics stood: 37 of 58 were off by 2-6 m, and 19 still stood at demolished lots).
The Tea House instance of inst_door_double stays (TeaDoorLeaf and teaDoor.ts address it by index); every other instance is parked far below
the island so indices do not shift. Door_shop nodes leave the scene. Doors are visual only (the collision opening is unchanged).
Leaf swings inward 70-88 deg about the left jamb, like the old leaves, so the doorway stays walkable.
  python3 tools/city3/bridge_bazaar_doors.py [glb] [--dry-run]
"""
import argparse, base64, json, math, os, random, sys
sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
from bridge_landscape_kit import add_accessor, add_view
from bridge_wave1 import Glb, save_glb

ASSET = os.path.join(HERE, "assets", "bazaar-doors")
INDEX = os.path.join(HERE, "..", "..", "apps", "console", "public", "assets", "interiors", "index.json")
TEA_LOT = (-40.0, -10.0, -88.0, -69.0)  # x0, x1, z0, z1
BASE_Y = 0.2  # Bones ground floor top
YAW = {"S": 0.0, "N": 180.0, "E": 90.0, "W": -90.0}  # local +z (out of the building) -> world out of the front wall
# asset door numbers by room template (see the atlas sheet: 14/12 glazed, 9/1/16 panelled, 10/11/4 dark, 6/15 planks, 2/8/13 coloured)
POOL = {"cafe": [14, 12, 9, 1, 7], "shop": [2, 8, 13, 16, 3, 9, 12], "library": [10, 11, 4, 8, 6], "workshop": [6, 15, 4, 10, 7], "press": [10, 13]}
VARIANTS = ["base", "red", "green", "blue", "dark", "brown", "white"]
KEEP_OWN = .55  # share of doors that keep the colour they are painted with in the atlas


def load_asset():
    j = json.load(open(os.path.join(ASSET, "DoorsAsset.gltf")))
    buf = base64.b64decode(j["buffers"][0]["uri"].split(",", 1)[1])
    def acc(i):
        a = j["accessors"][i]; bv = j["bufferViews"][a["bufferView"]]; n = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}[a["type"]]
        dt = {5126: "<f4", 5123: "<u2", 5125: "<u4"}[a["componentType"]]
        return np.frombuffer(buf, dt, count=a["count"] * n, offset=bv.get("byteOffset", 0) + a.get("byteOffset", 0)).reshape(a["count"], n)
    byname = {n.get("name"): n for n in j["nodes"] if "mesh" in n}
    def part(name):
        n = byname.get(name)
        if not n: return None
        p = j["meshes"][n["mesh"]]["primitives"][0]; at = p["attributes"]
        return {"P": acc(at["POSITION"]).astype("f8") + np.array(n.get("translation") or [0, 0, 0]), "N": acc(at["NORMAL"]).astype("f8"),
                "U": acc(at["TEXCOORD_0"]).astype("f4"), "I": acc(p["indices"]).astype("u4").ravel()}
    doors = {}
    for k in (1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16):  # 5 = roller shutter, 17 = slatted: not entrances
        d = {"leaf": part(f"Door_{k}"), "frame": part(f"DoorFrame_{k}"), "outer": part(f"DoorOuterFrame_{k}")}
        if d["leaf"] and d["frame"]: doors[k] = d
    return doors


def rot_y(P, N, deg, pivot=(0.0, 0.0)):
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg)); px, pz = pivot
    x, z = P[:, 0] - px, P[:, 2] - pz; Q = P.copy(); Q[:, 0] = px + x * c + z * s; Q[:, 2] = pz - x * s + z * c
    M = N.copy(); M[:, 0] = N[:, 0] * c + N[:, 2] * s; M[:, 2] = -N[:, 0] * s + N[:, 2] * c
    return Q, M


def place(door, x, z, yaw, swing):
    """world-space parts of one door: frame + outer fixed, leaf opened about its left (-u) edge."""
    out = []
    lf = door["leaf"]; hx = float(lf["P"][:, 0].min()); hz = float((lf["P"][:, 2].min() + lf["P"][:, 2].max()) / 2)
    for key in ("frame", "outer", "leaf"):
        p = door[key]
        if p is None: continue
        P, N = p["P"], p["N"]
        if key == "leaf": P, N = rot_y(P, N, swing, (hx, hz))
        P, N = rot_y(P, N, yaw)
        P = P + np.array([x, BASE_Y, z])
        out.append((P.astype("<f4"), N.astype("<f4"), p["U"], p["I"]))
    return out


def run(path, dry):
    g = Glb(path); j = g.gltf
    if j.get("extras", {}).get("bazaar_doors_pass"):
        print({"already_patched": True}); return
    doors = load_asset(); idx = json.load(open(INDEX)); rep = {"doors": 0, "styles": {}, "instances_parked": 0, "door_shop_removed": 0}
    meshes = {v: ([], [], [], []) for v in VARIANTS}; off = {v: 0 for v in VARIANTS}
    for e in idx:
        if e["id"] == "tea" or e["front"] not in YAW: continue
        rnd = random.Random(8800 + sum(map(ord, e["id"])) * 31)  # ids are shop-N, press, tea
        k = rnd.choice([d for d in POOL.get(e["template"], POOL["shop"]) if d in doors]); var = "base" if rnd.random() < KEEP_OWN else rnd.choice(VARIANTS[1:])
        x, z = e["door"]; swing = rnd.uniform(70, 88)
        for P, N, U, I in place(doors[k], x, z, YAW[e["front"]], swing):
            m = meshes[var]; m[0].append(P); m[1].append(N); m[2].append(U); m[3].append(I + off[var]); off[var] += len(P)
        rep["doors"] += 1; rep["styles"][k] = rep["styles"].get(k, 0) + 1
    if dry:
        print(json.dumps(rep)); return
    scene = j["scenes"][j.get("scene", 0)]["nodes"]
    for ni in list(scene):
        if j["nodes"][ni].get("name", "").startswith("Door_shop"): scene.remove(ni); rep["door_shop_removed"] += 1
    for node in j["nodes"]:  # statics: keep Tea's instance (index-addressed by the runtime), park the rest
        if not node.get("name", "").startswith("inst_door_"): continue
        at = node["extensions"]["EXT_mesh_gpu_instancing"]["attributes"]; T = g.acc_raw(at["TRANSLATION"])
        for i in range(len(T)):
            if not (TEA_LOT[0] < T[i, 0] < TEA_LOT[1] and TEA_LOT[2] < T[i, 2] < TEA_LOT[3]): T[i, 1] = -1000.0; rep["instances_parked"] += 1
        g.rewrite_accessor(at["TRANSLATION"], T)
    tex = {}
    def texture(fn):
        if fn not in tex:
            v = add_view(g, open(os.path.join(ASSET, fn), "rb").read(), None); j["bufferViews"][v].pop("target", None)
            j["images"].append({"name": "bzd_" + fn[:-4], "bufferView": v, "mimeType": "image/jpeg"}); j["textures"].append({"source": len(j["images"]) - 1}); tex[fn] = len(j["textures"]) - 1
        return tex[fn]
    def acc(a, typ, mm=False):
        a = np.ascontiguousarray(a, "<f4"); return add_accessor(g, add_view(g, a.tobytes(), 34962), 5126, len(a), typ, a.min(0).tolist() if mm else None, a.max(0).tolist() if mm else None)
    prims = []
    for var, (Ps, Ns, Us, Is) in meshes.items():
        if not Ps: continue
        P, N, U, I = np.concatenate(Ps), np.concatenate(Ns), np.concatenate(Us), np.concatenate(Is).astype("<u4")
        j["materials"].append({"name": f"BzDoor_{var}", "doubleSided": True, "pbrMetallicRoughness": {"baseColorTexture": {"index": texture(f"color_{var}.jpg")}, "metallicFactor": 0.0, "roughnessFactor": .72},
                               "normalTexture": {"index": texture("normal.jpg"), "scale": 1.0}})
        prims.append({"attributes": {"POSITION": acc(P, "VEC3", True), "NORMAL": acc(N, "VEC3"), "TEXCOORD_0": acc(U, "VEC2")}, "indices": add_accessor(g, add_view(g, I.tobytes(), 34963), 5125, len(I), "SCALAR"), "material": len(j["materials"]) - 1})
    j["meshes"].append({"name": "BzDoors", "primitives": prims}); j["nodes"].append({"name": "BzDoors", "mesh": len(j["meshes"]) - 1}); scene.append(len(j["nodes"]) - 1)
    j.setdefault("extras", {})["bazaar_doors_pass"] = "v1"
    print(json.dumps(rep)); print("wrote", path, save_glb(path, g.gltf, g.bin), "bytes")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("glb", nargs="?", default="apps/console/public/assets/world-city3.glb")
    ap.add_argument("--dry-run", action="store_true"); a = ap.parse_args(); run(a.glb, a.dry_run)
