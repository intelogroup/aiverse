"""Foundry Wharf industrial pass (runs inside headless Blender via foundry.py).

 - roller-door bays  : 6 procedural variants (3 colours x closed / half-open, ~135 tris) built once in a wall-local frame (u along the wall from the
                       opening's left jamb, t out of it, z from the street) and placed as linked duplicates under `inst_door_*` Empties (EXT_mesh_gpu_instancing)
 - containers v2     : 4 colour variants (12.2 x 2.44 x 2.6, ~350 tris: corrugation ribs, corner castings, door end with lock rods + handles, top / bottom rails)
 - loose props       : pallets, loaded pallets, oil drums (procedural) + Poly Haven CC0 barrel_03 / wooden_crate_01 + Sketchfab CC-BY forklift, scattered by a
                       dedicated random.Random in clusters: in front of free loft bays, on the container quay, between the rail sidings, in the container yards
Everything that repeats is a linked duplicate; every prop that blocks a walker gets a `props` collision solid through the COL object foundry.py passes in."""
import bpy, math, random
from mathutils import Matrix, Vector
import kit
from kit import MBS, grp, Frame, pquad, pbox, fbox, cyl
from mkit import MATS, tquad
import assets_kit as AK

LIBS = {}                    # key -> bpy object (library mesh, origin at the base centre, local +x = length / forward)
PLACE = {}                   # key -> [(x, y, z, rotZ, scale)]
TRIS = {}                    # key -> triangles of ONE copy
STATS = {}
def _put(key, x, y, z, rot, sc=1.0): PLACE.setdefault(key, []).append((x, y, z, rot, sc))

def _lib_from_group(prefix, key):
    """Collect the MB buckets built inside grp(prefix) into one mesh object (one material slot per bucket)."""
    keys = [k for k in list(MBS) if k.startswith(prefix + "::")]
    verts = []; faces = []; uvs = []; midx = []; mats = []
    for mi, k in enumerate(keys):
        b = MBS.pop(k); m = k.rpartition("::")[2]; mats.append(m); off = len(verts)
        verts += b.v; faces += [tuple(i + off for i in f) for f in b.f]; uvs += [c for tri in b.uv for uv in tri for c in uv]; midx += [mi] * len(b.f)
    me = bpy.data.meshes.new("LIB_" + key); me.from_pydata(verts, [], faces); me.update()
    me.uv_layers.new(name="UVMap").data.foreach_set("uv", uvs)
    for m in mats: me.materials.append(MATS[m])
    me.polygons.foreach_set("material_index", midx)
    ob = bpy.data.objects.new("LIB_" + key, me); bpy.context.scene.collection.objects.link(ob)
    LIBS[key] = ob; TRIS[key] = len(faces); return ob

