#!/usr/bin/env python3
"""Bazaar shop interiors: floor programs, per-room floor finishes and furniture from mixed free sources, patched onto world-city3.glb.

Each Bones_shop has 2-3 floors of rooms (bones.py layout). Ground floor = brand shop + back rooms; upper floors = living spaces
(living, kitchen, dining, study, bedrooms, bath, attic). Furniture is baked per building floor into one mesh per material
(`BzInt_<lot>_F<n>`), so it shares the city materials' cutaway clipping and costs a handful of draw calls per floor.
Sources (all CC0): Kenney Furniture Kit, Quaternius Furniture Pack, Quaternius Fantasy Props MegaKit, Poly Haven (tea-props).
  python3 tools/city3/bridge_bazaar_interiors.py --prep <dir holding kenney/ qfurn/ qfantasy/ unzipped>   # once: copy chosen files into the repo
  python3 tools/city3/bridge_bazaar_interiors.py [glb] [--lots 46] [--dry-run]
Visual meshes only: no collision yet (furniture is walk-through until the collision + navmesh pass).
"""
import argparse, glob, json, math, os, random, shutil, sys
sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
import meshoptimizer as MO
import interior_assets as IA
from bridge_landscape_kit import add_accessor, add_view
from bridge_wave1 import Glb, save_glb

A = os.path.join(HERE, "assets", "bazaar-interiors"); FLOORS = os.path.join(HERE, "assets", "tea-floors"); TEAP = os.path.join(HERE, "assets", "tea-props")
# key: (source, file stem, scale, yaw offset deg, triangle cap). Front of every model is made +z via the yaw offset.
ASSET = {
 # Kenney (flat colours, 0.2 m per unit)
 "k_bed_double": ("kenney", "bedDouble", .19, 0, 0), "k_bed_single": ("kenney", "bedSingle", .19, 0, 0), "k_bedside": ("kenney", "cabinetBedDrawerTable", .2, 0, 0),
 "k_tub": ("kenney", "bathtub", .17, 0, 0), "k_sink": ("kenney", "bathroomSink", .19, 0, 0), "k_toilet": ("kenney", "toilet", .19, 0, 0), "k_mirror": ("kenney", "bathroomMirror", .19, 0, 0),
 "k_stove": ("kenney", "kitchenStove", .19, 0, 0), "k_fridge": ("kenney", "kitchenFridge", .19, 0, 0), "k_cab": ("kenney", "kitchenCabinet", .19, 0, 0),
 "k_cab_up": ("kenney", "kitchenCabinetUpper", .19, 0, 0), "k_ksink": ("kenney", "kitchenSink", .19, 0, 0), "k_bar": ("kenney", "kitchenBar", .22, 0, 0),
 "k_lamp_floor": ("kenney", "lampRoundFloor", .19, 0, 0), "k_lamp_table": ("kenney", "lampSquareTable", .19, 0, 0), "k_rug": ("kenney", "rugRound", .25, 0, 0),
 # Quaternius furniture pack (flat colours, ~1 m per unit)
 "q_sofa": ("qfurn", "SofaLong", 1.4, 0, 0), "q_closet": ("qfurn", "Closet", 1.35, 0, 0), "q_bookcase": ("qfurn", "BookCase", 1.35, 0, 0), "q_coffee": ("qfurn", "CoffeeTable", 1.4, 0, 0),
 "q_table": ("qfurn", "Table", 1.35, 0, 0), "q_chair": ("qfurn", "Chair", 1.0, 0, 0), "q_chair2": ("qfurn", "ChairCushioned", 1.0, 0, 0), "q_plant": ("qfurn", "Plant", 2.4, 0, 0),
 "q_lamp": ("qfurn", "Lamp", 1.4, 0, 0), "q_bed": ("qfurn", "BedKing", 1.5, 0, 0),
 # Quaternius fantasy props (trim sheets, metres)
 "x_bed": ("qfantasy", "Bed_Twin1", 1.0, 0, 900), "x_nightstand": ("qfantasy", "Nightstand_Shelf", 1.0, 0, 0), "x_chandelier": ("qfantasy", "Chandelier", 1.0, 0, 700),
 "x_barrel": ("qfantasy", "Barrel", 1.0, 0, 500), "x_crate": ("qfantasy", "Crate_Wooden", .8, 0, 600), "x_shelf_bottles": ("qfantasy", "Shelf_Small_Bottles", 1.0, 0, 900),
 "x_bookcase": ("qfantasy", "Bookcase_2", 1.0, 0, 900), "x_workbench": ("qfantasy", "Workbench", 1.0, 0, 900), "x_chest": ("qfantasy", "Chest_Wood", .9, 0, 700),
 "x_stool": ("qfantasy", "Stool", 1.0, 0, 0), "x_table": ("qfantasy", "Table_Large", 1.0, 0, 900), "x_bench": ("qfantasy", "Bench", 1.0, 0, 0), "x_bag": ("qfantasy", "Bag", 1.0, 0, 500),
 "x_potion": ("qfantasy", "Potion_1", 1.0, 0, 0), "x_pot": ("qfantasy", "Pot_1", 1.0, 0, 500), "x_scroll": ("qfantasy", "Scroll_1", 1.0, 0, 0), "x_bucket": ("qfantasy", "Bucket_Wooden_1", 1.0, 0, 500),
 "x_cabinet": ("qfantasy", "Cabinet", 1.0, 0, 900), "x_chalice": ("qfantasy", "Chalice", 1.0, 0, 0), "x_cauldron": ("qfantasy", "Cauldron", .8, 0, 500),
 # Poly Haven (already decimated in tea-props)
 "p_bookshelf": ("tea", "wooden_bookshelf_worn", 1.0, 0, 0), "p_cabinet": ("tea", "chinese_cabinet", 1.0, 0, 0), "p_armchair": ("tea", "ArmChair_01", 1.0, 0, 0),
 "p_sofa": ("tea", "sofa_02", 1.15, 0, 0), "p_shelves": ("tea", "painted_wooden_shelves", 1.7, 0, 0), "p_ptable": ("tea", "painted_wooden_table", 1.0, 0, 0),
 "p_chair": ("tea", "painted_wooden_chair_01", 1.0, 0, 0), "p_chair2": ("tea", "painted_wooden_chair_02", .8, 0, 0), "p_coffee": ("tea", "modern_coffee_table_01", 1.0, 0, 0),
 "p_daybed": ("tea", "vintage_day_bed", 1.0, 0, 0), "p_closet": ("tea", "painted_wooden_cabinet", 1.0, 0, 0), "p_plant": ("tea", "potted_plant_04", 3.5, 0, 0),
 "p_lamp": ("tea", "vintage_oil_lamp", 1.0, 0, 0), "p_mirror": ("tea", "ornate_mirror_01", 1.0, 0, 0), "p_night": ("tea", "painted_wooden_nightstand", 1.0, 0, 0),
 "p_stool": ("tea", "painted_wooden_stool", 1.0, 0, 0), "p_bench": ("tea", "painted_wooden_bench", 1.0, 0, 0), "p_console": ("tea", "chinese_console_table", 1.0, 0, 0),
 "p_basket": ("tea", "wicker_basket_02", 1.0, 0, 0), "p_clock": ("tea", "vintage_grandfather_clock_01", 1.0, 0, 0), "p_display": ("tea", "wooden_display_shelves_01", 1.0, 0, 0),
 "p_vase": ("tea", "antique_ceramic_vase_01", 1.0, 0, 0), "p_dining": ("tea", "dining_table", 1.0, 0, 0),
}
FLOOR_TEX = {"shop": ("patterned_terracotta_tiling", 2.15), "store": ("floor_tiles_06", 2.0), "kitchen": ("interior_tiles", 1.9), "dining": ("oak_wood_planks", 1.2),
             "living": ("herringbone_parquet", 2.4), "study": ("wooden_floor_02", 1.9), "bedroom": ("hinoki_planks", 1.9), "bath": ("marble_mosaic_tiles", 2.0), "attic": ("dark_wood", 1.0)}
