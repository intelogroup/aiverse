"""Foundry Wharf — industrial-heritage district (east of the Bazaar): brick lofts, sawtooth works, chimney, silos, rail yard, container quay.
Run: blender -b --python foundry.py [-- ij ij ...]  -> out/world-foundry.glb, out/foundry-plan.json.  Local origin = district centre."""
import bpy, json, math, os, random, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from mkit import *
import mdetails as D
import collision as CX
import industrial as IND
COL = CX.Col()                                                  # collision solids (collision.py); exported after the visual GLB
clear_blender()
Z = 0.2; FH = 4.6; LAND = 180.0; SW = 3.0
rng = random.Random(4040); T = {k: v["size"] for k, v in PB.items()}
for k, tag in (("road", "road_m"), ("sidewalk", "pavement"), ("brick_red", None), ("brick_dark", None), ("brick_cream", None), ("slab", "slab_wall"), ("metal_red", None), ("corrugated", None),
               ("rust", None), ("bitumen", None), ("panel", "panel_conc"), ("floor", "floor_conc"), ("diamond", None), ("cont_red", None), ("cont_blue", None), ("cont_green", None), ("cont_ochre", None), ("metal_teal", None)):
    pbr_mat(k, tag or k)
img_mat("glass", "glass_atlas.jpg", "glass_emit.jpg", rough=0.08, metal=0.6, emit=1.0); img_mat("msign", "msigns.jpg", "msigns.jpg", rough=0.4, emit=0.5)
palette_mat("palette"); palette_mat("led", emit=3.0); palette_mat("water", rough=0.03); glass_mat("shopglass")
IND.build_libs(); CXI = IND.Ctx(COL, Z); BAYS = []                     # industrial pass: door / container / prop libraries; BAYS = roller-door bays (prop clusters go in front of free ones)
TL = {"road": 2.1, "sidewalk": 2.1, "brick_red": 2.0, "brick_dark": 2.0, "brick_cream": 2.0, "slab": 2.1, "metal_red": 2.0, "corrugated": 2.7, "rust": 1.0, "bitumen": 6.0, "panel": 2.0, "floor": 2.0, "diamond": 0.5,
      "cont_red": 2.7, "cont_blue": 2.7, "cont_green": 2.7, "cont_ochre": 2.7, "metal_teal": 2.0}
LINES = [(-100, 12), (0, 24), (100, 12)]
edges = [-LAND]
for c, w in LINES: edges += [c - w / 2, c + w / 2]
edges.append(LAND)
BL = [(edges[i], edges[i + 1]) for i in range(0, len(edges), 2)]
KIND = {(0, 0): "hall", (0, 1): "lofts", (0, 2): "lofts", (0, 3): "yard", (1, 0): "lofts", (1, 1): "works", (1, 2): "lofts", (1, 3): "lofts",
        (2, 0): "silos", (2, 1): "rail", (2, 2): "lofts", (2, 3): "silos", (3, 0): "cont", (3, 1): "cont", (3, 2): "cont", (3, 3): "cont"}
PLAN = {"district": "foundry", "land": LAND, "blocks": [], "buildings": [], "streets": [{"c": c, "w": w} for c, w in LINES], "trees": [], "lamps": []}
def lm(x0, y0, x1, y1, z, mat): floor_quad(mat, x0, y0, x1, y1, z, TL[mat])
lm(-LAND, -LAND, LAND, LAND, Z - 0.03, "road")
for i, (x0, x1) in enumerate(BL):
    for j, (y0, y1) in enumerate(BL):
        lm(x0, y0, x1, y1, Z, "sidewalk"); PLAN["blocks"].append({"i": i, "j": j, "kind": KIND[(i, j)], "rect": [x0, y0, x1, y1]})
        for (a, b, c_, d_) in ((x0, y0, x1, y0 + 0.22), (x0, y1 - 0.22, x1, y1), (x0, y0, x0 + 0.22, y1), (x1 - 0.22, y0, x1, y1)): pquad("palette", (a, b, Z + 0.006), (c_, b, Z + 0.006), (c_, d_, Z + 0.006), (a, d_, Z + 0.006), "concrete_dk", (0, 0, 1))
for c, w in LINES:                                           # centre lines + edge lines
    for ax in "xy":
        for off, wd, col in ((-0.1, 0.1, "paint_yellow"), (0.1, 0.1, "paint_yellow")) if w >= 24 else ():
            (D.stripe(c + off - wd / 2, -LAND, c + off + wd / 2, LAND, Z + 0.012, col) if ax == "x" else D.stripe(-LAND, c + off - wd / 2, LAND, c + off + wd / 2, Z + 0.012, col))
