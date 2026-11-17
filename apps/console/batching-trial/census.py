#!/usr/bin/env python3
"""Offline census of the PR #163 city asset (world-city3-optimized.glb,
sha256 b14cb2dc..., the exact file the LOD trial measured against).

Walks the glTF node graph from the scene roots, classifies every reachable
mesh node, and reports per-category: nodes, draw items (primitives), GPU
instances, triangles. Orphan (unreachable) nodes are counted separately —
the LOD trial found 236 of them; they are never baked or merged.

Categories:
  propFamily  — the LOD trial's set: node name ^SK_med_stall / ^inst_goods_ /
                ^FountainClayPot
  door        — name contains 'door' (TeaDoorLeaf drives inst_door_double's
                instance matrices: state, excluded)
  waterSea    — any primitive material named water/sea (DistrictWorld hides
                these at runtime; excluded so a merge can never resurrect them)
  otherStatic — every other reachable mesh node (buildings, landscape, ...)
"""
import json
import re
import struct
import sys
from collections import defaultdict

PATH = sys.argv[1] if len(sys.argv) > 1 else "/home/hatch/workspace/.build-tmp/world-compress/world-city3-optimized.glb"

with open(PATH, "rb") as f:
    magic, _ver, _length = struct.unpack("<III", f.read(12))
    assert magic == 0x46546C67, "not a GLB"
    clen, _ctype = struct.unpack("<II", f.read(8))
    g = json.loads(f.read(clen))

nodes = g.get("nodes", [])
meshes = g.get("meshes", [])
materials = g.get("materials", [])
accessors = g.get("accessors", [])

# reachability from scene roots
reachable = set()
stack = list(g["scenes"][g.get("scene", 0)]["nodes"])
while stack:
    i = stack.pop()
    if i in reachable:
        continue
    reachable.add(i)
    stack.extend(nodes[i].get("children", []))

PROP = re.compile(r"^(SK_med_stall|inst_goods_|FountainClayPot)")


def prim_tris(prim):
    idx = prim.get("indices")
    if idx is not None:
        return accessors[idx]["count"] // 3
    return accessors[prim["attributes"]["POSITION"]]["count"] // 3


def instance_count(node):
    ext = node.get("extensions", {}).get("EXT_mesh_gpu_instancing")
    if not ext:
        return 1
    attrs = ext.get("attributes", {})
    for key in ("TRANSLATION", "ROTATION", "SCALE"):
        if key in attrs:
            return accessors[attrs[key]]["count"]
    return 1


cats = defaultdict(lambda: {"nodes": 0, "prims": 0, "instances": 0, "tris": 0, "instancedNodes": 0})
mesh_names = defaultdict(int)
door_names = defaultdict(int)
orphan = {"nodes": 0, "meshNodes": 0, "propFamily": 0}
multi_prim_meshes = 0

for i, node in enumerate(nodes):
    name = node.get("name", "")
    if "mesh" not in node:
        if i not in reachable:
            orphan["nodes"] += 1
        continue
    mesh = meshes[node["mesh"]]
    mesh_names[mesh.get("name", "<unnamed>")] += 1
    if i not in reachable:
        orphan["nodes"] += 1
        orphan["meshNodes"] += 1
        if PROP.match(name):
            orphan["propFamily"] += 1
        continue
    inst = instance_count(node)
    tris = sum(prim_tris(p) for p in mesh["primitives"]) * inst
    mat_names = {materials[p["material"]].get("name", "") if "material" in p else "" for p in mesh["primitives"]}
    if PROP.match(name):
        cat = "propFamily"
    elif "door" in name.lower():
        cat = "door"
        door_names[name] += 1
    elif mat_names & {"water", "sea"}:
        cat = "waterSea"
    else:
        cat = "otherStatic"
    c = cats[cat]
    c["nodes"] += 1
    c["prims"] += len(mesh["primitives"])
    c["instances"] += inst
    c["tris"] += tris
    if inst > 1:
        c["instancedNodes"] += 1
    if len(mesh["primitives"]) > 1:
        multi_prim_meshes += 1

print(f"asset: {PATH}")
print(f"total nodes {len(nodes)}, reachable {len(reachable)}, orphan nodes {len(nodes) - len(reachable)}")
print(f"orphan mesh nodes {orphan['meshNodes']} (of which prop-pattern {orphan['propFamily']})")
print(f"meshes {len(meshes)}, multi-primitive mesh nodes {multi_prim_meshes}")
print()
tot = {"nodes": 0, "prims": 0, "instances": 0, "tris": 0}
for cat in ("propFamily", "otherStatic", "door", "waterSea"):
    c = cats[cat]
    for k in tot:
        tot[k] += c[k]
    print(f"{cat:12s} nodes {c['nodes']:5d} (instanced {c['instancedNodes']:3d})  prims {c['prims']:5d}  instances {c['instances']:6d}  tris {c['tris']:10d}")
print(f"{'TOTAL':12s} nodes {tot['nodes']:5d}                    prims {tot['prims']:5d}  instances {tot['instances']:6d}  tris {tot['tris']:10d}")
print()
print("door node names:", dict(door_names))
print("top mesh names by node count:", sorted(mesh_names.items(), key=lambda kv: -kv[1])[:12])