TINT = {"shop": (1, .95, .88), "store": (.85, .85, .85), "kitchen": (1, 1, 1), "dining": (1, .95, .9), "living": (1, .95, .9), "study": (.9, .85, .8), "bedroom": (1, .97, .92), "bath": (1, 1, 1), "attic": (.8, .75, .7)}
LANE = .95


# ---------------------------------------------------------------- assets
def prep(src):
    os.makedirs(A, exist_ok=True); meta = {}
    from PIL import Image
    for key, (s, stem, *_r) in ASSET.items():
        if s == "kenney": fs = [f"kenney/x/Models/{stem}.obj", f"kenney/x/Models/{stem}.mtl"]
        elif s == "qfurn": fs = [os.path.relpath(f, src) for f in glob.glob(os.path.join(src, "qfurn", "x", "**", stem + ".*"), recursive=True) if f.endswith((".obj", ".mtl"))]
        elif s == "qfantasy": fs = [f"qfantasy/x/Exports/glTF/{stem}.gltf", f"qfantasy/x/Exports/glTF/{stem}.bin"]
        else: continue
        for f in fs:
            d = os.path.join(A, s, os.path.basename(f)); os.makedirs(os.path.dirname(d), exist_ok=True); shutil.copy(os.path.join(src, f), d)
    for t in ("Furniture", "Metal", "Cloth", "Props", "Props_Vertex"):
        c = os.path.join(src, "qfantasy", "x", "Textures", f"T_Trim_{t}_BaseColor.png")
        if os.path.exists(c):
            Image.open(c).convert("RGB").resize((512, 512), Image.LANCZOS).save(os.path.join(A, "qfantasy", f"trim_{t}_c.jpg"), quality=84, optimize=True)
            n = c.replace("BaseColor", "Normal")
            if os.path.exists(n): Image.open(n).convert("RGB").resize((512, 512), Image.LANCZOS).save(os.path.join(A, "qfantasy", f"trim_{t}_n.jpg"), quality=88, optimize=True)
    for lic, name in (("kenney/x/License.txt", "kenney"), ("qfantasy/x/License_Standard.txt", "qfantasy")):
        if os.path.exists(os.path.join(src, lic)): shutil.copy(os.path.join(src, lic), os.path.join(A, f"LICENSE-{name}.txt"))
    json.dump({"kenney": {"source": "https://kenney.nl/assets/furniture-kit", "license": "CC0", "author": "Kenney"},
               "qfurn": {"source": "https://opengameart.org/content/furniture-low-poly", "license": "CC0", "author": "Quaternius"},
               "qfantasy": {"source": "https://quaternius.com/packs/fantasypropsmegakit.html", "license": "CC0 (Standard pack)", "author": "Quaternius"},
               "tea": {"source": "https://polyhaven.com/", "license": "CC0", "author": "Poly Haven artists, see assets/tea-props/meta.json"}}, open(os.path.join(A, "sources.json"), "w"), indent=2)
    print("prepared", sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(A) for f in fs) // 1024, "KB")


