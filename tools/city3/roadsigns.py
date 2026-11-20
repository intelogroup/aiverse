"""City 3 lettered road signs -> apps/console/public/assets/world-roadsigns.glb (pure python + Pillow, no Blender).

Textured plates (lettering is drawn with PIL into small embedded PNGs, one per sign design, so no duplicate-PNG trap):
  NO TURN ON RED   on the driver's right 2 m before every approach's junction edge (stop line is at 4.5 m)
  SPEED LIMIT 25   on the driver's right 32 m before the junction edge (mid-block, past the 18 m signal-ahead diamond)
  street-name blades (two per junction, one per street) on their own post at the NE corner, 2.5 m north of the signal post.
Street names are placeholders (plan.json has none). Same junction/arm rules as roadmarks.py.
Plan coords (x east, y north) from plan.json; glTF is y-up with z = -y.
Run:  python3 tools/city3/roadsigns.py   (reads tools/city3/plan.json: run plan.py first)"""
import io, json, math, os, struct
import matplotlib
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "../../apps/console/public/assets/world-roadsigns.glb")
FONT = os.path.join(os.path.dirname(matplotlib.__file__), "mpl-data", "fonts", "ttf", "DejaVuSans-Bold.ttf")
plan = json.load(open(os.path.join(HERE, "plan.json")))
Z, L = plan["walk_z"], plan["land"]
px0, py0, px1, py1 = plan["plaza"]
S = plan["streets"]
CURB = 0.7
NAMES = {("x", -130): "CEDAR ST", ("x", -65): "ELM ST", ("x", 0): "BAZAAR AVE", ("x", 65): "OAK ST", ("x", 130): "PINE ST",
         ("y", -130): "1ST ST", ("y", -65): "2ND ST", ("y", 0): "MARKET AVE", ("y", 65): "3RD ST", ("y", 130): "4TH ST"}

# ---- textures
def font(px): return ImageFont.truetype(FONT, px)
def centred(d, W, y, text, px, fill):
    f = font(px)
    while d.textlength(text, font=f) > W - 36: px -= 2; f = font(px)   # shrink to fit inside the border
    l, t, r, b = d.textbbox((0, 0), text, font=f)
    d.text(((W - (r - l)) / 2 - l, y - t), text, font=f, fill=fill)
    return b - t