for side, (a, b, o) in {"S": ((-LAND, -LAND), (LAND, -LAND), (0, -1)), "E": ((LAND, -LAND), (LAND, LAND), (1, 0)), "N": ((LAND, LAND), (-LAND, LAND), (0, 1)), "W": ((-LAND, LAND), (-LAND, -LAND), (-1, 0))}.items():
    pquad("palette", (a[0], a[1], -3), (b[0], b[1], -3), (b[0], b[1], Z), (a[0], a[1], Z), "concrete_dk", (o[0], o[1], 0))
# ------------------------------------------------------------------ pieces
def brick_bay_wall(fr, L, nfl, r, mat, z0=0.0, ground="doors", pitch=4.2):
    """Heavy brick wall with tall steel-framed windows; ground floor = roller doors / glazed units."""
    tl = TL[mat]; nb = max(1, round(L / pitch)); bw = L / nb
    for f in range(nfl):
        z = z0 + f * FH; g = (f == 0)
        sill, head = (0.0, 3.4) if (g and ground) else (1.0, 3.7)
        for b in range(nb):
            u0, u1 = b * bw, (b + 1) * bw; c = (u0 + u1) / 2; w = min(2.5, bw - 1.2); a, d = c - w / 2, c + w / 2
            wall(fr, u0, a, z, z + FH, mat, tl); wall(fr, d, u1, z, z + FH, mat, tl)
            if sill > 0: wall(fr, a, d, z, z + sill, mat, tl)
            wall(fr, a, d, z + head, z + FH, mat, tl)
            door = g and ground == "doors" and r.random() < 0.45
            reveal(fr, a, d, z + sill, z + head, 0.0, -0.35, "slab", TL["slab"])
            if door:
                IND.door(fr, a, d, 0.0); BAYS.append((fr.a, fr.r, fr.n, (a + d) / 2))                                   # roller door (instanced, industrial.py)
                continue
            gu = glaze_uv(r.randrange(8), r.randrange(3)); P = fr.p
            tquad("glass", P(a, -0.35, z + sill), P(d, -0.35, z + sill), P(d, -0.35, z + head), P(a, -0.35, z + head), [(gu[0], gu[1]), (gu[2], gu[1]), (gu[2], gu[3]), (gu[0], gu[3])], fr.o(0, 1))
            for k in (1, 2): fbox(fr, a + w * k / 3 - 0.025, a + w * k / 3 + 0.025, -0.36, -0.3, z + sill, z + head, "black")        # steel mullions
            for k in (1, 2, 3, 4): fbox(fr, a, d, -0.36, -0.3, z + sill + (head - sill) * k / 5 - 0.02, z + sill + (head - sill) * k / 5 + 0.02, "black")
            fbox(fr, a - 0.1, d + 0.1, 0, 0.16, z + head, z + head + 0.2, "concrete"); fbox(fr, a - 0.1, d + 0.1, 0, 0.2, z + sill - 0.1, z + sill, "concrete")
        fbox(fr, 0, L, 0, 0.1, z + FH - 0.15, z + FH, "concrete_dk")
def downpipe(fr, u, h): x, y = fr.xy(u, 0.12); cyl(x, y, fr.z0, fr.z0 + h, 0.07, 6, "steel", top=False)
def fire_escape(fr, u0, nfl):
    CXI.obst.append(IND._aabb([fr.p(u0 - 0.3, -0.1, 0), fr.p(u0 + 3.3, 1.6, 0)]))
    for f in range(1, nfl):
        z = f * FH; fbox(fr, u0, u0 + 3.0, 0.0, 1.2, z - 0.07, z, "steel"); fbox(fr, u0, u0 + 3.0, 1.15, 1.2, z, z + 1.0, "steel", top=False)
        fbox(fr, u0, u0 + 0.05, 0.0, 1.2, z, z + 1.0, "steel", top=False)
        if f > 1:
            P = fr.p; beam(P(u0 + 2.6, 0.55, z - FH + 0.0), P(u0 + 0.4, 0.55, z), 0.12, 0.08, "steel")
    for s in (0.05, 2.95): x, y = fr.xy(u0 + s, 1.15); cyl(x, y, fr.z0, fr.z0 + (nfl - 1) * FH, 0.04, 5, "steel", top=False)
