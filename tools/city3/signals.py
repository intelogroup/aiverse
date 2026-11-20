"""City 3 intersection signals -> apps/console/public/assets/world-signals.glb (pure python, no Blender).

One post per corner of every road junction outside the plaza, carrying one 3-lamp head that faces its own approach.
Plan coords (x east, y north) from plan.json; glTF is y-up with z = -y.  Right-hand traffic: the head for a driver
sits on the far RIGHT corner, so   eastbound: SE corner faces west,  westbound: NW faces east,
northbound: NE faces south,  southbound: SW faces north.
Each post also carries a pedestrian head (WALK / DON'T WALK) under the vehicle head, facing the same way and following
the same phase.  The GLB holds only the static metal (poles, heads); the lamps are listed per junction in
apps/console/src/features/world/signalLamps.json and drawn by the console as one instanced mesh, so every junction can
run its own phase offset (see packages/world-sim/src/trafficSignals.ts).
Run:  python3 tools/city3/signals.py   (reads tools/city3/plan.json: run plan.py first)"""
import json, math, os, struct, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "../../apps/console/public/assets/world-signals.glb")
plan = json.load(open(os.path.join(HERE, "plan.json")))
Z = plan["walk_z"]
px0, py0, px1, py1 = plan["plaza"]
POST_OFFSET = 0.8       # post centre beyond the junction corner on both axes, on the sidewalk
POST_H, HEAD_Y0, HEAD_H, HEAD_W, HEAD_D = 4.6, 3.7, 1.0, 0.36, 0.30
LAMP, LAMP_GAP = 0.22, 0.04
PED_Y0, PED_H, PED_W, PED_D = 3.0, 0.62, 0.34, 0.25   # pedestrian head sits under the vehicle head (HEAD_Y0 - 0.7)
LAMPS = []   # manifest rows for the console: one per lamp panel   # lamp panel size; 4 cm proud of the head face (>= 3 cm rule from the failures log)

class Mesh:
    def __init__(self): self.pos, self.nor, self.idx = [], [], []
    def quad(self, p, n):
        base = len(self.pos)
        self.pos += p; self.nor += [n] * 4
        self.idx += [base, base + 1, base + 2, base, base + 2, base + 3]
    def box(self, cx, cy, cz, sx, sy, sz, yaw=0.0):
        """Axis box rotated by yaw about y. Corners ordered so every face winds counter-clockwise from outside."""
        c, s = math.cos(yaw), math.sin(yaw)
        def w(x, y, z): return (cx + x * c + z * s, cy + y, cz - x * s + z * c)
        hx, hy, hz = sx / 2, sy / 2, sz / 2
        faces = [((1, 0, 0), [(hx, -hy, hz), (hx, -hy, -hz), (hx, hy, -hz), (hx, hy, hz)]),
                 ((-1, 0, 0), [(-hx, -hy, -hz), (-hx, -hy, hz), (-hx, hy, hz), (-hx, hy, -hz)]),
                 ((0, 1, 0), [(-hx, hy, hz), (hx, hy, hz), (hx, hy, -hz), (-hx, hy, -hz)]),
                 ((0, -1, 0), [(-hx, -hy, -hz), (hx, -hy, -hz), (hx, -hy, hz), (-hx, -hy, hz)]),
                 ((0, 0, 1), [(-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz)]),
                 ((0, 0, -1), [(hx, -hy, -hz), (-hx, -hy, -hz), (-hx, hy, -hz), (hx, hy, -hz)])]
        for (nx, ny, nz), pts in faces:
            self.quad([w(*p) for p in pts], (nx * c + nz * s, ny, -nx * s + nz * c))

MATS = {  # name -> (base colour, emissive colour, metallic, roughness)
    "sig_pole": ((0.30, 0.31, 0.33), None, 0.6, 0.55),
    "sig_head": ((0.04, 0.04, 0.05), None, 0.1, 0.6),
}
meshes = {name: Mesh() for name in MATS}

# (corner sign on x, sign on y) -> (phase, direction the head faces in plan coords)
CORNERS = {(1, -1): ("ew", (-1, 0)), (-1, 1): ("ew", (1, 0)), (1, 1): ("ns", (0, -1)), (-1, -1): ("ns", (0, 1))}

def junctions():
    out = []
    for sx in plan["streets"]:
        for sy in plan["streets"]:
            r = (sx["c"] - sx["w"] / 2, sy["c"] - sy["w"] / 2, sx["c"] + sx["w"] / 2, sy["c"] + sy["w"] / 2)
            if not (r[0] >= px0 - .01 and r[1] >= py0 - .01 and r[2] <= px1 + .01 and r[3] <= py1 + .01): out.append(r)
    return out

