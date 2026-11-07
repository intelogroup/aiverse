"""Pure-python (numpy) checks of the collision GLBs against the plans.   python3 check_collision.py [city3 glassq foundry terraces halo links]   (default: every GLB that exists)

city3:  closed solids (every directed edge has its reverse, signed volume > 0), size <= 400 KB, every footprint (building / hall / tower / stall / hero shell)
        is covered by a solid, hero doors are open at DOOR_W x DOOR_H with the jambs and lintel solid, hero rooms are open inside (floor at +0.28, ceiling at the
        ground-floor height), ground has no holes outside the fountain, the quay wall stops a walker, the spawn ring 0..40 m around the plaza is clear of
        every non-prop solid, and the furniture sidecars (interiors/*.col.json) never cover a seat approach point nor the door path.
districts: closed solids, size, every plan footprint covered, ground present on the street grid.
Exit status 1 on any failure."""
import json, math, os, random, struct, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); OUT = f"{HERE}/out"
FAILS = []
def fail(msg): FAILS.append(msg); print("  FAIL", msg)
def ok(msg): print("  ok  ", msg)

def load_glb(path):
    """-> {object name: (V float64 (n,3) in three space, F int (m,3))}"""
    b = open(path, "rb").read(); assert b[:4] == b"glTF"
    jl, _ = struct.unpack_from("<II", b, 12); j = json.loads(b[20:20 + jl]); off = 20 + jl + 8; bin_ = b[off:]
    def acc(i):
        a = j["accessors"][i]; bv = j["bufferViews"][a["bufferView"]]; dt = {5126: "<f4", 5123: "<u2", 5125: "<u4"}[a["componentType"]]; nc = {"VEC3": 3, "SCALAR": 1}[a["type"]]
        o = bv.get("byteOffset", 0) + a.get("byteOffset", 0); return np.frombuffer(bin_, dtype=dt, count=a["count"] * nc, offset=o).reshape(-1, nc)
    out = {}
    for n in j["nodes"]:
        if "mesh" not in n: continue
        V, F = [], []; base = 0
        for p in j["meshes"][n["mesh"]]["primitives"]:
            v = acc(p["attributes"]["POSITION"]).astype(np.float64); f = acc(p["indices"])[:, 0].reshape(-1, 3).astype(np.int64) + base; V.append(v); F.append(f); base += len(v)
        out[n["name"]] = (np.vstack(V), np.vstack(F))
    return out

class World:
    """Triangle soup in three space with per-triangle object ids; first-hit ray casts (Moller-Trumbore, vectorised)."""
    def __init__(s, objs):
        s.names = list(objs); T = []; ids = []
        for i, n in enumerate(s.names):
            V, F = objs[n]; T.append(V[F]); ids += [i] * len(F)
        s.T = np.concatenate(T); s.ids = np.array(ids)
        s.v0 = s.T[:, 0]; s.e1 = s.T[:, 1] - s.T[:, 0]; s.e2 = s.T[:, 2] - s.T[:, 0]
    def first_hit(s, o, d, tmax=1e9):
        """-> (t, tri index, front_facing) or None; o, d in three space."""
        o = np.asarray(o, float); d = np.asarray(d, float)
        h = np.cross(d, s.e2); a = np.einsum("ij,ij->i", s.e1, h); m = np.abs(a) > 1e-12
        f = np.zeros_like(a); f[m] = 1.0 / a[m]; sv = o - s.v0; u = f * np.einsum("ij,ij->i", sv, h)
        q = np.cross(sv, s.e1); v = f * (q @ d); t = f * np.einsum("ij,ij->i", s.e2, q)
        hit = m & (u >= -1e-9) & (v >= -1e-9) & (u + v <= 1 + 1e-9) & (t > 1e-7) & (t < tmax)
        if not hit.any(): return None
        idx = np.nonzero(hit)[0]; k = idx[np.argmin(t[idx])]; return float(t[k]), int(k), bool(a[k] > 0)    # a = -d.n: a>0 means the ray runs against the normal = front face
    def inside(s, p, solids_only=None):
        """True when the first hit along some axis ray is a BACK face (the point is inside a closed solid)."""
        for d in ((1, 0, 0), (-1, 0, 0), (0, 0, 1), (0, 0, -1), (0, 1, 0), (0, -1, 0)):
            h = s.first_hit(p, d)
            if h and not h[2]: return s.names[s.ids[h[1]]]
        return None
    def ground_y(s, x, z, y0):
        h = s.first_hit((x, y0, z), (0, -1, 0)); return None if h is None else y0 - h[0]
    def ground_obj(s, x, z, y0):
        h = s.first_hit((x, y0, z), (0, -1, 0)); return None if h is None else s.names[s.ids[h[1]]]