# ================================================================================================ roller doors
DW, DH = 2.5, 3.4                                  # opening width / height used by foundry.brick_bay_wall
DOOR_COL = ["container_red", "container_blue", "container_ochre"]
def build_door(v):
    col = DOOR_COL[v // 2]; half = v % 2 == 1; F = Frame((0, 0), (1, 0), (0, -1), 0.0); P = F.p; o = F.o
    zb = 1.55 if half else 0.0                                   # bottom of the slat curtain
    with grp(f"LIBDR{v}"):
        for u0, u1 in ((0.0, 0.1), (DW - 0.1, DW)): fbox(F, u0, u1, -0.30, -0.12, 0.0, DH, "steel")           # side guides
        fbox(F, 0.0, DW, -0.34, -0.10, DH - 0.32, DH, col)                                                     # roller housing under the lintel
        fbox(F, -0.1, DW + 0.1, -0.25, 0.08, DH, DH + 0.2, "steel")                                            # lintel
        zs = zb + 0.20; n = int((DH - 0.32 - zs) / 0.18); p = (DH - 0.32 - zs) / n
        for k in range(n):                                                                                      # slats: stepped, so the curtain reads as ribbed
            z0 = zs + k * p
            pquad("palette", P(0.1, -0.22, z0 + 0.04), P(DW - 0.1, -0.22, z0 + 0.04), P(DW - 0.1, -0.22, z0 + p), P(0.1, -0.22, z0 + p), col, o(0, 1))
            pquad("palette", P(0.1, -0.26, z0), P(DW - 0.1, -0.26, z0), P(DW - 0.1, -0.22, z0 + 0.04), P(0.1, -0.22, z0 + 0.04), col, o(0, 0.5, -1))
        fbox(F, 0.1, DW - 0.1, -0.30, -0.18, zb, zb + 0.2, "steel")                                            # bottom bar with a hazard stripe
        seg = 8; sw = (DW - 0.2) / seg
        for k in range(seg): pquad("palette", P(0.1 + k * sw, -0.175, zb + 0.04), P(0.1 + (k + 1) * sw, -0.175, zb + 0.04), P(0.1 + (k + 1) * sw, -0.175, zb + 0.16), P(0.1 + k * sw, -0.175, zb + 0.16), "paint_yellow" if k % 2 == 0 else "black", o(0, 1))
        if half:
            pquad("palette", P(0.1, -0.34, 0.0), P(DW - 0.1, -0.34, 0.0), P(DW - 0.1, -0.34, zb), P(0.1, -0.34, zb), "black", o(0, 1))   # dark depot beyond the raised curtain
        side = 1 if v in (0, 1, 4, 5) else -1                                                                  # wall lamp on one side, number plate on the other
        lu = DW + 0.4 if side > 0 else -0.4; pu = -0.55 if side > 0 else DW + 0.2
        fbox(F, lu - 0.05, lu + 0.05, 0.0, 0.30, 3.00, 3.06, "steel"); fbox(F, lu - 0.12, lu + 0.12, 0.22, 0.40, 2.86, 3.08, "steel")
        pquad("led", P(lu - 0.1, 0.22, 2.86), P(lu + 0.1, 0.22, 2.86), P(lu + 0.1, 0.40, 2.86), P(lu - 0.1, 0.40, 2.86), "warm_led", (0, 0, -1))
        pquad("palette", P(pu, 0.015, 2.25), P(pu + 0.35, 0.015, 2.25), P(pu + 0.35, 0.015, 2.55), P(pu, 0.015, 2.55), "paint_white" if v % 3 else "paint_yellow", o(0, 1))
        pquad("palette", P(pu + 0.06, 0.02, 2.31), P(pu + 0.29, 0.02, 2.31), P(pu + 0.29, 0.02, 2.49), P(pu + 0.06, 0.02, 2.49), "black", o(0, 1))
    return _lib_from_group(f"LIBDR{v}", f"door{v}")
DOORS = []                                         # (variant, x, y, z, rot, width)
_drng = random.Random(6161); _crng = random.Random(7373)
def door(fr, a, d, z):
    """Queue a roller door in the opening a..d of wall frame `fr` (called by foundry.brick_bay_wall instead of drawing a flat panel)."""
    v = _drng.randrange(6); rot = math.atan2(fr.r[1], fr.r[0]); x, y, zz = fr.p(a, 0, z); DOORS.append((v, x, y, zz, rot, d - a)); return v

# ================================================================================================ containers
CL, CW, CH = 12.2, 2.44, 2.6
CONT_COL = ["cont_red", "cont_blue", "cont_green", "cont_ochre"]; CONT_TL = 2.7
def build_container(col):
    hx, hy = CL / 2, CW / 2; tl = CONT_TL; wl = hy - 0.035; key = f"cont_{col}"
    def sq(p0, p1, z0, z1, nrm):                                           # textured vertical quad between 2 plan points
        ln = math.hypot(p1[0] - p0[0], p1[1] - p0[1]); u0 = (p0[0] + p0[1]) / tl
        tquad(col, (p0[0], p0[1], z0), (p1[0], p1[1], z0), (p1[0], p1[1], z1), (p0[0], p0[1], z1), [(u0, z0 / tl), (u0 + ln / tl, z0 / tl), (u0 + ln / tl, z1 / tl), (u0, z1 / tl)], nrm)
    with grp(f"LIB{key}"):
        for s in (-1, 1):                                                  # long sides: recessed web + 12 raised trapezoid ribs
            sq((-hx, s * wl), (hx, s * wl), 0.0, CH, (0, s, 0))
            nr = 12; x0 = -hx + 0.55; pitch = (CL - 1.1) / nr
            for k in range(nr):
                a = x0 + k * pitch + 0.06; b = a + pitch - 0.12; ia, ib = a + 0.05, b - 0.05; yo = s * hy
                pts = [(a, s * wl), (ia, yo), (ib, yo), (b, s * wl)]
                sq(pts[1], pts[2], 0.18, CH - 0.18, (0, s, 0))
                for p0, p1 in ((pts[0], pts[1]), (pts[2], pts[3])): sq(p0, p1, 0.18, CH - 0.18, (-s * (p1[1] - p0[1]), s * (p1[0] - p0[0]), 0))
        sq((hx, -hy), (hx, hy), 0.0, CH, (1, 0, 0))                        # door end (+x)
        sq((-hx, hy), (-hx, -hy), 0.0, CH, (-1, 0, 0))                     # blind end (-x)
        pquad("palette", (-hx, -hy, CH), (hx, -hy, CH), (hx, hy, CH), (-hx, hy, CH), "container_grey", (0, 0, 1))
        for sx in (-1, 1):                                                 # corner castings (8)
            for sy in (-1, 1):
                xa, xb = (hx - 0.4, hx + 0.03) if sx > 0 else (-hx - 0.03, -hx + 0.4); ya, yb = (hy - 0.14, hy + 0.03) if sy > 0 else (-hy - 0.03, -hy + 0.14)
                for z0 in (0.0, CH - 0.16): pbox(xa, ya, xb, yb, z0, z0 + 0.16, "alu_dk")
        for sy in (-1, 1):                                                 # bottom / top side rails
            ya, yb = (hy - 0.1, hy + 0.02) if sy > 0 else (-hy - 0.02, -hy + 0.1)
            pbox(-hx + 0.4, ya, hx - 0.4, yb, 0.0, 0.13, "black"); pbox(-hx + 0.4, ya, hx - 0.4, yb, CH - 0.12, CH, "alu_dk")
        for k in range(4):                                                 # lock rods on the door end, with cam handles
            y = -0.85 + k * 0.567; cyl(hx + 0.03, y, 0.12, CH - 0.12, 0.022, 4, "alu", top=False)
            pbox(hx, y - 0.05, hx + 0.09, y + 0.05, 0.85, 0.97, "alu_dk")
            if k in (0, 3): pbox(hx, y - 0.04, hx + 0.07, y + 0.04, 1.8, 1.9, "alu_dk")
        pquad("palette", (hx + 0.002, -0.015, 0.1), (hx + 0.002, 0.015, 0.1), (hx + 0.002, 0.015, CH - 0.1), (hx + 0.002, -0.015, CH - 0.1), "black", (1, 0, 0))        # door seam
    return _lib_from_group(f"LIB{key}", key)

# ================================================================================================ procedural props
def build_pallet(wood):
    with grp("LIBpal"):
        for y in (-0.35, 0.0, 0.35): pbox(-0.6, y - 0.045, 0.6, y + 0.045, 0.0, 0.09, wood)                    # stringers
        for k in range(5): x = -0.55 + k * 0.275; pbox(x - 0.06, -0.4, x + 0.06, 0.4, 0.09, 0.115, wood)       # deck boards
    return _lib_from_group("LIBpal", "pallet")
def build_load(kind):
    with grp("LIBpl"):
        for y in (-0.35, 0.0, 0.35): pbox(-0.6, y - 0.045, 0.6, y + 0.045, 0.0, 0.09, "wood_dk")
        for k in range(5): x = -0.55 + k * 0.275; pbox(x - 0.06, -0.4, x + 0.06, 0.4, 0.09, 0.115, "wood_dk")
        if kind == 0:                                                                                           # cartons, two layers, upper one shifted
            for z, dx in ((0.115, 0.0), (0.585, 0.05)):
                for ix in (0, 1):
                    for iy in (0, 1): x0 = dx - 0.55 + ix * 0.55; y0 = -0.37 + iy * 0.37; pbox(x0, y0, x0 + 0.55, y0 + 0.37, z, z + 0.47, "sand")
        else:                                                                                                   # shrink-wrapped block with a strapping band
            pbox(-0.52, -0.37, 0.52, 0.37, 0.115, 1.05, "tile_white"); pbox(-0.525, -0.375, 0.525, 0.375, 0.5, 0.56, "blue")
    return _lib_from_group("LIBpl", f"load{kind}")
def build_drum(col):
    with grp("LIBdr"):
        r = 0.29; cyl(0, 0, 0.0, 0.88, r, 10, col)
        for z in (0.2, 0.62): cyl(0, 0, z, z + 0.05, r + 0.012, 10, col, top=False)
        cyl(0, 0, 0.88, 0.89, 0.2, 10, "alu_dk")
    return _lib_from_group("LIBdr", f"drum_{col}")
def build_bollard():
    with grp("LIBbo"):
        cyl(0, 0, 0.0, 0.9, 0.1, 6, "paint_yellow"); cyl(0, 0, 0.3, 0.45, 0.103, 6, "black", top=False); cyl(0, 0, 0.9, 0.95, 0.12, 6, "steel")
    return _lib_from_group("LIBbo", "bollard")

def _rebase(obj):
    vs = [v.co for v in obj.data.vertices]; mn = Vector([min(v[i] for v in vs) for i in range(3)]); mx = Vector([max(v[i] for v in vs) for i in range(3)])
    off = Vector(((mn.x + mx.x) / 2, (mn.y + mx.y) / 2, mn.z))
    for v in obj.data.vertices: v.co -= off
    return mx - mn
def build_forklift():
    """Sketchfab 'Low poly Forklift Truck' (Kolos Studios, CC-BY 4.0): lies on its side in the file (up = -x, forward = +y, axle = z) -> stand it up, forward = +x,
    and squash the width: the model is chubby (7.0 wide for 10.1 long)."""
    L = AK.load("forklift_kolos", 3000, source="sketchfab", name="forklift", tex=256); ob = L["obj"]
    ob.data.transform(Matrix(((0, 0, -1, 0), (0, -1, 0, 0), (-1, 0, 0, 0), (0, 0, 0, 1))))      # new = (-z, -y, -x) of the importer-fixed raw coords of this file
    ob.data.transform(Matrix.Diagonal((0.27, 0.215, 0.27, 1.0))); dims = _rebase(ob)
    LIBS["forklift"] = ob; TRIS["forklift"] = len(ob.data.polygons); STATS["forklift_dims"] = tuple(round(d, 2) for d in dims); return ob
def build_ph(key, aid, budget, px, sc):
    L = AK.load(aid, budget, source="polyhaven", name=key, tex=px); ob = L["obj"]; LIBS[key] = ob; TRIS[key] = len(ob.data.polygons); return ob

def build_libs():
    for v in range(6): build_door(v)
    for c in CONT_COL: build_container(c)
    build_pallet("wood"); build_load(0); build_load(1); build_bollard()
    for c in ("blue", "container_red", "container_ochre"): build_drum(c)
    build_ph("barrel", "barrel_03", 600, 256, 1.0); build_ph("crate", "wooden_crate_01", 300, 256, 1.4)
    try: build_forklift()
    except Exception as e: print("FORKLIFT FAILED", e); LIBS.pop("forklift", None)

# ================================================================================================ clusters / placement
class Ctx:
    """Collision + occupancy hooks supplied by foundry.py."""
    def __init__(s, col, z): s.col = col; s.Z = z; s.obst = []                      # obst: world AABBs (x0, y0, x1, y1) that props must keep clear of
def _aabb(pts, pad=0.0): xs = [p[0] for p in pts]; ys = [p[1] for p in pts]; return (min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad)
def overlap(a, b): return a[0] < b[2] and a[2] > b[0] and a[1] < b[3] and a[3] > b[1]

def cluster(cx, kind, ax, ay, rot, z, rng):
    """Props of one cluster around anchor (ax, ay); local u along `rot`, t = u rotated by -90 deg (outward of a wall frame). Returns the AABB it fills."""
    col = cx.col; c, s = math.cos(rot), math.sin(rot); w = lambda u, t: (ax + c * u + s * t, ay + s * u - c * t); pts = []
    def at(key, u, t, dz=0.0, drot=0.0, sc=1.0): x, y = w(u, t); _put(key, x, y, z + dz, rot + drot, sc); return x, y
    def cbox(u, t, hu, ht, h, drot=0.0): x, y = w(u, t); col.obox("props", x, y, hu, ht, rot + drot, z - 0.05, z + h); pts.extend([w(u - hu, t - ht), w(u + hu, t + ht), w(u - hu, t + ht), w(u + hu, t - ht)])
    def ccyl(u, t, r, h): x, y = w(u, t); col.cyl("props", x, y, z - 0.05, z + h, r, 8); pts.extend([(x - r, y - r), (x + r, y + r)])
    if kind == "pallets":
        for k in range(rng.choice([1, 2, 2])):
            u = (k - 0.5) * 1.35; d = rng.uniform(-0.12, 0.12); ld = rng.choice([0, 1])
            at(f"load{ld}", u, 1.25, 0, d); cbox(u, 1.25, 0.62, 0.42, 1.05, d)
        if rng.random() < 0.6:
            n = rng.choice([2, 3, 4]); u = 1.5 if rng.random() < 0.5 else -1.5
            for k in range(n): at("pallet", u, 1.15, k * 0.115, rng.uniform(-0.1, 0.1))
            cbox(u, 1.15, 0.62, 0.42, n * 0.115 + 0.05)
    elif kind == "drums":
        n = rng.choice([3, 4, 5]); k = 0
        for a in range(3):
            for b in range(2):
                if k >= n: break
                u = (a - 1) * 0.68 + rng.uniform(-0.05, 0.05); t = 0.9 + b * 0.68 + rng.uniform(-0.05, 0.05); kk = rng.choice(["barrel", "drum_blue", "drum_container_red", "drum_container_ochre", "barrel"])
                at(kk, u, t, 0, rng.uniform(0, 6.28), 0.95 if kk == "barrel" else 1.0); ccyl(u, t, 0.32, 0.92); k += 1
    elif kind == "crates":
        u = rng.uniform(-0.6, 0.6)
        for k in range(rng.choice([2, 3])):
            uu = u + (k - 0.5) * 1.35; d = rng.uniform(-0.12, 0.12); at("crate", uu, 1.0, 0, d, 1.5); cbox(uu, 1.0, 0.62, 0.32, 0.54, d)
            if rng.random() < 0.55: at("crate", uu + rng.uniform(-0.05, 0.05), 1.0, 0.52, d + rng.uniform(-0.2, 0.2), 1.5)
        if rng.random() < 0.5: at("pallet", u - 1.6, 1.0, 0, 0.0); cbox(u - 1.6, 1.0, 0.6, 0.4, 0.14)
    elif kind == "forklift":
        d = rng.choice([0.0, math.pi]); fx = rng.uniform(-0.6, 0.6); at("forklift", fx, 2.35, 0, d + rng.uniform(-0.08, 0.08)); cbox(fx, 2.35, 1.35, 0.75, 1.65, d)
    elif kind == "bollards":
        for u in (-1.5, 1.5): at("bollard", u, 0.8); ccyl(u, 0.8, 0.12, 0.95)
    return _aabb(pts, 0.3) if pts else None

def place_bay_props(cx, BAYS, rects, cells, rng):
    """BAYS: [(frame a, frame r, frame n, u_centre)] of roller doors; a cluster goes in front of a bay when the strip out to 4.6 m is free of buildings / obstacles
    and inside its block. Never in front of the 3 m gaps between lofts (those have no door bays) and never on a road."""
    nb = 0
    for (a, r, n, uc) in BAYS:
        fr = Frame(a, r, n, cx.Z); strip = _aabb([fr.p(uc - 1.9, 0.3, 0), fr.p(uc + 1.9, 4.6, 0)])
        cell = next((c for c in cells if c[0] <= fr.p(uc, 0.1, 0)[0] < c[2] and c[1] <= fr.p(uc, 0.1, 0)[1] < c[3]), None)
        if cell is None or strip[0] < cell[0] + 0.8 or strip[1] < cell[1] + 0.8 or strip[2] > cell[2] - 0.8 or strip[3] > cell[3] - 0.8: continue
        if any(overlap(strip, rr) for rr in rects) or any(overlap(strip, rr) for rr in cx.obst): continue
        if rng.random() > 0.55: continue
        kind = rng.choices(["pallets", "drums", "crates", "forklift", "bollards"], [3, 3, 2, 1.1, 1.2])[0]
        fk = cluster(cx, kind, *fr.p(uc, 0, 0)[:2], math.atan2(r[1], r[0]), cx.Z, rng); nb += 1
        if fk: cx.obst.append(fk)
    return nb

def scatter(cx, rect, n, kinds, weights, rng, margin=2.2, tries=400, clear=2.6, rots=None):
    """Random clusters inside `rect` (x0,y0,x1,y1) avoiding cx.obst; anchors get a random heading. Footprint test = a (2*clear)^2 square around the anchor."""
    done = 0
    for _ in range(tries):
        if done >= n: break
        x = rng.uniform(rect[0] + margin, rect[2] - margin); y = rng.uniform(rect[1] + margin, rect[3] - margin)
        box = (x - clear, y - clear, x + clear, y + clear)
        if any(overlap(box, o) for o in cx.obst): continue
        kind = rng.choices(kinds, weights)[0]; rot = rng.choice(rots or [0.0, math.pi / 2, math.pi, -math.pi / 2]) + rng.uniform(-0.15, 0.15)
        fk = cluster(cx, kind, x, y, rot, cx.Z + 0.02, rng); done += 1
        cx.obst.append(box if fk is None else (min(fk[0], box[0] + 1.0), min(fk[1], box[1] + 1.0), max(fk[2], box[2] - 1.0), max(fk[3], box[3] - 1.0)))
    return done

def bake():
    """Instances -> linked duplicates under inst_<key> Empties (one mesh, N nodes). Returns {key: count}."""
    out = {}; sc = bpy.context.scene
    door_by = {}
    for (v, x, y, z, rot, w) in DOORS: door_by.setdefault(v, []).append((x, y, z, rot, w / DW))
    for v, ps in door_by.items(): PLACE.setdefault(f"door{v}", []).extend([(x, y, z, rot, ("x", s)) for (x, y, z, rot, s) in ps])
    for key, places in PLACE.items():
        lib = LIBS.get(key)
        if lib is None or not places: continue
        root = bpy.data.objects.new(f"inst_{key}", None); sc.collection.objects.link(root)
        for i, (x, y, z, rot, s) in enumerate(places):
            o = lib.copy(); o.data = lib.data; o.name = f"{key}_{i}"; o.location = (x, y, z); o.rotation_euler = (0, 0, rot)
            o.scale = (s[1], 1, 1) if isinstance(s, tuple) else (s, s, s)
            sc.collection.objects.link(o); o.parent = root
        out[key] = len(places)
    for lib in LIBS.values(): bpy.data.objects.remove(lib, do_unlink=True)
    return out

def container(col, x, y, z, along_x=True):
    """Queue a container v2 (door end random: +x or -x) instead of drawing a flat box."""
    _put(f"cont_{col}", x, y, z, (0.0 if _crng.random() < 0.5 else math.pi) + (0.0 if along_x else math.pi / 2))
