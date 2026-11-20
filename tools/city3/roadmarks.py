"""City 3 road paint and vertical signs -> apps/console/public/assets/world-roadmarks.glb (pure python, no Blender).

Horizontal: centre line (double solid yellow on the 20 m avenue, dashed yellow on 10 m streets), white edge lines,
white lane dividers on the avenue, a white stop line per approach.  Vertical: on the driver's right at every approach,
a "signal ahead" diamond 18 m before the junction and a pedestrian-crossing diamond at the zebra.  No lettering (no text
glyphs in this pipeline), so only symbolic MUTCD signs.
Plan coords (x east, y north) from plan.json; glTF is y-up with z = -y.  Paint sits 5 cm over the road like the zebra
stripes in build_city.py (>= 3 cm rule from the failures log); sign faces are 2 cm proud of the plate.
Run:  python3 tools/city3/roadmarks.py   (reads tools/city3/plan.json: run plan.py first)"""
import json, math, os, struct

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "../../apps/console/public/assets/world-roadmarks.glb")
plan = json.load(open(os.path.join(HERE, "plan.json")))
Z, L = plan["walk_z"], plan["land"]
px0, py0, px1, py1 = plan["plaza"]
PAINT = Z + 0.05
LINE_W, TRIM = 0.12, 4.4          # line width; paint stops 4.4 m from a junction edge (zebra ends at 4.0)
SIGN_SETBACK, SIGN_CURB = 0.7, 0.7

class Mesh:
    def __init__(self): self.pos, self.nor, self.idx = [], [], []
    def quad(self, p, n):
        b = len(self.pos); self.pos += p; self.nor += [n] * len(p)   # convex polygon, fan triangulated
        for i in range(1, len(p) - 1): self.idx += [b, b + i, b + i + 1]
    def box(self, cx, cy, cz, sx, sy, sz):
        hx, hy, hz = sx / 2, sy / 2, sz / 2
        for n, pts in [((1, 0, 0), [(hx, -hy, hz), (hx, -hy, -hz), (hx, hy, -hz), (hx, hy, hz)]),
                       ((-1, 0, 0), [(-hx, -hy, -hz), (-hx, -hy, hz), (-hx, hy, hz), (-hx, hy, -hz)]),
                       ((0, 1, 0), [(-hx, hy, hz), (hx, hy, hz), (hx, hy, -hz), (-hx, hy, -hz)]),
                       ((0, -1, 0), [(-hx, -hy, -hz), (hx, -hy, -hz), (hx, -hy, hz), (-hx, -hy, hz)]),
                       ((0, 0, 1), [(-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz)]),
                       ((0, 0, -1), [(hx, -hy, -hz), (-hx, -hy, -hz), (-hx, hy, -hz), (hx, hy, -hz)])]:
            self.quad([(cx + x, cy + y, cz + z) for x, y, z in pts], n)

MATS = {  # name -> (base colour, metallic, roughness)
    "mark_white": ((0.85, 0.85, 0.82), 0.0, 0.9), "mark_yellow": ((0.92, 0.70, 0.04), 0.0, 0.9),
    "sign_pole": ((0.30, 0.31, 0.33), 0.6, 0.55), "sign_back": ((0.55, 0.56, 0.58), 0.4, 0.6),
    "sign_yellow": ((0.95, 0.75, 0.05), 0.0, 0.5), "sign_lime": ((0.62, 0.85, 0.08), 0.0, 0.5),
    "sign_black": ((0.02, 0.02, 0.02), 0.0, 0.7), "sign_red": ((0.75, 0.05, 0.05), 0.0, 0.5),
    "sign_green": ((0.05, 0.6, 0.2), 0.0, 0.5),
}
meshes = {k: Mesh() for k in MATS}

def paint(mat, x0, y0, x1, y1):
    """Flat quad on the road, plan coords, facing up (glTF +y)."""
    meshes[mat].quad([(x0, PAINT, -y0), (x1, PAINT, -y0), (x1, PAINT, -y1), (x0, PAINT, -y1)], (0, 1, 0))

def in_plaza(x, y): return px0 <= x <= px1 and py0 <= y <= py1
def rect_in_plaza(r): return r[0] >= px0 - .01 and r[1] >= py0 - .01 and r[2] <= px1 + .01 and r[3] <= py1 + .01
S = plan["streets"]
JUNCTIONS = [(a["c"] - a["w"] / 2, b["c"] - b["w"] / 2, a["c"] + a["w"] / 2, b["c"] + b["w"] / 2)
             for a in S for b in S
             if not rect_in_plaza((a["c"] - a["w"] / 2, b["c"] - b["w"] / 2, a["c"] + a["w"] / 2, b["c"] + b["w"] / 2))]