def tz(x, y): return x, -y            # plan (blender x, y) -> three (x, z)
def closed_report(objs, skip=("col_ground",)):
    bad = []; tris = 0
    for n, (V, F) in objs.items():
        tris += len(F)
        if n in skip: continue
        W = np.round(V, 4); _, inv = np.unique(W, axis=0, return_inverse=True); inv = inv.reshape(-1); G = inv[F]
        vol = np.einsum("ij,ij->", V[F][:, 0], np.cross(V[F][:, 1], V[F][:, 2])) / 6
        e = np.concatenate([G[:, [0, 1]], G[:, [1, 2]], G[:, [2, 0]]]); fw = {}
        for a, b in map(tuple, e): fw[(a, b)] = fw.get((a, b), 0) + 1
        open_e = sum(1 for (a, b), c in fw.items() if fw.get((b, a), 0) != c)
        # three space flips handedness vs Blender (y -> -z), so a closed outward solid has NEGATIVE signed volume here? (x,y,z)->(x,z,-y) is a proper rotation: volume stays > 0
        if open_e or vol <= 0: bad.append((n, round(float(vol), 1), open_e))
    return bad, tris

def check_size(path, limit=400):
    kb = os.path.getsize(path) / 1024; (ok if kb <= limit else fail)(f"{os.path.basename(path)} {kb:.0f} KB (limit {limit})")