cur = 0
def post(x, y, phase, face):
    cx, cz = x, -y                     # glTF position of the post
    fx, fz = face[0], -face[1]         # head facing in glTF xz
    yaw = math.atan2(fx, fz)           # box +z axis points along the facing
    meshes["sig_pole"].box(cx, Z + POST_H / 2, cz, 0.14, POST_H, 0.14)
    hy = Z + HEAD_Y0 + HEAD_H / 2
    meshes["sig_head"].box(cx, hy, cz, HEAD_W, HEAD_H, HEAD_D, yaw)
    # lamp panels on the face toward approaching traffic, red on top
    ox, oz = fx * (HEAD_D / 2 + LAMP_GAP), fz * (HEAD_D / 2 + LAMP_GAP)
    for k, colour in enumerate(("red", "yellow", "green")):
        ly = Z + HEAD_Y0 + HEAD_H - 0.20 - k * 0.30
        LAMPS.append({"j": cur, "phase": phase, "kind": colour, "p": [round(cx + ox, 3), round(ly, 3), round(cz + oz, 3)], "yaw": round(yaw, 4), "s": [LAMP, LAMP]})
    # pedestrian head: WALK on top, DON'T WALK below
    meshes["sig_head"].box(cx, Z + PED_Y0 + PED_H / 2, cz, PED_W, PED_H, PED_D, yaw)
    pox, poz = fx * (PED_D / 2 + LAMP_GAP), fz * (PED_D / 2 + LAMP_GAP)
    for kind, dy in (("walk", 0.45), ("dont", 0.17)):
        LAMPS.append({"j": cur, "phase": phase, "kind": kind, "p": [round(cx + pox, 3), round(Z + PED_Y0 + dy, 3), round(cz + poz, 3)], "yaw": round(yaw, 4), "s": [0.24, 0.24]})

count = 0
J = junctions()
for cur, (x0, y0, x1, y1) in enumerate(J):
    for (sx, sy), (phase, face) in CORNERS.items():
        px = (x1 + POST_OFFSET) if sx > 0 else (x0 - POST_OFFSET)
        py = (y1 + POST_OFFSET) if sy > 0 else (y0 - POST_OFFSET)
        post(px, py, phase, face)
        count += 1

# ---- glb ----
blob, views, accessors, materials, prims = bytearray(), [], [], [], []
def add(data, target, comp, ctype, n, mn=None, mx=None):
    while len(blob) % 4: blob.append(0)
    views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data), "target": target})
    blob.extend(data)
    a = {"bufferView": len(views) - 1, "componentType": comp, "count": n, "type": ctype}
    if mn: a["min"], a["max"] = mn, mx
    accessors.append(a)
    return len(accessors) - 1
for name, (base, emit, metal, rough) in MATS.items():
    m = {"name": name, "pbrMetallicRoughness": {"baseColorFactor": [*base, 1.0], "metallicFactor": metal, "roughnessFactor": rough}}
    if emit: m["emissiveFactor"] = list(emit)
    materials.append(m)
nodes, gmeshes = [], []
for mi, (name, mesh) in enumerate(meshes.items()):
    if not mesh.pos: continue
    xs, ys, zs = zip(*mesh.pos)
    p = add(b"".join(struct.pack("<3f", *v) for v in mesh.pos), 34962, 5126, "VEC3", len(mesh.pos), [min(xs), min(ys), min(zs)], [max(xs), max(ys), max(zs)])
    n = add(b"".join(struct.pack("<3f", *v) for v in mesh.nor), 34962, 5126, "VEC3", len(mesh.nor))
    i = add(b"".join(struct.pack("<I", v) for v in mesh.idx), 34963, 5125, "SCALAR", len(mesh.idx))
    gmeshes.append({"name": name, "primitives": [{"attributes": {"POSITION": p, "NORMAL": n}, "indices": i, "material": mi}]})
    nodes.append({"name": name, "mesh": len(gmeshes) - 1})
doc = {"asset": {"version": "2.0", "generator": "tools/city3/signals.py"}, "scene": 0, "scenes": [{"nodes": list(range(len(nodes)))}],
       "nodes": nodes, "meshes": gmeshes, "materials": materials, "accessors": accessors, "bufferViews": views,
       "buffers": [{"byteLength": len(blob)}]}
js = json.dumps(doc, separators=(",", ":")).encode()
js += b" " * (-len(js) % 4)
blob.extend(b"\0" * (-len(blob) % 4))
glb = struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(js) + 8 + len(blob)) + struct.pack("<I4s", len(js), b"JSON") + js + struct.pack("<I4s", len(blob), b"BIN\0") + bytes(blob)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, "wb").write(glb)
MANIFEST = os.path.join(HERE, "../../apps/console/src/features/world/signalLamps.json")
json.dump({"generator": "tools/city3/signals.py", "junctions": [{"id": i, "rect": list(r)} for i, r in enumerate(J)], "lamps": LAMPS}, open(MANIFEST, "w"), separators=(",", ":"))
print(f"lamps {len(LAMPS)} junctions {len(junctions())} posts {count} -> {os.path.relpath(OUT)} {len(glb)} bytes")
