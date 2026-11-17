#!/usr/bin/env python3
"""Instancing census: per-(mesh,material-prim) placement counts over the
reachable city graph, with the batching trial's category rules, plus a
tree hunt. A 'placement' is one node x one EXT_mesh_gpu_instancing
instance. Groups sorted by placements and by total tris."""
import json, re, struct, sys
from collections import defaultdict

PATH = sys.argv[1]
with open(PATH, "rb") as f:
    magic, _ver, _length = struct.unpack("<III", f.read(12))
    assert magic == 0x46546C67
    clen, _ctype = struct.unpack("<II", f.read(8))
    g = json.loads(f.read(clen))

nodes, meshes, materials, accessors = g["nodes"], g["meshes"], g.get("materials", []), g["accessors"]
parent = {}
reachable = set()
stack = list(g["scenes"][g.get("scene", 0)]["nodes"])
while stack:
    i = stack.pop()
    if i in reachable: continue
    reachable.add(i)
    for c in nodes[i].get("children", []):
        parent[c] = i
        stack.append(c)

def chain(i):
    out = []
    while i is not None:
        out.append(nodes[i].get("name", ""))
        i = parent.get(i)
    return "/".join(reversed(out))

PROP = re.compile(r"^(SK_med_stall|inst_goods_|FountainClayPot)")
DOOR = re.compile(r"door", re.I)
STATEFUL = re.compile(r"radio|interactable", re.I)
TREE = re.compile(r"tree|palm|leaf|leaves|crown|trunk|foliage|plant|bush|shrub|olive|cypress|pine|oak", re.I)

def prim_tris(p):
    idx = p.get("indices")
    return (accessors[idx]["count"] if idx is not None else accessors[p["attributes"]["POSITION"]]["count"]) // 3

def inst_count(node):
    ext = node.get("extensions", {}).get("EXT_mesh_gpu_instancing")
    if not ext: return 1
    for k in ("TRANSLATION", "ROTATION", "SCALE"):
        if k in ext.get("attributes", {}):
            return accessors[ext["attributes"][k]]["count"]
    return 1

groups = {}   # (meshIdx, primIdx) -> dict
treerep = []
for i, node in enumerate(nodes):
    if "mesh" not in node or i not in reachable: continue
    ch = chain(i)
    mesh = meshes[node["mesh"]]
    inst = inst_count(node)
    mats = [materials[p["material"]].get("name", "") if "material" in p else "" for p in mesh["primitives"]]
    if any(PROP.match(seg) for seg in ch.split("/")): cat = "propFamily"
    elif DOOR.search(ch): cat = "door"
    elif STATEFUL.search(ch): cat = "stateful"
    elif set(mats) & {"water", "sea"}: cat = "waterSea"
    else: cat = "otherStatic"
    for pi, p in enumerate(mesh["primitives"]):
        key = (node["mesh"], pi)
        e = groups.setdefault(key, {"meshName": mesh.get("name", ""), "mat": mats[pi], "tris": prim_tris(p),
                                    "placements": 0, "nodes": 0, "cat": cat, "sampleChain": ch})
        e["placements"] += inst
        e["nodes"] += 1
    if TREE.search(ch):
        treerep.append((ch, node.get("name", ""), mesh.get("name", ""), inst, sum(prim_tris(p) for p in mesh["primitives"]), mats))

inscope = {k: v for k, v in groups.items() if v["cat"] in ("propFamily", "otherStatic")}
print(f"== in-scope (mesh,prim) groups: {len(inscope)}; total placements {sum(v['placements'] for v in inscope.values())}")
print("\n== TOP 30 in-scope groups by PLACEMENTS ==")
for k, v in sorted(inscope.items(), key=lambda kv: -kv[1]["placements"])[:30]:
    print(f"pl {v['placements']:6d} nodes {v['nodes']:5d} tris/prim {v['tris']:7d} totTris {v['placements']*v['tris']:9d} mat '{v['mat']}' mesh '{v['meshName']}' cat {v['cat']} e.g. {v['sampleChain'][-70:]}")
print("\n== TOP 20 in-scope groups by TOTAL TRIS ==")
for k, v in sorted(inscope.items(), key=lambda kv: -kv[1]["placements"]*kv[1]["tris"])[:20]:
    print(f"pl {v['placements']:6d} nodes {v['nodes']:5d} tris/prim {v['tris']:7d} totTris {v['placements']*v['tris']:9d} mat '{v['mat']}' mesh '{v['meshName']}' cat {v['cat']}")
print("\n== TREE-name hunt (chain matches tree|palm|leaf|crown|trunk|foliage|plant|bush...) ==")
if not treerep: print("(no matches)")
agg = defaultdict(lambda: [0, 0, 0])
for ch, nn, mn, inst, tris, mats in treerep:
    agg[(nn, mn)][0] += 1; agg[(nn, mn)][1] += inst; agg[(nn, mn)][2] += tris * inst
for (nn, mn), (n, inst, tris) in sorted(agg.items(), key=lambda kv: -kv[1][1]):
    print(f"nodes {n:4d} placements {inst:6d} totTris {tris:9d} nodeName '{nn}' mesh '{mn}'")
print("\n== name-token frequency over reachable mesh-node chains (top 40 first-segments) ==")
seg = defaultdict(int)
for i, node in enumerate(nodes):
    if "mesh" not in node or i not in reachable: continue
    for s in set(chain(i).split("/")):
        if s: seg[s] += 1
for s, n in sorted(seg.items(), key=lambda kv: -kv[1])[:40]:
    print(f"{n:5d}  {s}")