def board(W, H, bg, fg, lines, border=8):
    """lines: [(text, px)] stacked and centred; white/black regulatory sign or green blade."""
    im = Image.new("RGB", (W, H), bg); d = ImageDraw.Draw(im)
    d.rounded_rectangle((border // 2, border // 2, W - border // 2 - 1, H - border // 2 - 1), 14, outline=fg, width=border)
    total = sum(px * 1.15 for _, px in lines); y = (H - total) / 2
    for text, px in lines:
        centred(d, W, y, text, px, fg); y += px * 1.15
    return im

TEX = {"sign_noturnred": board(256, 320, "white", "black", [("NO", 64), ("TURN", 64), ("ON", 48), ("RED", 80)]),
       "sign_speed": board(256, 320, "white", "black", [("SPEED", 50), ("LIMIT", 50), ("25", 130)])}
for (axis, c), name in NAMES.items():
    TEX[f"blade_{axis}_{int(c)}"] = board(512, 128, "#0a6b33", "white", [(name, 70)], 6)

# ---- geometry
class Mesh:
    def __init__(self): self.pos, self.nor, self.uv, self.idx = [], [], [], []
    def quad(self, p, n, uv=None):
        b = len(self.pos); self.pos += p; self.nor += [n] * len(p); self.uv += uv or [(0, 0)] * len(p)
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

MATS = ["sign_pole"] + list(TEX)
meshes = {k: Mesh() for k in MATS}

def plate(mat, cx, cy, cz, n, w, h):
    """Textured w x h plate centred (cx,cy,cz) facing glTF unit vector n (horizontal); text reads upright from the front."""
    up = (0.0, 1.0, 0.0)
    right = (up[1] * n[2] - up[2] * n[1], up[2] * n[0] - up[0] * n[2], up[0] * n[1] - up[1] * n[0])   # up x n
    pts = [(cx + right[0] * u * w / 2, cy + v * h / 2, cz + right[2] * u * w / 2) for u, v in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    meshes[mat].quad(pts, n, [(0, 1), (1, 1), (1, 0), (0, 0)])

def in_plaza(x, y): return px0 <= x <= px1 and py0 <= y <= py1
def rect_in_plaza(r): return r[0] >= px0 - .01 and r[1] >= py0 - .01 and r[2] <= px1 + .01 and r[3] <= py1 + .01
JUNCTIONS = [(a["c"] - a["w"] / 2, b["c"] - b["w"] / 2, a["c"] + a["w"] / 2, b["c"] + b["w"] / 2, a["c"], b["c"])
             for a in S for b in S
             if not rect_in_plaza((a["c"] - a["w"] / 2, b["c"] - b["w"] / 2, a["c"] + a["w"] / 2, b["c"] + b["w"] / 2))]
TRAVEL = {"n": (0, -1), "s": (0, 1), "e": (-1, 0), "w": (1, 0)}   # traffic coming FROM that arm moves this way

def regulatory(mat, x, y, travel, w=0.6, h=0.75, bottom=2.1):
    cy = Z + bottom + h / 2
    meshes["sign_pole"].box(x, (Z + cy - h / 2) / 2 + 0.01, -y, 0.07, cy - h / 2 - Z + 0.02, 0.07)   # pole ends at the plate bottom
    n = (-travel[0], 0.0, travel[1])                                                             # faces the oncoming traffic
    plate(mat, x + n[0] * 0.04, cy, -y + n[2] * 0.04, n, w, h)                                    # plate proud of the pole, never behind it

def blades(x, y, xc, yc):
    """Post at plan (x,y) holding the street-name plates; each is double-sided and faces along its own street."""
    top = Z + 3.9
    meshes["sign_pole"].box(x, (Z + top) / 2, -y, 0.07, top - Z, 0.07)
    for axis, c, cy in (("x", xc, Z + 3.55), ("y", yc, Z + 3.2)):   # 'x' = street at x=c runs N-S: drivers see a plate facing +-y
        mat = f"blade_{axis}_{int(c)}"
        for sgn in (1, -1):
            n = (0.0, 0.0, sgn) if axis == "x" else (sgn, 0.0, 0.0)
            plate(mat, x + n[0] * 0.04, cy, -y + n[2] * 0.04, n, 0.9, 0.225)

count = 0
for (x0, y0, x1, y1, xc, yc) in JUNCTIONS:
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for arm in ("n", "s", "e", "w"):
        if arm == "n":   probe = (cx, y1 + 6); at = lambda d: (x0 - CURB, y1 + d)
        elif arm == "s": probe = (cx, y0 - 6); at = lambda d: (x1 + CURB, y0 - d)
        elif arm == "e": probe = (x1 + 6, cy); at = lambda d: (x1 + d, y1 + CURB)
        else:            probe = (x0 - 6, cy); at = lambda d: (x0 - d, y0 - CURB)
        if in_plaza(*probe) or abs(probe[0]) > L or abs(probe[1]) > L: continue
        for dist, mat in ((2.0, "sign_noturnred"), (32.0, "sign_speed")):
            p = at(dist)
            if abs(p[0]) <= L and abs(p[1]) <= L and not in_plaza(*p): regulatory(mat, p[0], p[1], TRAVEL[arm]); count += 1
    blades(x1 + 0.8, y1 + 2.5, xc, yc)   # NE corner, east edge: free of the north-edge signs of arm e and the signal post

# ---- glb (PNG textures embedded)
blob, views, accessors = bytearray(), [], []
def add(data, target=None, comp=None, ctype=None, n=None, mn=None, mx=None):
    while len(blob) % 4: blob.append(0)
    v = {"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)}
    if target: v["target"] = target
    views.append(v); blob.extend(data)
    if comp is None: return len(views) - 1
    a = {"bufferView": len(views) - 1, "componentType": comp, "count": n, "type": ctype}
    if mn: a["min"], a["max"] = mn, mx
    accessors.append(a); return len(accessors) - 1
images, textures, materials = [], [], []
for name in MATS:
    if name == "sign_pole":
        materials.append({"name": name, "pbrMetallicRoughness": {"baseColorFactor": [0.30, 0.31, 0.33, 1], "metallicFactor": 0.6, "roughnessFactor": 0.55}}); continue
    buf = io.BytesIO(); TEX[name].save(buf, "PNG")
    images.append({"bufferView": add(buf.getvalue()), "mimeType": "image/png"})
    textures.append({"source": len(images) - 1})
    materials.append({"name": name, "doubleSided": True, "pbrMetallicRoughness": {"baseColorTexture": {"index": len(textures) - 1}, "metallicFactor": 0.0, "roughnessFactor": 0.5}})
nodes, gmeshes = [], []
for mi, (name, mesh) in enumerate(meshes.items()):
    if not mesh.pos: continue
    xs, ys, zs = zip(*mesh.pos)
    attrs = {"POSITION": add(b"".join(struct.pack("<3f", *v) for v in mesh.pos), 34962, 5126, "VEC3", len(mesh.pos), [min(xs), min(ys), min(zs)], [max(xs), max(ys), max(zs)]),
             "NORMAL": add(b"".join(struct.pack("<3f", *v) for v in mesh.nor), 34962, 5126, "VEC3", len(mesh.nor)),
             "TEXCOORD_0": add(b"".join(struct.pack("<2f", *v) for v in mesh.uv), 34962, 5126, "VEC2", len(mesh.uv))}
    i = add(b"".join(struct.pack("<I", v) for v in mesh.idx), 34963, 5125, "SCALAR", len(mesh.idx))
    gmeshes.append({"name": name, "primitives": [{"attributes": attrs, "indices": i, "material": mi}]})
    nodes.append({"name": name, "mesh": len(gmeshes) - 1})
doc = {"asset": {"version": "2.0", "generator": "tools/city3/roadsigns.py"}, "scene": 0, "scenes": [{"nodes": list(range(len(nodes)))}],
       "nodes": nodes, "meshes": gmeshes, "materials": materials, "textures": textures, "images": images, "accessors": accessors,
       "bufferViews": views, "buffers": [{"byteLength": len(blob)}]}
js = json.dumps(doc, separators=(",", ":")).encode(); js += b" " * (-len(js) % 4)
blob.extend(b"\0" * (-len(blob) % 4))
glb = struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(js) + 8 + len(blob)) + struct.pack("<I4s", len(js), b"JSON") + js + struct.pack("<I4s", len(blob), b"BIN\0") + bytes(blob)
os.makedirs(os.path.dirname(OUT), exist_ok=True); open(OUT, "wb").write(glb)
print(f"junctions {len(JUNCTIONS)} regulatory signs {count} blade posts {len(JUNCTIONS)} -> {os.path.relpath(OUT)} {len(glb)} bytes")
