"""Street furniture and planting shared by the modern districts. All positions are district-local metres (x east, y north),
z = absolute height of the surface the object stands on. Palette colours come from mtex.PALM; textured parts use mkit materials."""
import math, random
from mkit import *

def tree(x, y, z, rnd, h=None, kind="round"):
    """Street/park tree: hexagonal trunk + 4-6 jittered ico-ish blobs (about 300 tris)."""
    h = h or rnd.uniform(4.5, 7.0); cyl(x, y, z, z + h * 0.55, 0.16, 7, "trunk", top=False, r1=0.1)
    for k in range(3):                                                       # two forking branches
        a = rnd.uniform(0, 6.28); bx = x + math.cos(a) * 0.9; by = y + math.sin(a) * 0.9
        pquad("palette", (x - 0.05, y, z + h * 0.45), (x + 0.05, y, z + h * 0.45), (bx + 0.04, by, z + h * 0.78), (bx - 0.04, by, z + h * 0.78), "trunk", (0, -1, 0))
    cols = ["leaf", "leaf_dk", "leaf_lt"] if kind == "round" else ["moss", "leaf_dk", "leaf"]
    R = h * (0.42 if kind == "round" else 0.3)
    for k in range(rnd.choice([3, 4])):
        a = rnd.uniform(0, 6.28); d = rnd.uniform(0, R * 0.7); cx = x + math.cos(a) * d; cy = y + math.sin(a) * d; cz = z + h * 0.72 + rnd.uniform(-0.4, 0.9) * R * 0.5
        blob(cx, cy, cz, R * rnd.uniform(0.55, 0.85), rnd.choice(cols), rnd)
def blob(cx, cy, cz, r, color, rnd, seg=8, ring=5):
    pts = {}
    def P(i, j):
        if j == 0: return (cx, cy, cz - r * 0.85)
        if j == ring: return (cx, cy, cz + r)
        ph = math.pi * j / ring; th = 2 * math.pi * (i % seg) / seg; rr = r * (0.93 + 0.14 * ((i * 7 + j * 13) % 5) / 5)
        return (cx + rr * math.sin(ph) * math.cos(th), cy + rr * math.sin(ph) * math.sin(th), cz + (rr * math.cos(ph)) * (1.0 if j < ring / 2 else 1.0))
    for j in range(ring):
        for i in range(seg):
            a, b, c, d = P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1); ctr = ((a[0] + c[0]) / 2 - cx, (a[1] + c[1]) / 2 - cy, (a[2] + c[2]) / 2 - cz)
            if j == 0: ptri("palette", a, c, d, color, ctr)
            elif j == ring - 1: ptri("palette", a, b, c, color, ctr)
            else: pquad("palette", a, b, c, d, color, ctr)
def shrub(x, y, z, rnd, r=0.7, color=None):
    for k in range(2): blob(x + rnd.uniform(-r, r) * 0.6, y + rnd.uniform(-r, r) * 0.6, z + r * 0.55, r * rnd.uniform(0.55, 0.9), color or rnd.choice(["leaf", "leaf_dk", "moss"]), rnd, 6, 4)
def tree_grate(x, y, z): pbox(x - 0.6, y - 0.6, x + 0.6, y + 0.6, z, z + 0.015, "steel"); pbox(x - 0.45, y - 0.45, x + 0.45, y + 0.45, z + 0.015, z + 0.02, "soil")

def lamp(x, y, z, face, rnd=None):
    """Modern 9 m pole, 2.4 m arm toward `face` (unit vector toward the street), LED head underneath."""
    fx, fy = face; cyl(x, y, z, z + 9.0, 0.07, 8, "alu_dk", top=False, r1=0.055); cyl(x, y, z, z + 0.5, 0.13, 8, "alu_dk", top=False, r1=0.09)
    ex, ey = x + fx * 2.4, y + fy * 2.4; ang = math.atan2(fy, fx); px, py = -fy, fx
    for s in (-1, 1): pquad("palette", (x + px * 0.03 * s, y + py * 0.03 * s, z + 8.9), (ex + px * 0.03 * s, ey + py * 0.03 * s, z + 9.0), (ex + px * 0.03 * s, ey + py * 0.03 * s, z + 9.1), (x + px * 0.03 * s, y + py * 0.03 * s, z + 9.0), "alu_dk", (px * s, py * s, 0))
    hx0 = x + fx * 1.4; hy0 = y + fy * 1.4; hx1 = ex + fx * 0.25; hy1 = ey + fy * 0.25
    pquad("led", (hx0 + px * 0.2, hy0 + py * 0.2, z + 8.9), (hx1 + px * 0.2, hy1 + py * 0.2, z + 8.9), (hx1 - px * 0.2, hy1 - py * 0.2, z + 8.9), (hx0 - px * 0.2, hy0 - py * 0.2, z + 8.9), "cool_led", (0, 0, -1))
    pquad("palette", (hx0 + px * 0.2, hy0 + py * 0.2, z + 9.0), (hx0 - px * 0.2, hy0 - py * 0.2, z + 9.0), (hx1 - px * 0.2, hy1 - py * 0.2, z + 9.0), (hx1 + px * 0.2, hy1 + py * 0.2, z + 9.0), "alu_dk", (0, 0, 1))