def city3():
    path = f"{OUT}/world-city3-collision.glb"
    if not os.path.exists(path): return print("skip city3 (no GLB)")
    print("city3"); P = json.load(open(f"{HERE}/plan.json")); Z = P["walk_z"]; objs = load_glb(path); check_size(path)
    assert all(n.startswith("col_") for n in objs), "every object must be prefixed col_"
    bad, tris = closed_report(objs); (fail if bad else ok)(f"closed solids ({tris} tris, {len(objs)} objects)" if not bad else f"not closed: {bad}")
    W = World(objs); heroes = {r["id"]: r for r in json.load(open(f"{OUT}/heroes.json"))}
    hero_rects = {tuple(r["rect"]) for r in heroes.values()}
    def hero_rect_blender(r): x0, z0, x1, z1 = r["rect"]; return (x0, -z1, x1, -z0)             # index rect is [x0, -y1, x1, -y0]
    hero_b = {tuple(round(v, 2) for v in hero_rect_blender(r)): hid for hid, r in heroes.items()}
    # ---- footprints covered
    miss = []; n = 0
    def cover(label, x, y, z=None, cx=None, cy=None):
        nonlocal n
        for (px, py) in ((x, y),):
            n += 1; p = (px, (Z + 1.0) if z is None else z, -py)
            if W.inside(p) is None: miss.append((label, round(px, 2), round(py, 2)))
    for i, bd in enumerate(P["buildings"]):
        x0, y0, x1, y1 = bd["rect"]; key = (x0, y0, x1, y1)
        if key in hero_b: continue
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        for (x, y) in ((x0 + .1, y0 + .1), (x1 - .1, y0 + .1), (x1 - .1, y1 - .1), (x0 + .1, y1 - .1), (cx, cy)): cover(f"building {i}", x, y)
    for i, h in enumerate(P["halls"]):
        x0, y0, x1, y1 = h["rect"]; cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        for (x, y) in ((x0 + .1, y0 + .1), (x1 - .1, y1 - .1), (cx, cy)): cover(f"hall {i}", x, y)
    for i, h in enumerate(P["towers"]):
        x0, y0, x1, y1 = h["rect"]; cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        for (x, y) in ((x0 + .1, y0 + .1), (x1 - .1, y1 - .1), (cx, cy)): cover(f"tower {i}", x, y)
    for i, s in enumerate(P["stalls"]):
        cx, cy = s["c"]; w, d = s["size"]; med = random.Random(4000 + i).random() < 0.35; hx, hy = (1.55, 0.9) if med else (w / 2, d / 2)
        for (x, y) in ((cx - hx + .1, cy - hy + .1), (cx + hx - .1, cy + hy - .1), (cx, cy)): cover(f"stall {i}", x, y, Z + 1.0)
    f = P["fountain"]
    for (x, y) in ((0, 0), (f["r_in"] - .3, 0), (0, -(f["r_in"] - .3)), (f["r_out"] + .3, 0), (0, f["r_out"] + .3), (f["r_out"] - .1, 0)): cover("fountain", x, y, Z + 0.5)
    (fail if miss else ok)(f"{n} footprint probes inside a solid" if not miss else f"{len(miss)}/{n} footprint probes NOT covered: {miss[:6]}")
    # ---- fountain basin has no ground between the disc and the ring
    g = W.ground_y(8.0, 0.0, Z + 3); (ok if g is None or g < Z - 0.5 else fail)(f"basin water ring has no ground (hit {g})")
    # ---- hero rooms: door gap, jambs, lintel, open room, floor, ceiling
    GH = 4.2; T = 0.3; DW, DH, FL = 1.7, 2.9, 0.28; bad_door = []; bad_room = []
    for hid, r in heroes.items():
        x0, y0, x1, y1 = hero_rect_blender(r); face = r["front"]; dx, dz = r["door"]; dxb, dyb = dx, -dz
        inward = {"S": (0, 1), "N": (0, -1), "E": (-1, 0), "W": (1, 0)}[face]; tang = (-inward[1], inward[0]) if True else None
        wdt = (x1 - x0) if face in "SN" else (y1 - y0); dep = (y1 - y0) if face in "SN" else (x1 - x0)
        def pt(u, t, z): return (dxb + tang[0] * u - inward[0] * t, z, -(dyb + tang[1] * u - inward[1] * t))     # u along the facade, t outward (+) / inward (-)
        d3 = (inward[0], 0, -inward[1])
        blocked = 0
        for u in np.arange(-DW / 2 + 0.07, DW / 2 - 0.06, 0.1):
            for z in np.arange(Z + FL + 0.04, Z + DH - 0.04, 0.15):
                h = W.first_hit(pt(u, 1.5, z), d3, tmax=1.5 + min(3.0, dep - 1.0))
                if h: blocked += 1
        if blocked: bad_door.append((hid, "gap blocked", blocked))
        for u in (-DW / 2 - 0.12, DW / 2 + 0.12):                                    # jambs must be solid right beside the gap
            h = W.first_hit(pt(u, 1.0, Z + 1.5), d3, tmax=1.2)
            if not h: bad_door.append((hid, "no jamb at", u))
        if not (W.inside(pt(0, -T / 2, Z + DH + 0.15))): bad_door.append((hid, "no lintel"))
        c = pt(0, -dep / 2, Z + FL + 1.0)                                              # room centre
        who = W.inside(c)
        if who: bad_room.append((hid, "room centre inside solid", who))
        gy = W.ground_y(c[0], c[2], Z + FL + 1.0)
        if gy is None or abs(gy - (Z + FL)) > 0.02: bad_room.append((hid, "floor", gy))
        up = W.first_hit(c, (0, 1, 0))
        if up is None or abs(c[1] + up[0] - (Z + GH)) > 0.05: bad_room.append((hid, "ceiling", None if up is None else round(c[1] + up[0], 2)))
    (fail if bad_door else ok)(f"{len(heroes)} hero door gaps open {DW} x {DH} m with solid jambs + lintel" if not bad_door else f"door problems: {bad_door[:6]}")
    (fail if bad_room else ok)(f"{len(heroes)} hero rooms: open inside, floor +{FL}, ceiling {GH}" if not bad_room else f"room problems: {bad_room[:6]}")
    # ---- ground: no holes outside the fountain disc
    holes = []
    for x in np.arange(-P["land"] + 2, P["land"] - 1, 4.0):
        for y in np.arange(-P["land"] + 2, P["land"] - 1, 4.0):
            if math.hypot(x, y) < f["r_out"] + 1.0: continue
            gy = W.ground_y(float(x), float(-y), Z + 2.0)
            if (gy is None or abs(gy - Z) > 0.35) and W.ground_obj(float(x), float(-y), Z + 2.0) not in ("col_props", "col_stalls"): holes.append((float(x), float(y), gy))
    (fail if holes else ok)("island ground has no holes (4 m grid)" if not holes else f"{len(holes)} ground holes e.g. {holes[:5]}")
    # ---- quay
    qbad = 0
    for k in range(-170, 171, 20):
        if abs(k) < 12: continue                                                      # bridge landings
        for (o, d) in (((P["land"] - 1, k), (1, 0)), ((-P["land"] + 1, k), (-1, 0)), ((k, P["land"] - 1), (0, 1)), ((k, -P["land"] + 1), (0, -1))):
            h = W.first_hit((o[0], Z + 0.8, -o[1]), (d[0], 0, -d[1]), tmax=2.0)
            if not h or h[0] > 1.5: qbad += 1
    (fail if qbad else ok)("quay wall stops a walker on all four sides" if not qbad else f"{qbad} quay rays pass")
    # ---- spawn area: ring 14..40 m around the plaza centre, clear of every non-prop solid; r 16 and 20 fully clear
    nonprop = {i for i, nme in enumerate(W.names) if nme != "col_props"}; tot = clear = 0; spawn_bad = []
    for r in np.arange(14.0, 40.1, 2.0):
        for a in np.arange(0, 360, 10):
            x, y = r * math.cos(math.radians(a)), r * math.sin(math.radians(a)); tot += 1
            who = W.inside((x, Z + 1.0, -y)); gy = W.ground_y(x, -y, Z + 2.0)
            if who is None and gy is not None and abs(gy - Z) < 0.05: clear += 1
            elif who not in ("col_props", "col_stalls") and (who is not None or gy is None): spawn_bad.append((round(r), int(a), who, gy))
            if r in (16.0, 20.0) and who: spawn_bad.append((round(r), int(a), "ring must be fully clear", who))
    (fail if spawn_bad else ok)(f"spawn ring 14-40 m: {clear}/{tot} probes free, none inside a building/fountain/quay solid (stalls + props may stand there), r16/r20 fully clear" if not spawn_bad else f"spawn problems: {spawn_bad[:6]}")
    furniture(heroes, P)