def chimney(x, y, z, h):
    CXI.obst.append((x - 3.5, y - 3.5, x + 3.5, y + 3.5))
    COL.cyl("props", x, y, z - 0.3, z + h, 2.7, 14); seg = 14
    for k in range(6):
        r0 = 2.6 - k * 0.26; r1 = 2.6 - (k + 1) * 0.26; cyl(x, y, z + h * k / 6, z + h * (k + 1) / 6, r0, seg, "brick" if False else "brick_dk" if False else "rust", r1=r1, top=False)
    cyl(x, y, z + h, z + h + 0.5, 1.15, seg, "steel"); cyl(x, y, z + h * 0.95, z + h * 0.97, 1.5, seg, "concrete_dk")
    cyl(x, y, z + h + 0.5, z + h + 2.0, 0.08, 6, "red", b="led")
def sawtooth(x0, y0, x1, y1, z, r, period=6.0):
    """North-light roof: rows of teeth running along y; glazed vertical face toward +x? (here faces -y)."""
    n = max(1, int((x1 - x0) // period)); pw = (x1 - x0) / n; h = 2.6
    for k in range(n):
        a = x0 + k * pw; b = a + pw
        tquad("corrugated", (a, y0, z + h), (b, y0, z), (b, y1, z), (a, y1, z + h), [(a / 2.7, y0 / 2.7), (b / 2.7, y0 / 2.7), (b / 2.7, y1 / 2.7), (a / 2.7, y1 / 2.7)], (0.4, 0, 1))
        gu = glaze_uv(r.randrange(8), 1)
        for q in range(max(1, int((y1 - y0) // 3.0))):
            ya = y0 + q * (y1 - y0) / max(1, int((y1 - y0) // 3.0)); yb = ya + (y1 - y0) / max(1, int((y1 - y0) // 3.0))
            tquad("glass", (a, ya, z), (a, yb, z), (a, yb, z + h), (a, ya, z + h), [(gu[0], gu[1]), (gu[2], gu[1]), (gu[2], gu[3]), (gu[0], gu[3])], (-1, 0, 0))
        for (yy, o) in ((y0, -1), (y1, 1)): mb("brick_dark").tri((a, yy, z), (b, yy, z), (a, yy, z + h), (a / 2, 0), (b / 2, 0), (a / 2, h / 2), (0, o, 0))
def gable(rect, z, r, mat="metal_red", rise=3.2, along="x"):
    x0, y0, x1, y1 = rect; tl = TL[mat]
    if along == "x":
        ym = (y0 + y1) / 2
        for (ya, yb, nrm) in ((y0, ym, (0, -0.5, 1)), (y1, ym, (0, 0.5, 1))): tquad(mat, (x0 - 0.3, ya + (-0.4 if ya < ym else 0.4), z), (x1 + 0.3, ya + (-0.4 if ya < ym else 0.4), z), (x1 + 0.3, yb, z + rise), (x0 - 0.3, yb, z + rise), [(x0 / tl, ya / tl), (x1 / tl, ya / tl), (x1 / tl, yb / tl), (x0 / tl, yb / tl)], nrm)
        for xx, o in ((x0, -1), (x1, 1)): mb("brick_dark").tri((xx, y0, z), (xx, y1, z), (xx, ym, z + rise), (0, 0), (1, 0), (0.5, 0.6), (o, 0, 0)) if False else None
    else:
        xm = (x0 + x1) / 2
        for (xa, nrm) in ((x0, (-0.5, 0, 1)), (x1, (0.5, 0, 1))): tquad(mat, (xa + (-0.4 if xa < xm else 0.4), y0 - 0.3, z), (xm, y0 - 0.3, z + rise), (xm, y1 + 0.3, z + rise), (xa + (-0.4 if xa < xm else 0.4), y1 + 0.3, z), [(0, 0), (1, 0), (1, 1), (0, 1)], nrm)
def loft(rect, r, nfl, mat, i, j, tag, sign=True):
    x0, y0, x1, y1 = rect; poly = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    for side in ("S", "E", "N", "W"):
        fr, L = frame_for(rect, side, Z); brick_bay_wall(fr, L, nfl, r, mat, 0.0, "doors" if r.random() < 0.6 else "glaze")
        for k in range(int(L // 14)): downpipe(fr, 3 + k * 14.0, nfl * FH)
        if sign and r.random() < 0.7: P = fr.p; a, b, c, d = MS[str(8 + r.randrange(8))]; uu = max(2.0, L / 2 - 4); tquad("msign", P(uu, 0.05, nfl * FH - 3.4), P(uu + 5.2, 0.05, nfl * FH - 3.4), P(uu + 5.2, 0.05, nfl * FH - 2.15), P(uu, 0.05, nfl * FH - 2.15), [(a, b), (c, b), (c, d), (a, d)], fr.o(0, 1))
    top = Z + nfl * FH; poly_cap("bitumen", poly, top, 6.0)
    for fr, L in edge_frames(poly, top): wbox(fr, 0, L, -0.35, 0.0, 0.0, 0.9, mat, TL[mat]); fbox(fr, 0, L, -0.4, 0.06, 0.9, 0.98, "concrete")
    if r.random() < 0.5: sawtooth(x0 + 2, y0 + 2, x1 - 2, y1 - 2, top, r)
    else:
        for _ in range(5):
            ex = r.uniform(x0 + 3, x1 - 3); ey = r.uniform(y0 + 3, y1 - 3); w = r.uniform(2, 4); pbox(ex - w / 2, ey - 1, ex + w / 2, ey + 1, top, top + r.uniform(1.2, 2.2), r.choice(["steel", "concrete", "alu_dk"]))
        if r.random() < 0.5: cx, cy = (x0 + x1) / 2, (y0 + y1) / 2; cyl(cx, cy, top, top + 4.0, 2.0, 14, "steel", r1=1.9); cyl(cx, cy, top + 4.0, top + 6.0, 2.0, 14, "rust", r1=0.4); [pbox(cx + dx - .1, cy + dy - .1, cx + dx + .1, cy + dy + .1, top, top + 4.0, "rust") for dx, dy in ((-1.5, -1.5), (1.5, 1.5), (1.5, -1.5), (-1.5, 1.5))]
    fr, L = frame_for(rect, "S", Z)
    if nfl >= 3 and r.random() < 0.8: fire_escape(Frame(*(frame_for(rect, "E", Z)[0].a, frame_for(rect, "E", Z)[0].r, frame_for(rect, "E", Z)[0].n, Z)), (y1 - y0) / 2 - 1.5, nfl)
    PLAN["buildings"].append({"id": f"{tag}{i}{j}", "poly": [[round(a, 2), round(b, 2)] for a, b in poly], "floors": nfl, "kind": "loft", "style": mat})
    return top
def container(x, y, z, r, along_x=True, ci=None):
    col = ci or r.choice(["cont_red", "cont_blue", "cont_green", "cont_ochre"]); L, W, H = (12.2, 2.44, 2.6) if along_x else (2.44, 12.2, 2.6); tl = TL[col]
    IND.container(col, x, y, z, along_x)                                                              # container v2: instanced mesh with ribs / castings / lock rods
def stack(x, y, z, r, along_x, n):
    COL.box("props", x - (6.1 if along_x else 1.22), y - (1.22 if along_x else 6.1), z - 0.1, x + (6.1 if along_x else 1.22), y + (1.22 if along_x else 6.1), z + n * 2.6)
    CXI.obst.append((x - (6.3 if along_x else 1.4), y - (1.4 if along_x else 6.3), x + (6.3 if along_x else 1.4), y + (1.4 if along_x else 6.3)))
    for k in range(n): container(x, y, z + k * 2.6, r, along_x)
def gantry_crane(x, y, z, reach=-1):
    """Portal crane at the quay edge; boom reaches over the water (reach = +-1 along x)."""
    CXI.obst.append((x - 7.5, y - 8.2, x + 7.5, y + 8.2))
    for sx in (-6, 6):
        for sy in (-7, 7): COL.box("props", x + sx - 0.6, y + sy - 0.6, z - 0.1, x + sx + 0.6, y + sy + 0.6, z + 24); beam((x + sx, y + sy, z), (x + sx * 0.8, y + sy * 0.9, z + 24), 0.8, 0.8, "orange")
    for sy in (-7, 7): pbox(x - 7.5, y + sy - 0.5, x + 7.5, y + sy + 0.5, z + 23.6, z + 24.6, "orange"); pbox(x - 7.5, y + sy - 0.6, x + 7.5, y + sy + 0.6, z, z + 0.5, "steel")
    pbox(x - 5, y - 7.5, x + 5, y + 7.5, z + 24.2, z + 25.4, "orange")
    bx0 = x - 6 * 0 + reach * 4
    pbox(min(x, x + reach * 38), y - 1.4, max(x, x + reach * 38), y + 1.4, z + 26.0, z + 27.2, "orange")
    for k in range(10): beam((x + reach * (3 + k * 3.5), y, z + 25.4), (x + reach * (5 + k * 3.5), y, z + 26.2), 0.15, 0.15, "alu_dk")
    pbox(x + reach * 20 - 2.0, y - 1.6, x + reach * 20 + 2.0, y + 1.6, z + 24.2, z + 26.0, "safety"); cyl(x + reach * 20, y, z + 10, z + 24.2, 0.04, 5, "black")
    pbox(x + reach * 20 - 1.5, y - 1.2, x + reach * 20 + 1.5, y + 1.2, z + 9.2, z + 10.0, "steel")
def silo_group(cx, cy, z, r):
    CXI.obst.append((cx - 16, cy - 10, cx + 16, cy + 10))
    for a in range(3):
        for b in range(2):
            x, y = cx - 10 + a * 10, cy - 5 + b * 10; h = 24 + r.choice([0, 3, 6]); COL.cyl("props", x, y, z - 0.1, z + h + 2.2, 4.5, 20)
            cyl(x, y, z, z + h, 4.4, 20, "concrete", top=False); cyl(x, y, z + h, z + h + 2.2, 4.4, 20, "concrete_dk", r1=0.8)
            for q in range(4): cyl(x, y, z + (q + 1) * h / 5, z + (q + 1) * h / 5 + 0.15, 4.5, 20, "concrete_dk", top=False)
            cyl(x + 4.9, y, z, z + h, 0.05, 5, "steel", top=False)
    pbox(cx - 16, cy - 0.8, cx + 16, cy + 0.8, z + 26, z + 26.5, "steel"); [beam((cx - 16 + k * 4, cy, z + 26.5), (cx - 14 + k * 4, cy, z + 29.5), 0.1, 0.1, "steel") for k in range(8)]
    pbox(cx - 16, cy - 0.5, cx + 16, cy + 0.5, z + 29.5, z + 30.0, "steel")
def pipe_rack(x0, x1, y, z, h=6.0, n=3):
    CXI.obst.append((x0, y - 1.6, x1, y + 1.6))
    for xx in range(int(x0), int(x1) + 1, 8): pbox(xx - 0.2, y - 1.2, xx + 0.2, y - 0.8, z, z + h, "steel"); pbox(xx - 0.2, y + 0.8, xx + 0.2, y + 1.2, z, z + h, "steel"); pbox(xx - 0.2, y - 1.2, xx + 0.2, y + 1.2, z + h - 0.2, z + h, "steel")
    for k in range(n): fr = Frame((x0, y + (k - 1) * 0.5), (1, 0), (0, 1), z); hcyl(fr, 0, x1 - x0, 0, h + 0.3 + (k % 2) * 0.4, 0.22, ["rust", "orange", "alu"][k % 3], seg=10)
def rail(y, x0, x1, z, r):
    CXI.obst.append((x0, y - 1.6, x1, y + 1.6))
    for k in range(int((x1 - x0) / 0.7)): pbox(x0 + k * 0.7, y - 1.3, x0 + k * 0.7 + 0.25, y + 1.3, z, z + 0.13, "trunk")
    for s in (-0.72, 0.72): pbox(x0, y + s - 0.04, x1, y + s + 0.04, z + 0.13, z + 0.26, "steel")
def boxcar(x, y, z, r):
    CXI.obst.append((x - 7.5, y - 1.8, x + 7.5, y + 1.8))
    col = r.choice(["container_red", "rust", "container_green", "container_grey"]); COL.box("props", x - 7.2, y - 1.5, z, x + 7.2, y + 1.5, z + 4.0); pbox(x - 7, y - 1.4, x + 7, y + 1.4, z + 0.8, z + 4.0, col); pbox(x - 7.2, y - 1.5, x + 7.2, y + 1.5, z + 0.5, z + 0.8, "black")
    for sx in (-5, -4.2, 4.2, 5): cyl(x + sx, y - 1.45, z + 0.5, z + 0.9, 0.5, 10, "steel")
    pbox(x - 1.0, y - 1.45, x + 1.0, y - 1.38, z + 0.9, z + 3.8, "black")
def dress(rect, r, density=1.0):
    x0, y0, x1, y1 = rect
    for side in ("S", "E", "N", "W"):
        fr, L = frame_for((x0 - SW, y0 - SW, x1 + SW, y1 + SW), side, Z); out = fr.o(0, 1)
        for k in range(int(L // 26)): D.lamp(*fr.xy(10 + k * 26.0, 0.8), Z, (out[0], out[1])); PLAN["lamps"].append(list(fr.xy(10 + k * 26.0, 0.8)))
        for k in range(int(L // 18)):
            u = 6 + k * 18.0 + r.uniform(-2, 2); q = r.random(); x, y = fr.xy(u, 1.6)
            if q < 0.3: cyl(x, y, Z, Z + 0.95, 0.3, 10, "rust"); cyl(x, y, Z + 0.95, Z + 1.0, 0.31, 10, "black")
            elif q < 0.5: D.bin_(x, y, Z)
            elif q < 0.7: D.bench(x, y, Z, abs(fr.r[0]) > 0.5)
            elif q < 0.85: D.shrub(x, y, Z, r, 0.8)
            else: D.tree(x, y, Z, r, r.uniform(4, 6)); PLAN["trees"].append([x, y])
        for k in range(int(L // 9)): D.bollard(*fr.xy(2 + k * 9.0, 0.45), Z)
def block_rect(i, j): x0, x1 = BL[i]; y0, y1 = BL[j]; return (x0 + SW, y0 + SW, x1 - SW, y1 - SW)
# ------------------------------------------------------------------ blocks
def lofts(i, j, r):
    x0, y0, x1, y1 = block_rect(i, j); mats = ["brick_red", "brick_dark", "brick_cream"]
    with grp(f"b{i}{j}"):
        W = x1 - x0; D_ = y1 - y0; hz = W >= D_
        for (ya, yb) in ((y0 + 2, y0 + 2 + (D_ - 8) / 2), (y0 + 6 + (D_ - 8) / 2, y1 - 2)):
            xs = x0 + 2
            while xs < x1 - 14:
                w = r.choice([22, 28, 34]); w = min(w, x1 - 2 - xs)
                if w < 14: break
                loft((xs, ya, xs + w, yb), r, r.choice([3, 4, 4, 5]), r.choice(mats), i, int(xs) + j * 1000, "lf"); xs += w + 3
        for k in range(3): pipe_rack(x0 + 4, x1 - 4, y0 + (D_ / 2) + (k - 1) * 0.0 + 0.0, Z, 6.0) if (False) else None
        chimney_pos = (x0 + W * 0.5, y0 + D_ * 0.5); D.tree(*chimney_pos, Z, r, 6) if False else None
        dress((x0, y0, x1, y1), r)
def works(i, j, r):
    x0, y0, x1, y1 = block_rect(i, j)
    with grp(f"b{i}{j}"):
        rect = (x0 + 4, y0 + 4, x1 - 4, y0 + 40); loft(rect, r, 3, "brick_dark", i, j, "wk", sign=True)
        rect2 = (x0 + 4, y0 + 46, x1 - 4, y1 - 4)
        for side in ("S", "E", "N", "W"):
            fr, L = frame_for(rect2, side, Z); brick_bay_wall(fr, L, 2, r, "brick_red", 0.0, "doors", 5.0)
        top = Z + 2 * FH; poly2 = [(rect2[0], rect2[1]), (rect2[2], rect2[1]), (rect2[2], rect2[3]), (rect2[0], rect2[3])]
        poly_cap("bitumen", poly2, top, 6.0); sawtooth(rect2[0] + 2, rect2[1] + 2, rect2[2] - 2, rect2[3] - 2, top, r, 7.0)
        for fr, L in edge_frames(poly2, top): wbox(fr, 0, L, -0.35, 0.0, 0.0, 0.9, "brick_red", TL["brick_red"])
        chimney(x1 - 14, y0 + 20, Z, 44.0); chimney(x1 - 22, y0 + 20, Z, 34.0)
        PLAN["buildings"].append({"id": f"wk2{i}{j}", "poly": [[round(a, 2), round(b, 2)] for a, b in poly2], "floors": 2, "kind": "works", "style": "sawtooth"})
        dress((x0, y0, x1, y1), r)
def silos(i, j, r):
    x0, y0, x1, y1 = block_rect(i, j); cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    with grp(f"b{i}{j}"):
        lm(x0, y0, x1, y1, Z + 0.02, "floor"); silo_group(cx - 10, cy + 12, Z, r)
        loft((x0 + 4, y0 + 4, x1 - 4, y0 + 24), r, 2, "brick_dark", i, j, "sl", sign=False)
        for k in range(6): D.shrub(r.uniform(x0 + 3, x1 - 3), r.uniform(cy - 6, cy + 2), Z, r, 1.0)
        for k in range(3): boxcar(x0 + 20 + k * 16, cy - 2, Z, r) if False else None
        dress((x0, y0, x1, y1), r)
def rail_block(i, j, r):
    x0, y0, x1, y1 = block_rect(i, j); cy = (y0 + y1) / 2
    with grp(f"b{i}{j}"):
        lm(x0, y0, x1, y1, Z + 0.02, "bitumen")
        for k in range(4): rail(cy - 9 + k * 6, x0, x1, Z + 0.02, r)
        for k in range(7): boxcar(x0 + 14 + (k % 4) * 17, cy - 9 + (k // 4 * 2 + (k % 2)) * 6 * 1 if k < 4 else cy + 3, Z + 0.02, r)
        loft((x0 + 4, y1 - 24, x1 - 4, y1 - 4), r, 2, "brick_red", i, j, "rl", sign=True)
        pipe_rack(x0 + 2, x1 - 2, y0 + 5, Z, 6.5)
        dress((x0, y0, x1, y1), r)
def cont(i, j, r):
    x0, y0, x1, y1 = block_rect(i, j); cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    with grp(f"b{i}{j}"):
        lm(x0, y0, x1, y1, Z + 0.02, "bitumen")
        for a in range(3):
            for b in range(5):
                if r.random() < 0.92: stack(x0 + 12 + a * 15, y0 + 9 + b * 5.2 * (1 if True else 0), Z + 0.02, r, True, r.choice([1, 2, 3, 3, 4]))
        for k in range(len(range(4))): pass
        if j in (1, 2): gantry_crane(x1 - 8, cy, Z + 0.02, 1)
        for k in range(8): pbox(x1 - 1.0, y0 + 4 + k * (y1 - y0 - 8) / 7, x1 - 0.6, y0 + 4.4 + k * (y1 - y0 - 8) / 7, Z + 0.02, Z + 0.7, "paint_yellow")
        dress((x0, y0, x1, y1), r)
def hall(i, j, r):
    x0, y0, x1, y1 = block_rect(i, j); cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    with grp(f"b{i}{j}"):
        lm(x0, y0, x1, y1, Z + 0.02, "floor")
        rect = (cx - 30, cy - 12, cx + 30, cy + 12)
        for side in ("S", "N"): fr, L = frame_for(rect, side, Z); [fbox(fr, k * 5 - 0.1, k * 5 + 0.1, 0, 0.3, 0, 6.0, "steel") for k in range(int(L / 5) + 1)]; wall(fr, 0, L, 5.0, 6.0, "metal_teal", TL["metal_teal"], t=0.3)
        gable(rect, Z + 6.0, r, "metal_red", 4.0, "x"); pbox(rect[0], rect[1], rect[2], rect[3], Z + 5.9, Z + 6.0, "steel")
        for k in range(9): x = rect[0] + 4 + k * 6; pbox(x - 1.2, cy + (k % 2) * 4 - 7, x + 1.2, cy + (k % 2) * 4 - 6, Z + 0.02, Z + 1.0, "wood"); [D.bench(x, cy + s * 8, Z + 0.02, True) for s in (-1, 1)] if False else None
        for k in range(5): D.string = None
        for k in range(14): x = x0 + 8 + k * (x1 - x0 - 16) / 13; cyl(x, y0 + 4, Z, Z + 5.5, 0.06, 6, "alu_dk", top=False); cyl(x, y1 - 4, Z, Z + 5.5, 0.06, 6, "alu_dk", top=False)
        for k in range(4): D.kiosk(x0 + 14 + k * 24, y0 + 8, Z + 0.02, r, (0, -1))
        dress((x0, y0, x1, y1), r)
def yard(i, j, r):
    x0, y0, x1, y1 = block_rect(i, j)
    with grp(f"b{i}{j}"):
        tquad("palette", (x0, y0, Z + 0.03), (x1, y0, Z + 0.03), (x1, y1, Z + 0.03), (x0, y1, Z + 0.03), [pal_uv("moss")] * 4, (0, 0, 1))
        for _ in range(26): D.tree(r.uniform(x0 + 4, x1 - 4), r.uniform(y0 + 4, y1 - 4), Z + 0.03, r, r.uniform(5, 8));
        for k in range(10): D.shrub(r.uniform(x0 + 4, x1 - 4), r.uniform(y0 + 4, y1 - 4), Z + 0.03, r, 1.1)
        pbox((x0 + x1) / 2 - 2, y0 + 2, (x0 + x1) / 2 + 2, y1 - 2, Z + 0.04, Z + 0.05, "sand")
        dress((x0, y0, x1, y1), r)
BUILD = {"lofts": lofts, "works": works, "silos": silos, "rail": rail_block, "cont": cont, "hall": hall, "yard": yard}
only = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
for (i, j), k in KIND.items():
    if only and f"{i}{j}" not in only: continue
    BUILD[k](i, j, random.Random(200 + i * 10 + j))
# ------------------------------------------------------------------ industrial pass: loose props (own Random; clusters never on roads, block entrances, rails or footprints)
prng = random.Random(9090); rects = [(min(p[0] for p in b["poly"]), min(p[1] for p in b["poly"]), max(p[0] for p in b["poly"]), max(p[1] for p in b["poly"])) for b in PLAN["buildings"]]
cells = [(x0, y0, x1, y1) for (x0, x1) in BL for (y0, y1) in BL]
NPROP = {"bays": IND.place_bay_props(CXI, BAYS, rects, cells, prng)}
CXI.obst += [(a - 1.0, b - 1.0, c_ + 1.0, d_ + 1.0) for (a, b, c_, d_) in rects]
for (i, j), k in KIND.items():
    if only and f"{i}{j}" not in only: continue
    x0, y0, x1, y1 = block_rect(i, j); cy = (y0 + y1) / 2
    if k == "cont":                                                                   # quay edge (headings run along the quay, clusters face the water) + the open yard behind the stacks
        NPROP[f"quay{i}{j}"] = IND.scatter(CXI, (x1 - 6.3, y0 + 3, x1 - 5.7, y1 - 3), 4, ["pallets", "drums", "crates", "forklift"], [3, 3, 2, 1.2], prng, margin=0.0, clear=2.3, rots=[math.pi / 2])
        NPROP[f"yard{i}{j}"] = IND.scatter(CXI, (x0, y0, x1 - 6.5, y1), 4, ["pallets", "drums", "crates", "forklift"], [3, 3, 2, 1.2], prng, margin=2.5)
    elif k == "rail":                                                                 # sidings
        NPROP[f"rail{i}{j}"] = IND.scatter(CXI, (x0, y0, x1, y1), 7, ["pallets", "drums", "crates", "forklift"], [3, 3, 3, 0.8], prng, margin=2.5, clear=2.2)
if os.environ.get("FOUNDRY_DUMP"): json.dump({"place": IND.PLACE, "doors": IND.DOORS}, open(os.environ["FOUNDRY_DUMP"], "w"))      # debug: where everything went
INSTN = IND.bake(); print("INDUSTRIAL", INSTN, NPROP, {k: v for k, v in IND.TRIS.items()}, IND.STATS)
realise({"road": "Road", "sidewalk": "Sidewalk", "glass": "Glass", "shopglass": "ShopGlass", "palette": "Props", "led": "Led", "msign": "Signs"})
agg = {}
for k, v in MBS.items(): agg[k.rpartition("::")[2]] = agg.get(k.rpartition("::")[2], 0) + len(v.f)
print("TRIS", sum(agg.values()), dict(sorted(agg.items(), key=lambda kv: -kv[1])[:8]))
os.makedirs(f"{HERE}/out", exist_ok=True); bpy.ops.wm.save_as_mainfile(filepath=f"{HERE}/out/foundry.blend")
export_glb(f"{HERE}/out/world-foundry.glb", gpu_instances=True); json.dump(PLAN, open(f"{HERE}/out/foundry-plan.json", "w"))
# ---- collision: ground, quay (open where the Bazaar bridge lands: west edge), plan footprints (height = floors x FH), trunks, lamps; chimneys / container stacks / silos / cranes / box cars come from the builders above
COL.ground_rect("ground", -LAND, -LAND, LAND, LAND, Z); CX.quay(COL, LAND, Z, "W")
for b in PLAN["buildings"]: COL.prism("buildings", b["poly"], Z - 0.3, Z + b["floors"] * FH)
for (x, y) in PLAN["trees"]: COL.cyl("props", x, y, Z - 0.1, Z + 3.0, 0.25, 6)
for (x, y) in PLAN["lamps"]: COL.cyl("props", x, y, Z - 0.1, Z + 4.0, 0.15, 6)
CX.finish(COL, f"{HERE}/out/world-foundry-collision.glb")