def bench(x, y, z, along_x, rnd=None):
    """Concrete + timber bench (backless), 2.2 m long."""
    L, W = (2.2, 0.5) if along_x else (0.5, 2.2)
    pbox(x - L / 2, y - W / 2, x + L / 2, y + W / 2, z, z + 0.05, "concrete_dk")
    if along_x:
        for k in (-0.8, 0.8): pbox(x + k - 0.06, y - W / 2 + 0.04, x + k + 0.06, y + W / 2 - 0.04, z + 0.05, z + 0.4, "concrete")
        for k in range(4): pbox(x - L / 2, y - W / 2 + 0.02 + k * 0.12, x + L / 2, y - W / 2 + 0.12 + k * 0.12, z + 0.4, z + 0.45, "wood")
    else:
        for k in (-0.8, 0.8): pbox(x - W / 2 + 0.04, y + k - 0.06, x + W / 2 - 0.04, y + k + 0.06, z + 0.05, z + 0.4, "concrete")
        for k in range(4): pbox(x - W / 2 + 0.02 + k * 0.12, y - L / 2, x - W / 2 + 0.12 + k * 0.12, y + L / 2, z + 0.4, z + 0.45, "wood")
def planter(x, y, z, w, d, rnd, h=0.55):
    pbox(x - w / 2, y - d / 2, x + w / 2, y + d / 2, z, z + h, "concrete"); pbox(x - w / 2 + 0.08, y - d / 2 + 0.08, x + w / 2 - 0.08, y + d / 2 - 0.08, z + h, z + h + 0.01, "soil")
    pbox(x - w / 2 - 0.03, y - d / 2 - 0.03, x + w / 2 + 0.03, y + d / 2 + 0.03, z + h - 0.06, z + h, "concrete_dk")
    n = max(2, int(w * d / 3.0))
    for k in range(n): shrub(x + rnd.uniform(-w / 2 + 0.3, w / 2 - 0.3), y + rnd.uniform(-d / 2 + 0.3, d / 2 - 0.3), z + h, rnd, 0.45, rnd.choice(["leaf", "leaf_lt", "moss", "pink"] if rnd.random() < 0.15 else ["leaf", "leaf_lt", "moss"]))
def bollard(x, y, z): cyl(x, y, z, z + 0.85, 0.09, 6, "steel")
def bike_rack(x, y, z, along_x):
    for k in range(5):
        o = (k - 2) * 0.5; ax, ay = (x + o, y) if along_x else (x, y + o); hx, hy = (0, 0.45) if along_x else (0.45, 0)
        for s in (-1, 1): pbox(ax + s * hx - 0.02 - (0.0 if along_x else 0), ay + s * hy - 0.02, ax + s * hx + 0.02, ay + s * hy + 0.02, z, z + 0.75, "alu_dk")
        pbox(ax - (0.02 if along_x else hx), ay - (hy if along_x else 0.02), ax + (0.02 if along_x else hx), ay + (hy if along_x else 0.02), z + 0.73, z + 0.77, "alu_dk")