def furniture(heroes, P):
    anchors = json.load(open(f"{OUT}/hero-anchors.json"))["anchors"]; CL = 0.40; probs = []; nb = 0; ni = 0
    def local(b, x, z):
        cx, cz, hx, hz, y0, y1, rot = b; dx, dz = x - cx, z - cz; c, s = math.cos(rot), math.sin(rot)
        return dx * c - dz * s, dx * s + dz * c        # three rotY=rot maps local (1,0,0) to (cos,0,-sin): inverse of that rotation
    def dist(b, x, z):
        lx, lz = local(b, x, z); return math.hypot(max(abs(lx) - b[2], 0), max(abs(lz) - b[3], 0))
    for hid, r in heroes.items():
        col = json.load(open(f"{OUT}/interiors/{hid}.col.json")); B = col["boxes"]; nb += len(B)
        for a in anchors:
            if a["building"] != hid: continue
            ax, az = a["approach"]
            for b in B:
                d = dist(b, ax, az)
                if d < CL - 1e-3: probs.append((hid, a["id"], "box within %.2f of approach" % d, b))
        x0, z0, x1, z1 = r["rect"]
        for ia in r.get("interactables", []):                  # usable props: the stand point must be open floor inside the room
            sx, sz = ia["stand"]
            if not (x0 + 0.6 < sx < x1 - 0.6 and z0 + 0.6 < sz < z1 - 0.6): probs.append((hid, ia["id"], "stand point near/outside wall"))
            for b in B:
                d = dist(b, sx, sz)
                if d < CL - 1e-3: probs.append((hid, ia["id"], "box within %.2f of stand point" % d, b))
            ni += 1
        for b in B:
            if not (x0 - .02 <= b[0] <= x1 + .02 and z0 - .02 <= b[1] <= z1 + .02): probs.append((hid, "box centre outside its room", b))
        # door path: 1.7 m wide, 3 m deep from the door inward (three space; inward from `front`)
        dx, dz = r["door"]; face = r["front"]; ix, iz = {"S": (0, -1), "N": (0, 1), "E": (-1, 0), "W": (1, 0)}[face]       # inward in three (z = -y)
        for k in range(0, 31):
            for s in np.arange(-0.85, 0.86, 0.17):
                px, pz = dx + ix * k * 0.1 + (-iz) * s, dz + iz * k * 0.1 + ix * s
                for b in B:
                    lx, lz = local(b, px, pz)
                    if abs(lx) < b[2] - 1e-3 and abs(lz) < b[3] - 1e-3 and b[4] < col["floorY"] + 1.8: probs.append((hid, "door path inside box", b)); break
    (fail if probs else ok)(f"{nb} furniture boxes in {len(heroes)} rooms: approach points >= {CL} m clear ({ni} interactable stand points too), door path free" if not probs else f"furniture problems ({len(probs)}): {probs[:5]}")