def runs(blocked):
    """[-L, L] minus the blocked (t0, t1) intervals."""
    out, t = [], -L
    for a, b in sorted(blocked):
        if a > t: out.append((t, a))
        t = max(t, b)
    if t < L: out.append((t, L))
    return out

def dashes(t0, t1, on, off):
    t = t0
    while t + on <= t1 + 1e-6:
        yield t, t + on
        t += on + off

# ---- lines: one street at a time, along its axis (axis 'y': street at x=c; axis 'x': street at y=c)
for axis in ("y", "x"):
    for s in S:
        c, w = s["c"], s["w"]
        blocked = []
        for (x0, y0, x1, y1) in JUNCTIONS:
            lo, hi = (y0, y1) if axis == "y" else (x0, x1)
            cross = (x0, x1) if axis == "y" else (y0, y1)
            if cross[0] < c < cross[1]: blocked.append((lo - TRIM, hi + TRIM))
        # the street running through the plaza is cobble there
        if px0 < c < px1: blocked.append((px0 if axis == "y" else px0, px1))
        for t0, t1 in runs(blocked):
            def line(mat, off, a, b):  # a strip of LINE_W centred `off` from the street centre, from t=a..b
                if axis == "y": paint(mat, c + off - LINE_W / 2, a, c + off + LINE_W / 2, b)
                else: paint(mat, a, c + off - LINE_W / 2, b, c + off + LINE_W / 2)
            for off in (-(w / 2 - 0.4), w / 2 - 0.4): line("mark_white", off, t0, t1)
            if w >= 20:
                for off in (-0.15, 0.15): line("mark_yellow", off, t0, t1)
                for off in (-w / 4, w / 4):
                    for a, b in dashes(t0, t1, 3.0, 9.0): line("mark_white", off, a, b)
            else:
                for a, b in dashes(t0, t1, 3.0, 6.0): line("mark_yellow", 0.0, a, b)

# ---- one entry per approach: (arm name, travel direction in plan coords)
ARMS = ("n", "s", "e", "w")
TRAVEL = {"n": (0, -1), "s": (0, 1), "e": (-1, 0), "w": (1, 0)}   # traffic coming FROM that arm moves this way

def sign(x, y, travel, face_mat, art):
    """Post at plan (x, y) with a diamond plate facing the oncoming traffic; art(origin, right, up, n) adds the symbol."""
    h = 0.55                                   # diamond half-diagonal
    cy = Z + 2.1 + h
    meshes["sign_pole"].box(x, (Z + cy - h) / 2, -y, 0.07, cy - h - Z + 0.02, 0.07)   # stops at the plate bottom, never in front of the face
    n = (-travel[0], 0.0, travel[1])           # glTF-space facing: opposite the travel direction (z = -y)
    up = (0.0, 1.0, 0.0)
    right = (up[1] * n[2] - up[2] * n[1], up[2] * n[0] - up[0] * n[2], up[0] * n[1] - up[1] * n[0])   # up x n
    o = (x, cy, -y)
    def pt(u, v, d): return tuple(o[i] + right[i] * u + up[i] * v + n[i] * d for i in range(3))
    def poly(mat, pts, d):   # pts CCW seen from the front (u right, v up)
        m = meshes[mat]
        m.quad([pt(u, v, d) for u, v in pts], n)
    diamond = lambda r: [(-r, 0), (0, -r), (r, 0), (0, r)]
    poly("sign_back", diamond(h), 0.0)
    poly(face_mat, diamond(h - 0.04), 0.012)
    art(poly)