def bin_(x, y, z): cyl(x, y, z, z + 0.9, 0.28, 10, "steel"); cyl(x, y, z + 0.9, z + 0.96, 0.3, 10, "alu_dk"); pbox(x - 0.12, y - 0.3, x + 0.12, y - 0.28, z + 0.6, z + 0.75, "black")
def hydrant(x, y, z): cyl(x, y, z, z + 0.7, 0.1, 8, "red"); cyl(x, y, z + 0.7, z + 0.78, 0.12, 8, "red")
def bus_shelter(x, y, z, face):
    """Glass shelter 4 m wide, back toward the building, open toward the street (face = unit vector to the street)."""
    fx, fy = face; fr = Frame((x - (-fy) * 2.0, y - fx * 2.0), (-fy, fx), (fx, fy), z)
    fbox(fr, 0, 4.0, -0.9, 0.9, 2.6, 2.75, "alu_dk")
    for u in (0.05, 3.95): fbox(fr, u - 0.05, u + 0.05, -0.85, -0.75, 0, 2.6, "alu_dk")
    for u in (0.05, 3.95): fbox(fr, u - 0.05, u + 0.05, 0.75, 0.85, 0, 2.6, "alu_dk")
    for u0, u1 in ((0.1, 1.95), (2.05, 3.9)):
        for s in (1, -1):
            P = fr.p; pts = [P(u0, -0.8, 0.3), P(u1, -0.8, 0.3), P(u1, -0.8, 2.5), P(u0, -0.8, 2.5)]; mb("shopglass").quad(*pts, (0, 0), (1, 0), (1, 1), (0, 1), fr.o(0, 1 if s > 0 else -1))
    fbox(fr, 0.3, 3.7, -0.7, -0.2, 0.42, 0.5, "wood"); fbox(fr, 0.3, 3.7, -0.7, -0.62, 0.0, 0.42, "alu_dk"); fbox(fr, 1.0, 2.2, -0.8, -0.74, 1.2, 2.2, "cool_led", b="led")
def kiosk(x, y, z, rnd, face):
    fx, fy = face; fr = Frame((x - (-fy) * 1.6, y - fx * 1.6), (-fy, fx), (fx, fy), z)
    fbox(fr, 0, 3.2, -1.2, 1.2, 0, 2.9, rnd.choice(["white", "teal", "navy", "orange"]))
    fbox(fr, 0.4, 2.8, 1.2, 1.26, 0.9, 2.4, "glass_dk"); fbox(fr, 0.2, 3.0, 1.2, 1.7, 2.45, 2.55, "alu_dk")
    fbox(fr, 0.3, 2.9, 1.27, 1.4, 0.9, 1.0, "wood")
def traffic_light(x, y, z, face):
    fx, fy = face; cyl(x, y, z, z + 5.2, 0.06, 8, "alu_dk", top=False); ex, ey = x + fx * 2.2, y + fy * 2.2
    pbox(min(x, ex) - 0.04, min(y, ey) - 0.04, max(x, ex) + 0.04, max(y, ey) + 0.04, z + 5.0, z + 5.12, "alu_dk")
    for k, c in enumerate(("red", "orange", "green")):
        pbox(ex - 0.1 + abs(fy) * 0.0, ey - 0.1, ex + 0.1, ey + 0.1, z + 4.6 - 0.0, z + 5.0, "black") if k == 0 else None
    pbox(ex - 0.12, ey - 0.12, ex + 0.12, ey + 0.12, z + 4.35, z + 5.0, "black"); pbox(ex - 0.06, ey - 0.06, ex + 0.06, ey + 0.06, z + 4.85, z + 4.95, "red", b="led"); pbox(ex - 0.06, ey - 0.06, ex + 0.06, ey + 0.06, z + 4.55, z + 4.65, "green", b="led")
def sign_pole(x, y, z, rnd): cyl(x, y, z, z + 2.8, 0.04, 6, "alu_dk", top=False); pbox(x - 0.35, y - 0.02, x + 0.35, y + 0.02, z + 2.1, z + 2.7, rnd.choice(["blue", "white", "green"]))
def crossing(x0, y0, x1, y1, z, along_x):
    """Zebra bars across a road: along_x -> bars run across x (stripes spaced in y)."""
    n = 0
    if along_x:
        y = y0
        while y + 0.5 <= y1: pquad("palette", (x0, y, z), (x1, y, z), (x1, y + 0.5, z), (x0, y + 0.5, z), "paint_white", (0, 0, 1)); y += 1.0
    else:
        x = x0
        while x + 0.5 <= x1: pquad("palette", (x, y0, z), (x + 0.5, y0, z), (x + 0.5, y1, z), (x, y1, z), "paint_white", (0, 0, 1)); x += 1.0
def stripe(x0, y0, x1, y1, z, color="paint_white"): pquad("palette", (x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z), color, (0, 0, 1))