_cache = {}
def compact(p):
    """drop vertices no triangle references (simplify leaves them behind)."""
    used, inv = np.unique(p["I"], return_inverse=True); q = dict(p)
    for k in ("P", "N", "U"): q[k] = p[k][used]
    q["I"] = inv.astype("<u4"); return q


def decimate(p, cap):
    n = len(p["I"]) // 3
    if not cap or n <= cap: return p
    I = p["I"].astype(np.uint32); P = p["P"].astype(np.float32); dest = np.zeros(len(I), np.uint32)
    k = MO.simplify(dest, I, P, target_index_count=cap * 3, target_error=1.0)
    if k > cap * 3 * 1.25:  # attribute seams pin the mesh: fall back to the position-only sloppy simplifier
        k = MO.simplify_sloppy(dest, I, P, target_index_count=cap * 3, target_error=1.0)
    q = dict(p); q["I"] = dest[:int(k)].copy(); return compact(q)


def weld(p):
    """merge identical (position, normal, uv) vertices: the loaders de-index, which triples the GLB size."""
    p = dict(p); [p.__setitem__(k, np.nan_to_num(p[k], nan=0.0, posinf=0.0, neginf=0.0).astype("f4")) for k in ("P", "N", "U")]
    X = np.concatenate([p["P"], p["N"], p["U"]], 1).astype("f4"); u, first, inv = np.unique(X, axis=0, return_index=True, return_inverse=True)
    q = dict(p); q["P"] = p["P"][first]; q["N"] = p["N"][first]; q["U"] = p["U"][first]; q["I"] = inv.reshape(-1)[p["I"]].astype("<u4"); return q