def rect(u0, v0, u1, v1): return [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
def disc(cu, cv, r, k=10): return [(cu + r * math.cos(2 * math.pi * i / k), cv + r * math.sin(2 * math.pi * i / k)) for i in range(k)]

def art_signal(poly):          # black box with red/yellow/green dots
    poly("sign_black", rect(-0.11, -0.28, 0.11, 0.28), 0.024)
    for v, m in ((0.18, "sign_red"), (0.0, "sign_yellow"), (-0.18, "sign_green")): poly(m, disc(0, v, 0.065), 0.036)

def art_ped(poly):             # walking figure
    poly("sign_black", disc(0.02, 0.27, 0.07), 0.024)                                   # head
    poly("sign_black", [(-0.08, 0.17), (0.12, 0.17), (0.09, -0.04), (-0.05, -0.04)], 0.024)   # torso
    poly("sign_black", [(-0.05, -0.04), (0.02, -0.04), (-0.12, -0.30), (-0.2, -0.28)], 0.024)  # rear leg
    poly("sign_black", [(0.02, -0.04), (0.09, -0.04), (0.2, -0.30), (0.12, -0.31)], 0.024)    # front leg

for (x0, y0, x1, y1) in JUNCTIONS:
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for arm in ARMS:
        # stop line (whole approach half-width, 4.5-5.0 m before the junction, behind the zebra) and the two signs
        if arm == "n":   r = (x0 + 0.4, y1 + 4.5, cx - 0.3, y1 + 5.0); probe = (cx, y1 + 6); at = lambda d: (x0 - SIGN_CURB, y1 + d)
        elif arm == "s": r = (cx + 0.3, y0 - 5.0, x1 - 0.4, y0 - 4.5); probe = (cx, y0 - 6); at = lambda d: (x1 + SIGN_CURB, y0 - d)
        elif arm == "e": r = (x1 + 4.5, cy + 0.3, x1 + 5.0, y1 - 0.4); probe = (x1 + 6, cy); at = lambda d: (x1 + d, y1 + SIGN_CURB)
        else:            r = (x0 - 5.0, y0 + 0.4, x0 - 4.5, cy - 0.3); probe = (x0 - 6, cy); at = lambda d: (x0 - d, y0 - SIGN_CURB)
        if in_plaza(*probe) or abs(probe[0]) > L or abs(probe[1]) > L: continue   # the arm is plaza cobble or off the map
        paint("mark_white", *r)
        for dist, face, art in ((4.2, "sign_lime", art_ped), (18.0, "sign_yellow", art_signal)):
            p = at(dist)
            if abs(p[0]) <= L and abs(p[1]) <= L and not in_plaza(*p): sign(p[0], p[1], TRAVEL[arm], face, art)

# ---- glb ----
blob, views, accessors, prims_n = bytearray(), [], [], 0
def add(data, target, comp, ctype, n, mn=None, mx=None):
    while len(blob) % 4: blob.append(0)
    views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data), "target": target}); blob.extend(data)
    a = {"bufferView": len(views) - 1, "componentType": comp, "count": n, "type": ctype}
    if mn: a["min"], a["max"] = mn, mx
    accessors.append(a); return len(accessors) - 1
materials = [{"name": k, "pbrMetallicRoughness": {"baseColorFactor": [*c, 1.0], "metallicFactor": m, "roughnessFactor": r}, "doubleSided": True}
             for k, (c, m, r) in MATS.items()]
nodes, gmeshes = [], []
for mi, (name, mesh) in enumerate(meshes.items()):
    if not mesh.pos: continue
    xs, ys, zs = zip(*mesh.pos)
    p = add(b"".join(struct.pack("<3f", *v) for v in mesh.pos), 34962, 5126, "VEC3", len(mesh.pos), [min(xs), min(ys), min(zs)], [max(xs), max(ys), max(zs)])
    n = add(b"".join(struct.pack("<3f", *v) for v in mesh.nor), 34962, 5126, "VEC3", len(mesh.nor))
    i = add(b"".join(struct.pack("<I", v) for v in mesh.idx), 34963, 5125, "SCALAR", len(mesh.idx))
    gmeshes.append({"name": name, "primitives": [{"attributes": {"POSITION": p, "NORMAL": n}, "indices": i, "material": mi}]})
    nodes.append({"name": name, "mesh": len(gmeshes) - 1})
doc = {"asset": {"version": "2.0", "generator": "tools/city3/roadmarks.py"}, "scene": 0, "scenes": [{"nodes": list(range(len(nodes)))}],
       "nodes": nodes, "meshes": gmeshes, "materials": materials, "accessors": accessors, "bufferViews": views, "buffers": [{"byteLength": len(blob)}]}
js = json.dumps(doc, separators=(",", ":")).encode(); js += b" " * (-len(js) % 4)
blob.extend(b"\0" * (-len(blob) % 4))
glb = struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(js) + 8 + len(blob)) + struct.pack("<I4s", len(js), b"JSON") + js + struct.pack("<I4s", len(blob), b"BIN\0") + bytes(blob)
os.makedirs(os.path.dirname(OUT), exist_ok=True); open(OUT, "wb").write(glb)
print(f"junctions {len(JUNCTIONS)} -> {os.path.relpath(OUT)} {len(glb)} bytes; quads per mesh " + ", ".join(f"{k}={len(m.pos)//4}" for k, m in meshes.items() if m.pos))