def district(name):
    path = f"{OUT}/world-{name}-collision.glb"
    if not os.path.exists(path): return print(f"skip {name} (no GLB)")
    print(name); objs = load_glb(path); check_size(path)
    assert all(n.startswith("col_") for n in objs), "every object must be prefixed col_"
    bad, tris = closed_report(objs); (fail if bad else ok)(f"closed solids ({tris} tris, {len(objs)} objects)" if not bad else f"not closed: {bad}")
    W = World(objs); P = json.load(open(f"{OUT}/{name}-plan.json")) if name != "links" else None; Z = 0.2
    if name != "links":
        miss = []; n = 0
        for b in P["buildings"]:
            if "poly" in b:
                poly = b["poly"]; cx = sum(p[0] for p in poly) / len(poly); cy = sum(p[1] for p in poly) / len(poly)
                pts = [(cx, cy)] + [(cx + (p[0] - cx) * 0.93, cy + (p[1] - cy) * 0.93) for p in poly]
            else:
                cx, cy = b["center"]; r = b["radius"]; pts = [(cx, cy), (cx + r * .5, cy), (cx - r * .5, cy), (cx, cy + r * .5), (cx, cy - r * .5)]
            for (x, y) in pts:
                n += 1
                if W.inside((x, Z + 1.0, -y)) is None: miss.append((b["id"], round(x, 1), round(y, 1)))
        (fail if miss else ok)(f"{n} footprint probes inside a solid" if not miss else f"{len(miss)}/{n} NOT covered: {miss[:6]}")
        L = P["land"]; qbad = 0
        for k in range(-int(L) + 10, int(L) - 9, 30):
            if abs(k) < 12: continue                                                  # bridge landing
            for (o, d) in (((L - 1, k), (1, 0)), ((-L + 1, k), (-1, 0)), ((k, L - 1), (0, 1)), ((k, -L + 1), (0, -1))):
                gy = W.ground_y(o[0], -o[1], Z + 2.0)
                if gy is None: continue                                              # no ground there (water side / Halo's curved shore): fine
                h = W.first_hit((o[0], Z + 0.8, -o[1]), (d[0], 0, -d[1]), tmax=3.0)
                if not h: qbad += 1
        allow = 9 if name == "halo" else 0                                                  # Halo: nine walkable piers leave gaps
        (fail if qbad > allow else ok)("island edge has a wall wherever there is ground (halo: piers excepted)" if not qbad else f"{qbad} edge rays escape")
    else:
        for (x, y) in ((0, 200), (0, -200), (200, 0), (-200, 0)):
            gy = W.ground_y(x, -y, Z + 2.0); (ok if gy is not None and abs(gy - Z) < 0.05 else fail)(f"bridge deck at ({x},{y}): {gy}")

if __name__ == "__main__":
    which = sys.argv[1:] or ["city3", "glassq", "foundry", "terraces", "halo", "links"]
    for w in which: city3() if w == "city3" else district(w)
    print("FAILED" if FAILS else "ALL OK", len(FAILS), "failures"); sys.exit(1 if FAILS else 0)
