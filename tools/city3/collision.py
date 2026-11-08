"""Collision geometry for the walkable bot (runs inside headless Blender 5.2 Python, or plain Python for the maths).

One `Col` collects CLOSED solids (boxes, prisms, cylinders) plus up-facing ground quads, per named bucket, and writes a small
glTF: objects `col_<bucket>`, ONE flat grey material, no normals / UVs / textures / compression (a capsule shapecast ignores
sidedness; the runtime needs nothing else). Same coordinate frame and export axes as the visual GLBs (yup, same origin), so
the two line up exactly. Solids have outward-facing windings (signed volume > 0), checked by `Col.check_closed()`.

Rules the three builders share (see docs/procedural-city/11-collision.md):
  * ground = flat quads at walk_z; NO ground over water (basin ring, outside the quay);
  * every building / hall / tower / stall footprint is a closed extruded solid;
  * hero shops are rooms: floor, facade with a real door gap, side/back walls, ceiling, upper floors as a solid block;
  * the door leaf is never collision."""
import math, os, json

class Col:
    def __init__(s): s.b = {}                                   # bucket -> [verts, faces, vmap]
    def _o(s, n):
        if n not in s.b: s.b[n] = [[], [], {}]
        return s.b[n]
    def _vi(s, o, p):
        k = (round(p[0], 4), round(p[1], 4), round(p[2], 4))
        i = o[2].get(k)
        if i is None: i = o[2][k] = len(o[0]); o[0].append(k)
        return i
    def tri(s, n, a, b, c):
        o = s._o(n); ia, ib, ic = s._vi(o, a), s._vi(o, b), s._vi(o, c)
        if ia != ib and ib != ic and ia != ic: o[1].append((ia, ib, ic))
    def quad(s, n, a, b, c, d): s.tri(n, a, b, c); s.tri(n, a, c, d)
    # ---- ground (up-facing) ----
    def ground_rect(s, n, x0, y0, x1, y1, z): s.quad(n, (x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z))
    # ---- closed solids ----
    def box(s, n, x0, y0, z0, x1, y1, z1):
        if x1 - x0 < 1e-4 or y1 - y0 < 1e-4 or z1 - z0 < 1e-4: return
        q = s.quad
        q(n, (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1))          # +z
        q(n, (x0, y0, z0), (x0, y1, z0), (x1, y1, z0), (x1, y0, z0))          # -z
        q(n, (x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1))          # -y
        q(n, (x1, y1, z0), (x0, y1, z0), (x0, y1, z1), (x1, y1, z1))          # +y
        q(n, (x0, y1, z0), (x0, y0, z0), (x0, y0, z1), (x0, y1, z1))          # -x
        q(n, (x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1))          # +x
    def obox(s, n, cx, cy, hx, hy, rot, z0, z1):
        """Box with half extents (hx, hy) rotated by `rot` (ccw about +z, Blender frame) about its centre."""
        c, sn = math.cos(rot), math.sin(rot)
        s.prism(n, [(cx + c * x - sn * y, cy + sn * x + c * y) for x, y in ((-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy))], z0, z1)
    def prism(s, n, poly, z0, z1):
        """Closed extrusion of a simple polygon (any winding)."""
        poly = list(poly)
        if _area(poly) < 0: poly.reverse()                        # make CCW
        m = len(poly)
        for k in range(m):
            a, b = poly[k], poly[(k + 1) % m]
            s.quad(n, (a[0], a[1], z0), (b[0], b[1], z0), (b[0], b[1], z1), (a[0], a[1], z1))
        for (i, j, k) in _triangulate(poly):
            s.tri(n, (poly[i][0], poly[i][1], z1), (poly[j][0], poly[j][1], z1), (poly[k][0], poly[k][1], z1))
            s.tri(n, (poly[i][0], poly[i][1], z0), (poly[k][0], poly[k][1], z0), (poly[j][0], poly[j][1], z0))
    def cyl(s, n, cx, cy, z0, z1, r, seg=8):
        s.prism(n, [(cx + r * math.cos(2 * math.pi * k / seg), cy + r * math.sin(2 * math.pi * k / seg)) for k in range(seg)], z0, z1)
    def annulus(s, n, cx, cy, r0, r1, z0, z1, seg=32):
        """Closed ring solid between radii r0 < r1 (hollow in the middle)."""
        P = lambda r, k: (cx + r * math.cos(2 * math.pi * k / seg), cy + r * math.sin(2 * math.pi * k / seg))
        for k in range(seg):
            a0, a1 = P(r1, k), P(r1, k + 1); b0, b1 = P(r0, k), P(r0, k + 1)
            s.quad(n, (a0[0], a0[1], z0), (a1[0], a1[1], z0), (a1[0], a1[1], z1), (a0[0], a0[1], z1))      # outer wall
            s.quad(n, (b1[0], b1[1], z0), (b0[0], b0[1], z0), (b0[0], b0[1], z1), (b1[0], b1[1], z1))      # inner wall
            s.quad(n, (b0[0], b0[1], z1), (a0[0], a0[1], z1), (a1[0], a1[1], z1), (b1[0], b1[1], z1))      # top
            s.quad(n, (b0[0], b0[1], z0), (b1[0], b1[1], z0), (a1[0], a1[1], z0), (a0[0], a0[1], z0))      # bottom (normal -z)
    # ---- stats / validation ----
    def stats(s): return {k: (len(v[0]), len(v[1])) for k, v in s.b.items()}
    def check_closed(s, buckets=None, skip=("ground",)):
        """Every edge of every solid bucket is shared by exactly two triangles (per bucket the union of overlapping solids may share
        edges 4x only where solids touch exactly, so we test the signed volume per bucket instead, plus per-edge parity)."""
        bad = []
        for n, (V, F, _) in s.b.items():
            if n in skip or (buckets and n not in buckets): continue
            vol = 0.0; E = {}
            for (a, b, c) in F:
                A, B, C = V[a], V[b], V[c]
                vol += (A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0])) / 6
                for e in ((a, b), (b, c), (c, a)): E[e] = E.get(e, 0) + 1
            open_edges = sum(1 for (a, b), c in E.items() if E.get((b, a), 0) != c)
            if vol <= 0 or open_edges: bad.append((n, round(vol, 1), open_edges))
        return bad
    # ---- export ----
    def export(s, path, name_prefix="col_"):
        import bpy
        mat = bpy.data.materials.new("col_grey"); mat.use_nodes = True
        mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.5, 0.5, 0.5, 1)
        made = []
        for n, (V, F, _) in s.b.items():
            if not F: continue
            me = bpy.data.meshes.new(name_prefix + n); me.from_pydata(V, [], F); me.update(); me.materials.append(mat)
            ob = bpy.data.objects.new(name_prefix + n, me); bpy.context.scene.collection.objects.link(ob); made.append(ob)
        for o in bpy.data.objects: o.select_set(False)
        for o in made: o.select_set(True)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_yup=True, export_apply=True, export_normals=False, export_texcoords=False,
            export_materials="EXPORT", export_image_format="NONE", export_cameras=False, export_lights=False, export_draco_mesh_compression_enable=False,
            export_meshopt_compression_enable=False, use_selection=True)
        for o in made: bpy.data.objects.remove(o, do_unlink=True)
        for me in [m for m in bpy.data.meshes if m.name.startswith(name_prefix)]: bpy.data.meshes.remove(me)
        bpy.data.materials.remove(mat)
        print("COLLISION", os.path.basename(path), os.path.getsize(path) // 1024, "KB", s.stats())

def _area(p): return sum(p[k][0] * p[(k + 1) % len(p)][1] - p[(k + 1) % len(p)][0] * p[k][1] for k in range(len(p))) / 2
def _convex(p):
    sg = 0
    for k in range(len(p)):
        a, b, c = p[k], p[(k + 1) % len(p)], p[(k + 2) % len(p)]
        cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
        if abs(cr) < 1e-9: continue
        if sg == 0: sg = 1 if cr > 0 else -1
        elif (cr > 0) != (sg > 0): return False
    return True
def _triangulate(p):
    """Index triples for a CCW simple polygon (fan when convex, ear clipping otherwise)."""
    n = len(p)
    if n < 3: return []
    if _convex(p): return [(0, k, k + 1) for k in range(1, n - 1)]
    idx = list(range(n)); out = []; guard = 0
    def inside(pt, a, b, c):
        d1 = (pt[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (pt[1] - b[1]); d2 = (pt[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (pt[1] - c[1]); d3 = (pt[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (pt[1] - a[1])
        return not ((d1 < 0 or d2 < 0 or d3 < 0) and (d1 > 0 or d2 > 0 or d3 > 0))
    while len(idx) > 3 and guard < 10000:
        guard += 1; clipped = False
        for k in range(len(idx)):
            i0, i1, i2 = idx[k - 1], idx[k], idx[(k + 1) % len(idx)]; a, b, c = p[i0], p[i1], p[i2]
            if (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) <= 1e-12: continue
            if any(inside(p[j], a, b, c) for j in idx if j not in (i0, i1, i2)): continue
            out.append((i0, i1, i2)); idx.pop(k); clipped = True; break
        if not clipped: break
    if len(idx) == 3: out.append(tuple(idx))
    return out

def quay(c, L, Z, gaps=(), gap=10.5, thick=1.0, top=1.5):
    """Closed 1.5 m wall around a square island (|x|,|y| <= L). `gaps`: sides ('S','E','N','W') where a bridge lands; the wall stops |t| < gap there."""
    h = Z + top
    def seg(side, t0, t1):
        if t1 - t0 < 1e-3: return
        if side == "S": c.box("quay", t0, -L - thick, -3, t1, -L, h)
        elif side == "N": c.box("quay", t0, L, -3, t1, L + thick, h)
        elif side == "W": c.box("quay", -L - thick, t0, -3, -L, t1, h)
        else: c.box("quay", L, t0, -3, L + thick, t1, h)
    for side in "SENW":
        if side in gaps: seg(side, -L - thick, -gap); seg(side, gap, L + thick)
        else: seg(side, -L - thick, L + thick)

def finish(c, path):
    """Validate (every solid bucket closed, outward) and write the GLB."""
    bad = c.check_closed()
    if bad: raise SystemExit(f"collision: NOT closed: {bad}")
    c.export(path)

# ======================================================================================= Bazaar (City 3)
WALK_STEP = 0.28            # hero doorstep / floor height above walk_z (hero.py: f = 0.28, relative to the frame's z0 = walk_z)
DOOR_W, DOOR_H, WALL_T = 1.7, 2.9, 0.3      # same numbers as hero.py (opening width, soffit, wall thickness)

def frame_aabb(fr, u0, u1, t0, t1):
    """World (x0, y0, x1, y1) of a wall-local rectangle (the frames are axis-aligned)."""
    a = fr.xy(u0, t0); b = fr.xy(u1, t1)
    return min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])

def hero_room(c, fr, W, D, GH, H, door_u, tag="heroes"):
    """One hero shop as a walkable ROOM (frame coords u along the facade, t out of it; z relative to walk_z)."""
    T = WALL_T; f = WALK_STEP; Zb = fr.z0
    def fb(u0, u1, t0, t1, z0, z1):
        x0, y0, x1, y1 = frame_aabb(fr, u0, u1, t0, t1); c.box(tag, x0, y0, Zb + z0, x1, y1, Zb + z1)
    lo, hi = door_u - DOOR_W / 2, door_u + DOOR_W / 2
    fb(0, lo, -T, 0, -0.3, GH); fb(hi, W, -T, 0, -0.3, GH)                      # facade either side of the door gap
    fb(lo, hi, -T, 0, DOOR_H, GH)                                               # lintel above the gap (soffit 2.9 m)
    fb(0, T, -D, 0, -0.3, GH); fb(W - T, W, -D, 0, -0.3, GH)                    # side walls (the party-wall shell)
    fb(T, W - T, -D, -D + T, -0.3, GH)                                          # back wall
    fb(T, W - T, -D + T, -T, -0.3, f)                                           # floor (top at +0.28)
    fb(lo, hi, -T, 0, -0.3, f)                                                  # threshold through the wall
    fb(door_u - 1.3, door_u + 1.3, 0, 0.85, -0.3, f)                            # stoop
    fb(0, W, -D, 0, GH, H)                                                      # ceiling slab + all upper floors as one block

def bazaar(ctx, out_path):
    """ctx: P (plan), GH, FH, HERO_INFO, BENCHES, SKP (placed Sketchfab props), SKDIM, PARTY, PT_DIMS, MEDSTALLS."""
    P = ctx["P"]; Z = P["walk_z"]; L = P["land"]; GH = ctx["GH"]; FH = ctx["FH"]; c = Col()
    px0, py0, px1, py1 = P["plaza"]; fo = P["fountain"]; Rf = fo["r_out"] + 0.5
    def in_plaza(r): return r[0] >= px0 - 0.01 and r[1] >= py0 - 0.01 and r[2] <= px1 + 0.01 and r[3] <= py1 + 0.01
    # ---- ground: sidewalks, roads, plaza minus the fountain footprint. Parks / courtyards sit 6-10 cm above and are not separate ground.
    for b in P["blocks"]:
        if not in_plaza(b["rect"]): c.ground_rect("ground", *b["rect"], Z)
    SEG = [(-L, -135), (-125, -70), (-60, -10), (10, 60), (70, 125), (135, L)]
    for s in P["streets"]:
        cc, w = s["c"], s["w"]
        for (a, bb) in SEG:
            r = (cc - w / 2, a, cc + w / 2, bb)
            if not in_plaza(r): c.ground_rect("ground", *r, Z)
            r2 = (a, cc - w / 2, bb, cc + w / 2)
            if not in_plaza(r2): c.ground_rect("ground", *r2, Z)
    for sx in P["streets"]:
        for sy in P["streets"]:
            r = (sx["c"] - sx["w"] / 2, sy["c"] - sy["w"] / 2, sx["c"] + sx["w"] / 2, sy["c"] + sy["w"] / 2)
            if not in_plaza(r): c.ground_rect("ground", *r, Z)
    N = 32; half = px1                                                          # plaza square (centred on the origin) with the fountain disc cut out
    def sq(a):
        co, si = math.cos(a), math.sin(a); s = half / max(abs(co), abs(si)); return (s * co, s * si)
    for k in range(N):
        a0, a1 = 2 * math.pi * k / N, 2 * math.pi * (k + 1) / N
        i0 = (Rf * math.cos(a0), Rf * math.sin(a0)); i1 = (Rf * math.cos(a1), Rf * math.sin(a1)); o0, o1 = sq(a0), sq(a1)
        c.quad("ground", (i0[0], i0[1], Z), (o0[0], o0[1], Z), (o1[0], o1[1], Z), (i1[0], i1[1], Z))      # ccw seen from above
    # ---- quay: closed wall around the island, 1.5 m high, so nobody walks off into the water; open only where the four bridges land (|t| < 10.5)
    quay(c, L, Z, gaps="SENW")
    # ---- buildings, halls, towers
    hero_bd = {id(hi["bd"]): hid for hid, hi in ctx["HERO_INFO"].items()}
    for bd in P["buildings"]:
        n = bd["floors"]; H = GH + (n - 1) * FH
        if id(bd) in hero_bd:
            hi = ctx["HERO_INFO"][hero_bd[id(bd)]]; hero_room(c, hi["fr"], hi["W"], hi["D"], GH, H, hi["door_u"])
        else:
            x0, y0, x1, y1 = bd["rect"]; c.box("buildings", x0, y0, Z - 0.3, x1, y1, Z + H)
    for hl in P["halls"]: x0, y0, x1, y1 = hl["rect"]; c.box("buildings", x0, y0, Z - 0.3, x1, y1, Z + hl["h"])
    for t in P["towers"]: x0, y0, x1, y1 = t["rect"]; c.box("buildings", x0, y0, Z - 0.3, x1, y1, Z + t["h"])
    # ---- stalls (footprint = counter + posts; canopy height)
    for i, st in enumerate(P["stalls"]):
        cx, cy = st["c"]; w, d = st["size"]; hx, hy = (1.55, 0.9) if i in ctx["MEDSTALLS"] else (w / 2, d / 2)
        c.box("stalls", cx - hx, cy - hy, Z - 0.1, cx + hx, cy + hy, Z + 2.9)
    # ---- fountain: raised stone disc (r < r_in, +0.9) and the rim ring (r_out - 0.3 .. r_out + 0.5); the water ring between has NO ground
    c.cyl("fountain", 0, 0, Z - 0.3, Z + 0.9, fo["r_in"], 32)
    c.annulus("fountain", 0, 0, fo["r_out"] - 0.3, fo["r_out"] + 0.5, Z - 0.3, Z + 0.9, 32)
    from fountain_garden import planter_positions
    for x, y in planter_positions(fo["r_out"]):
        c.cyl("fountain_planters", x, y, Z - 0.01, Z + 0.72, 0.66, 16)
    # ---- props: benches / crates / pots (placed Sketchfab props), plaza planters + tree trunks, lamps, festoon poles, party tables
    for (nm, x, y, z, rot) in ctx["SKP"]:
        if nm not in ("med_bench", "med_crate", "pot"): continue
        dx, dy, dz = ctx["SKDIM"][nm]; c.obox("props", x, y, dx / 2, dy / 2, rot, z, z + dz)
    for t_ in range(-52, 53, 13):
        for (x, y) in ((t_, -57.0), (t_, 57.0), (-57.0, t_), (57.0, t_)):
            if abs(t_) < 8: continue
            c.box("props", x - 0.9, y - 0.9, Z - 0.1, x + 0.9, y + 0.9, Z + 0.5); c.cyl("props", x, y, Z + 0.4, Z + 3.0, 0.2, 6)
    for (x, y) in P["trees"]: c.cyl("props", x, y, Z - 0.1, Z + 3.0, 0.2, 6)
    for (lx, ly) in P["lamps"]:
        if abs(lx) < 58 and abs(ly) < 58: continue
        c.cyl("props", lx, ly, Z - 0.1, Z + 4.0, 0.12, 6)
    for k in range(8):
        a = 2 * math.pi * k / 8 + math.pi / 8; c.cyl("props", 22 * math.cos(a), 22 * math.sin(a), Z - 0.1, Z + 6.0, 0.12, 6)
    for (x, y, rot, _, _) in ctx["PARTY"]:
        dx, dy, dz = ctx["PT_DIMS"]; c.obox("props", x, y, dx / 2, dy / 2, rot, Z, Z + dz)
    finish(c, out_path)
    return c