def asset(key):
    """-> list of prims normalised: x/z centred, y min 0, metres, front +z; plus dims (w, h, d)."""
    if key in _cache: return _cache[key]
    s, stem, sc, yaw, cap = ASSET[key]
    if s == "kenney": prims = IA.load_obj(os.path.join(A, "kenney", stem + ".obj"))
    elif s == "qfurn": prims = IA.load_obj(os.path.join(A, "qfurn", stem + ".obj"))
    elif s == "qfantasy": prims = IA.load_gltf(os.path.join(A, "qfantasy", stem + ".gltf"))
    else:
        from bridge_wave1 import Glb as G
        g = G(os.path.join(TEAP, stem + ".glb")); j = g.gltf; prims = []
        meta = json.load(open(os.path.join(TEAP, "meta.json")))[stem]["materials"]
        for m in j["meshes"]:
            for p in m["primitives"]:
                mn = j["materials"][p["material"]]["name"]
                prims.append({"P": g.acc_raw(p["attributes"]["POSITION"]).astype("f4"), "N": g.acc_raw(p["attributes"]["NORMAL"]).astype("f4"), "U": g.acc_raw(p["attributes"]["TEXCOORD_0"]).astype("f4"),
                              "I": g.indices_of(p).astype("<u4"), "mat": f"ph_{stem}", "color": None, "tex": None, "ph": meta[mn]})
    prims = [weld(p) for p in prims]
    lo, hi = IA.bbox(prims); m = float(max(hi - lo)) * sc  # size-driven budget: the whole Bazaar (~8k items) must fit the ~100 MB world
    cap = 60 if m < .5 else 130 if m < 1.0 else 240
    prims = [decimate(p, max(12, cap // max(1, len(prims)))) for p in prims]
    lo, hi = IA.bbox(prims); c = np.array([(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2]); th = math.radians(yaw); co, si = math.cos(th), math.sin(th)
    out = []
    for p in prims:
        P = (p["P"] - c) * sc; N = p["N"].copy()
        R = lambda a: np.stack([a[:, 0] * co + a[:, 2] * si, a[:, 1], -a[:, 0] * si + a[:, 2] * co], 1)
        q = dict(p); q["P"] = R(P).astype("f4"); q["N"] = R(N).astype("f4"); out.append(q)
    lo, hi = IA.bbox(out); _cache[key] = (out, (float(hi[0] - lo[0]), float(hi[1] - lo[1]), float(hi[2] - lo[2]))); return _cache[key]


# ---------------------------------------------------------------- layout
class Room:
    """Local frame: u along the door wall (0 at the door), v inward. World x = plan x, world z = -plan y."""
    def __init__(self, r, floor_top, street_door=None):
        x0, y0, x1, y1 = r["rect"]; xa, xb, za, zb = x0, x1, -y1, -y0; dx, dz = r["door"][0], -r["door"][1]
        d = {"xa": abs(dx - xa), "xb": abs(dx - xb), "za": abs(dz - za), "zb": abs(dz - zb)}; w = min(d, key=d.get)
        n = {"xa": (1, 0), "xb": (-1, 0), "za": (0, 1), "zb": (0, -1)}[w]; self.n = np.array(n, float); self.t = np.array([n[1], -n[0]], float)
        self.O = np.array([dx, dz])
        corners = np.array([[xa, za], [xb, za], [xa, zb], [xb, zb]]); loc = [((c - self.O) @ self.t, (c - self.O) @ self.n) for c in corners]
        us = [l[0] for l in loc]; vs = [l[1] for l in loc]; self.ulo, self.uhi, self.D = min(us), max(us), max(vs) - 0.0
        self.rect = (xa, xb, za, zb); self.y = floor_top; self.items = []; self.keep = []
        if street_door:  # the shop's street door sits in this room's far wall: keep a 1.1 m wide, 1.5 m deep lane clear
            u0 = float((np.array([street_door[0], -street_door[1]]) - self.O) @ self.t); self.keep.append((self.pt(u0 - .55, self.D - 1.5), self.pt(u0 + .55, self.D + .3)))

    def pt(self, u, v): return self.O + self.t * u + self.n * v

    def put(self, key, u, v, face=(0, 1), up=0.0, mul=1.0, free=False):
        """face: (fu, fv) direction in the local frame the item's front points to. Floor items that leave the room, block the
        door lane or hit another floor item are rejected (None); free=True skips the test (toppers, hung pieces, rugs)."""
        f = self.t * face[0] + self.n * face[1]; yaw = math.atan2(f[0], f[1]); x, z = self.pt(u, v)
        it = (key, float(x), float(z), yaw, up, mul)
        if not free and key not in SOFT and up < .3 and check_one(self, it): return None
        self.items.append(it); return it

    def dims(self, key): return asset(key)[1]

    def top(self, key, host, up, mul=1.0):
        """put on/over a placed host item (same spot, no test); None when the host was rejected."""
        if host is None: return None
        it = (key, host[1], host[2], host[3], up, mul); self.items.append(it); return it

    def run(self, side, seq, gap=.06):
        """line items up along a wall: far = back wall left->right, left/right = side walls door->back. seq entries: key or (key, mul)."""
        got = []; cur = (self.ulo + .05) if side == "far" else .12; self.fd = getattr(self, "fd", 0.0)
        for e in seq:
            key, mul = (e, 1.0) if isinstance(e, str) else e; w, h, d = self.dims(key); w *= mul; d *= mul
            lim = (self.uhi - .05) if side == "far" else self.D - self.fd - .02
            if cur + w > lim: got.append(None); continue
            c = cur + w / 2
            if side == "far": it = self.put(key, c, self.D - d / 2 - .05, (0, -1), mul=mul)
            elif side == "left": it = self.put(key, self.ulo + d / 2 + .05, c, (1, 0), mul=mul)
            else: it = self.put(key, self.uhi - d / 2 - .05, c, (-1, 0), mul=mul)
            if it:
                cur += w + gap
                if side == "far": self.fd = max(self.fd, d + .05)
            got.append(it)
        return got


def check_one(R, it, tol=.04):
    """reason when a floor item does not belong at its spot (outside room / door lane / overlap), else ''."""
    xa, xb, za, zb = R.rect; b = aabb(R, it)
    if b[0] < xa - tol or b[1] > xb + tol or b[2] < za - tol or b[3] > zb + tol: return "outside"
    p0 = R.pt(-LANE / 2, 0); p1 = R.pt(LANE / 2, 1.3); lx0, lx1 = sorted((p0[0], p1[0])); lz0, lz1 = sorted((p0[1], p1[1]))
    if min(b[1], lx1) - max(b[0], lx0) > tol and min(b[3], lz1) - max(b[2], lz0) > tol: return "lane"
    for q0, q1 in R.keep:
        kx0, kx1 = sorted((q0[0], q1[0])); kz0, kz1 = sorted((q0[1], q1[1]))
        if min(b[1], kx1) - max(b[0], kx0) > tol and min(b[3], kz1) - max(b[2], kz0) > tol: return "street door"
    for o in R.items:
        if o[0] in SOFT or o[4] >= .3: continue
        c = aabb(R, o)
        if min(b[1], c[1]) - max(b[0], c[0]) > tol and min(b[3], c[3]) - max(b[2], c[2]) > tol: return "overlap"
    return ""


def uof(R, it): return float((np.array([it[1], it[2]]) - R.O) @ R.t)


def ends(R, key, face, v, mul=1.0, wide=None):
    """try the two ends of the room (the doors sit on the centre line, so the middle is lane): -> placed items."""
    w, h, d = R.dims(key); w = (wide or (w if face[1] else d)) * mul; got = []
    for u in (R.ulo + w / 2 + .1, R.uhi - w / 2 - .1):
        it = R.put(key, u, v, face, mul=mul)
        if it: got.append(it)
    return got


def seat(R, t, key, per_side):
    """chairs on both long sides of a placed table, facing it (checked like any floor item)."""
    w, h, d = R.dims(t[0]); cw = R.dims(key)[0]; (_, x, z, yaw, _, mul) = t; u0 = float((np.array([x, z]) - R.O) @ R.t); v0 = float((np.array([x, z]) - R.O) @ R.n)
    for side in (-1, 1):
        for k in range(per_side):
            R.put(key, u0 + (k - (per_side - 1) / 2) * (w * .5), v0 + side * (d * mul / 2 + cw * .5 + .1), (0, -side))


def furnish(R, kind, rnd):
    L, Rr, D = R.ulo, R.uhi, R.D; mid = D * .5; cu = (L + Rr) / 2
    if kind == "shop":  # spice merchant: shelving on the back wall, barrels and sacks down the sides, display table with jars
        R.run("far", ["x_bookcase", "x_bookcase", "x_bookcase", "x_bookcase"])
        R.run("left", ["x_barrel", "x_barrel", "x_bag", "x_crate"]); R.run("right", ["k_bar", "x_crate", "x_bag", "x_chest"])
        for t in ends(R, "x_table", (1, 0), mid + .2)[:1]:
            for i, k in enumerate(("x_pot", "x_potion", "x_potion", "x_chalice", "p_vase")): R.put(k, uof(R, t), mid - 1.0 + i * .5, (1, 0), up=.81, free=True)
            R.put("x_chandelier", uof(R, t), mid, (0, 1), up=2.55, free=True)
    elif kind == "store":
        R.run("far", ["x_crate", "x_crate", "x_barrel", "x_bag"]); R.run("left", ["x_barrel", "x_barrel", "x_barrel"]); R.run("right", ["p_shelves", "x_bag", "p_basket"])
        for c in ends(R, "x_crate", (0, 1), mid + .2)[:1]: R.top("x_crate", c, .95, mul=.8)
    elif kind == "kitchen":
        far = R.run("far", ["k_fridge", "k_cab", "k_ksink", "k_cab", "k_stove", "k_cab"])
        for it in far[1:]: R.top("k_cab_up", it, 1.45)
        for t in ends(R, "p_ptable", (0, 1), mid + .2)[-1:]: seat(R, t, "p_chair", 2); R.top("x_pot", t, .85)
    elif kind == "dining":
        for t in ends(R, "p_dining", (0, 1), mid + .2):
            seat(R, t, "p_chair2", 2); R.put("x_chandelier", uof(R, t), mid + .2, (0, 1), up=2.55, free=True)
        R.run("far", ["p_cabinet"]); R.run("left", ["x_cauldron"]); R.run("right", ["p_plant"])
    elif kind == "living":
        R.run("far", ["p_shelves", "p_sofa", "p_shelves", "p_clock"])
        R.put("k_rug", cu, mid + .2, (0, 1), mul=1.1, free=True); R.put("p_coffee", cu, mid - .1, (0, 1), mul=.8)
        R.run("left", ["p_shelves", "p_plant"]); R.run("right", ["p_armchair", "p_plant"])
    elif kind == "study":
        R.run("far", ["x_workbench", "x_bookcase"]); R.run("left", ["p_bookshelf", "p_bookshelf", "p_bookshelf"]); R.run("right", ["p_bench", "p_lamp"])
        R.put("p_stool", L + 1.0, D - 1.45, (0, -1)); R.put("x_scroll", L + 1.0, D - .55, (0, -1), up=.9, free=True)
    elif kind in ("bedroom_a", "bedroom_b", "bedroom_c"):
        if kind == "bedroom_a": R.run("far", ["x_bed", "x_chest", "x_bed"])
        elif kind == "bedroom_b": f = R.run("far", ["p_daybed", "p_night", "p_closet"]); R.top("p_lamp", f[1], .55)
        else: R.run("far", ["p_daybed", "p_night", "p_closet"])
        R.run("right", ["p_closet", "x_chest"]); R.put("k_rug", cu, mid + .4, (0, 1), mul=.8, free=True)
    elif kind == "bath":
        R.run("far", ["k_tub"]); r = R.run("right", ["k_toilet", "k_sink"]); R.run("left", ["p_plant"]); R.top("p_mirror", r[1], 1.4)
    elif kind == "attic":
        R.run("far", ["x_chest", "x_crate", "x_cauldron"]); R.run("left", ["x_barrel", "x_barrel"]); R.run("right", ["x_bag", "x_crate"])


SOFT = ("k_rug", "x_chandelier")  # may overlap / hang above floor items


def aabb(R, it):
    key, x, z, yaw, up, mul = it; w, h, d = R.dims(key); co, si = abs(math.cos(yaw)), abs(math.sin(yaw))
    hx = (co * w + si * d) * mul / 2; hz = (si * w + co * d) * mul / 2; return x - hx, x + hx, z - hz, z + hz, up, up + h * mul


def check(R, tol=.04):
    """Geometry check of one furnished room straight from the placement data: -> list of problems (out-of-room, overlap, blocked door lane)."""
    xa, xb, za, zb = R.rect; bad = []; box = [(it[0], aabb(R, it)) for it in R.items if it[0] not in SOFT]
    for k, b in box:
        if b[0] < xa - tol or b[1] > xb + tol or b[2] < za - tol or b[3] > zb + tol: bad.append(("outside", k))
    lo = [(k, b) for k, b in box if b[4] < .3]  # floor-standing
    for i in range(len(lo)):
        for j in range(i + 1, len(lo)):
            a, b = lo[i][1], lo[j][1]
            if min(a[1], b[1]) - max(a[0], b[0]) > tol and min(a[3], b[3]) - max(a[2], b[2]) > tol: bad.append(("overlap", lo[i][0] + "/" + lo[j][0]))
    p0 = R.pt(-LANE / 2, 0); p1 = R.pt(LANE / 2, 1.3); lx0, lx1 = sorted((p0[0], p1[0])); lz0, lz1 = sorted((p0[1], p1[1]))
    for k, b in lo:
        if min(b[1], lx1) - max(b[0], lx0) > tol and min(b[3], lz1) - max(b[2], lz0) > tol: bad.append(("lane", k))
    return bad


TEMPL = {int(h["id"][5:]): h["template"] for h in json.load(open(os.path.join(HERE, "out", "heroes.json"))) if h["id"][5:].isdigit()}


def program(lot, rooms):
    """room kind per (floor, tag, i). Ground: brand shop on the street room, back rooms around it; upper floors: homes."""
    out = {}; rr = random.Random(lot["id"] * 17 + 3)
    upper = [["living", "kitchen", "dining", "study", "bath", "bedroom_a"], ["bedroom_b", "bedroom_c", "bedroom_a", "study", "bath", "attic"]]
    for r in rooms:
        k = (r["floor"], r["tag"], r["i"])
        if r["floor"] == 0:
            out[k] = ("dining" if TEMPL.get(lot["id"]) in ("cafe", "tea") else "shop") if r["street"] else ("store" if r["tag"] == "N" else rr.choice(["store", "kitchen", "study", "dining"]))
        else:
            seq = upper[min(1, r["floor"] - 1)]; out[k] = seq[(r["i"] * 2 + (r["tag"] == "N") + lot["id"]) % len(seq)]
    return out


# ---------------------------------------------------------------- build
def run(path, lots, dry):
    sys.path.insert(0, HERE)
    import subprocess, tempfile
    em = os.path.join(tempfile.gettempdir(), "bones_all.json")
    subprocess.run([sys.executable, os.path.join(HERE, "bones.py"), "--emit", em], check=True, capture_output=True)
    from bridge_bazaar_demolish import ALL as GONE  # demolished lots have no building left to furnish
    data = [l for l in json.load(open(em)) if (not lots or l["id"] in lots) and l["id"] not in GONE]
    g = Glb(path); j = g.gltf
    if j.get("extras", {}).get("bazaar_interiors_pass"): print({"already_patched": True}); return
    mats = {}
    def img(fn, name):
        v = add_view(g, open(fn, "rb").read(), None); j["bufferViews"][v].pop("target", None)
        j["images"].append({"name": name, "bufferView": v, "mimeType": "image/jpeg"}); j["textures"].append({"source": len(j["images"]) - 1}); return len(j["textures"]) - 1
    def material(key, color=None, trim=None, ph=None, floor=None):
        if key in mats: return mats[key]
        m = {"name": key, "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0.0, "roughnessFactor": .85}}
        if trim:
            m["pbrMetallicRoughness"]["baseColorTexture"] = {"index": img(os.path.join(A, "qfantasy", f"trim_{trim}_c.jpg"), f"bzi_trim_{trim}")}
            n = os.path.join(A, "qfantasy", f"trim_{trim}_n.jpg")
            if os.path.exists(n): m["normalTexture"] = {"index": img(n, f"bzi_trim_{trim}_n")}
        if ph:
            m["pbrMetallicRoughness"]["baseColorTexture"] = {"index": img(os.path.join(TEAP, ph["color"]), "bzi_" + key)}; m["doubleSided"] = ph.get("doubleSided", False)
            if ph.get("normal"): m["normalTexture"] = {"index": img(os.path.join(TEAP, ph["normal"]), "bzi_" + key + "_n")}
        if floor:
            tid, tint = floor; m["pbrMetallicRoughness"]["baseColorFactor"] = [*tint, 1]
            m["pbrMetallicRoughness"]["baseColorTexture"] = {"index": img(os.path.join(FLOORS, f"{tid}_c.jpg"), f"bzi_f_{tid}")}
            m["normalTexture"] = {"index": img(os.path.join(FLOORS, f"{tid}_n.jpg"), f"bzi_f_{tid}_n")}
        j["materials"].append(m); mats[key] = len(j["materials"]) - 1; return mats[key]
    def acc(arr, typ, mm=False):
        a = np.ascontiguousarray(arr, "<f4")
        return add_accessor(g, add_view(g, a.tobytes(), 34962), 5126, len(a), typ, a.min(0).tolist() if mm else None, a.max(0).tolist() if mm else None)
    scene = j["scenes"][j.get("scene", 0)]["nodes"]; rep = {"lots": 0, "rooms": 0, "items": 0, "tris": 0, "kinds": {}}
    lot_boxes = {}; lot_seats = {}
    for lot in data:
        rooms = lot["rooms"]; prog = program(lot, rooms); rnd = random.Random(lot["id"]); rep["lots"] += 1
        floors = sorted({r["floor"] for r in rooms})
        for fl in floors:
            groups = {}  # material key -> list of (P,N,U,C)
            def add(mkey, mk, P, N, U, C=None): groups.setdefault(mkey, {"mk": mk, "P": [], "N": [], "U": [], "C": [], "I": []}); q = groups[mkey]; q["I"].append(len(sum(q["P"], [])) if False else None); q["P"].append(P); q["N"].append(N); q["U"].append(U); q["C"].append(C)
            for r in [r for r in rooms if r["floor"] == fl]:
                kind = prog[(fl, r["tag"], r["i"])]; ftop = r["z"] + .2; R = Room(r, ftop, lot["door"] if r["street"] and fl == 0 else None); furnish(R, kind, rnd)
                for t, k in check(R): rep.setdefault("bad", {}).setdefault(kind, {}).setdefault(t + ":" + k, 0); rep["bad"][kind][t + ":" + k] += 1
                for it in R.items:  # walker collision: axis-aligned footprint (yaw is a multiple of 90 deg) from the floor up to the item top
                    if it[0] in SOFT or it[4] >= .3 or R.dims(it[0])[1] * it[5] < .25: continue
                    x0, x1, z0, z1, _, top = aabb(R, it); lot_boxes.setdefault(lot["id"], []).append([round((x0 + x1) / 2, 3), round((z0 + z1) / 2, 3), round((x1 - x0) / 2, 3), round((z1 - z0) / 2, 3), round(ftop, 3), round(ftop + top, 3), 0.0])
                if fl == 0:  # sittable anchors for the ground floor (upper floors have no lift for the sim yet): chairs of this room, grouped per room
                    for it in R.items:
                        if it[0] in ("p_chair", "p_chair2", "p_armchair"):
                            fx, fz = math.sin(it[3]), math.cos(it[3]); n_seat = len(lot_seats.setdefault(lot["id"], []))
                            lot_seats[lot["id"]].append({"id": f"shop-{lot['id']}-chair-{n_seat}", "building": f"shop-{lot['id']}", "kind": "armchair" if it[0] == "p_armchair" else "chair", "seat": [round(it[1], 2), round(it[2], 2)], "facing": round(it[3], 4),
                                                         "approach": [round(it[1] - fx * .62, 2), round(it[2] - fz * .62, 2)], "approachSide": "back", "seatHeight": .46, "floorY": round(ftop, 2), "group": f"shop-{lot['id']}-room-{r['tag']}{r['i']}"})
                rep["rooms"] += 1; rep["kinds"][kind] = rep["kinds"].get(kind, 0) + 1
                fk = kind if kind in FLOOR_TEX else "bedroom" if kind.startswith("bedroom") else "store"
                tid, tile = FLOOR_TEX[fk]; xa, xb, za, zb = R.rect; e = .12; q = np.array([[xa + e, ftop + .02, za + e], [xb - e, ftop + .02, za + e], [xb - e, ftop + .02, zb - e], [xa + e, ftop + .02, zb - e]], "f4")
                U = (q[:, [0, 2]] / tile).astype("f4"); Nn = np.tile([0, 1, 0], (4, 1)).astype("f4")
                add("floor_" + tid, ("floor", tid, TINT[fk]), q[[0, 3, 2, 1]] if False else q, Nn, U)
                for key, x, z, yaw, up, mul in R.items:
                    prims, dm = asset(key); co, si = math.cos(yaw), math.sin(yaw)
                    for p in prims:
                        P = p["P"] * mul; Pw = np.stack([P[:, 0] * co + P[:, 2] * si + x, P[:, 1] + ftop + up, -P[:, 0] * si + P[:, 2] * co + z], 1).astype("f4")
                        N = np.stack([p["N"][:, 0] * co + p["N"][:, 2] * si, p["N"][:, 1], -p["N"][:, 0] * si + p["N"][:, 2] * co], 1).astype("f4")
                        if p.get("ph"): mk = ("ph", p["mat"], p["ph"], None); mkey = p["mat"]
                        elif p["tex"] in ("Trim_Furniture", "Trim_Metal", "Trim_Cloth", "Trim_Props"): mk = ("trim", p["tex"].replace("Trim_", ""), None, None); mkey = "trim_" + p["tex"]
                        else: mk = ("vc", None, None, None); mkey = "vc"
                        C = np.tile(np.array(p["color"] if p["color"] else (.7, .7, .7), "f4"), (len(Pw), 1)) if mkey == "vc" else None
                        idx = p["I"]; groups.setdefault(mkey, {"mk": mk, "P": [], "N": [], "U": [], "C": [], "I": [], "n": 0})
                        q = groups[mkey]; q.setdefault("n", 0); q["I"].append(idx + q["n"]); q["P"].append(Pw); q["N"].append(N); q["U"].append(p["U"]); q["C"].append(C); q["n"] += len(Pw)
                        rep["tris"] += len(idx) // 3; rep["mb"] = rep.get("mb", 0) + (len(Pw) * 44 + len(idx) * 4) / 1e6; rep["items"] += 1 if p is prims[0] else 0
            if dry: continue
            prims_out = []
            for mkey, q in groups.items():
                if mkey.startswith("floor_"):
                    P = np.concatenate(q["P"]); Nn = np.concatenate(q["N"]); Uu = np.concatenate(q["U"]); n = 0; base = 0; idx = []
                    # one quad per room: P holds 4 verts per room
                    for k in range(len(q["P"])): idx += [base, base + 1, base + 2, base, base + 2, base + 3]; base += 4
                    m = material(mkey, floor=(q["mk"][1], q["mk"][2])); I = np.array(idx, "<u4")
                    prims_out.append({"attributes": {"POSITION": acc(P, "VEC3", True), "NORMAL": acc(Nn, "VEC3"), "TEXCOORD_0": acc(Uu, "VEC2")}, "indices": add_accessor(g, add_view(g, I.tobytes(), 34963), 5125, len(I), "SCALAR"), "material": m}); continue
                kind, a, b, _ = q["mk"]
                if kind == "ph": m = material(mkey, ph=b)
                elif kind == "trim": m = material(mkey, trim=a)
                else: m = material("BzInt_vc")
                at = {"POSITION": acc(np.concatenate(q["P"]), "VEC3", True), "NORMAL": acc(np.concatenate(q["N"]), "VEC3"), "TEXCOORD_0": acc(np.concatenate(q["U"]), "VEC2")}
                if kind == "vc": at["COLOR_0"] = acc(np.concatenate(q["C"]), "VEC3")
                I = np.concatenate(q["I"]).astype("<u4")
                prims_out.append({"attributes": at, "indices": add_accessor(g, add_view(g, I.tobytes(), 34963), 5125, len(I), "SCALAR"), "material": m})
            j["meshes"].append({"name": f"BzInt_{lot['id']}_F{fl}", "primitives": prims_out}); j["nodes"].append({"name": f"BzInt_{lot['id']}_F{fl}", "mesh": len(j["meshes"]) - 1}); scene.append(len(j["nodes"]) - 1)
    print(json.dumps(rep))
    if dry: return
    j.setdefault("extras", {})["bazaar_interiors_pass"] = "v1"; print("wrote", path, save_glb(path, g.gltf, g.bin), "bytes")
    # the streamed library furnishings (furnish_bones.py) would overlap the new rooms: empty them for the lots done here
    ap_ = os.path.join(os.path.dirname(os.path.abspath(path)), "city3-anchors.json"); an = json.load(open(ap_)); gone = {f"shop-{l['id']}" for l in data} | {f"shop-{i}" for i in GONE}
    an = [a for a in an if a["building"] not in gone] + [a for v in lot_seats.values() for a in v]; json.dump(an, open(ap_, "w"), separators=(",", ":")); print({"anchors": len(an), "new_seats": sum(len(v) for v in lot_seats.values())})
    idir = os.path.join(os.path.dirname(os.path.abspath(path)), "interiors")
    for lot in data:
        sid = "shop-%d" % lot["id"]
        json.dump({"id": sid, "library": "world-city3-library.glb", "props": []}, open(os.path.join(idir, sid + ".json"), "w"), separators=(",", ":"))
        cp = os.path.join(idir, sid + ".col.json"); c = json.load(open(cp)); c["boxes"] = lot_boxes.get(lot["id"], []); json.dump(c, open(cp, "w"), separators=(",", ":"))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("glb", nargs="?", default="apps/console/public/assets/world-city3.glb"); ap.add_argument("--lots", default="")
    ap.add_argument("--prep"); ap.add_argument("--dry-run", action="store_true"); a = ap.parse_args()
    if a.prep: prep(a.prep)
    else: run(a.glb, {int(v) for v in a.lots.split(",") if v}, a.dry_run)
