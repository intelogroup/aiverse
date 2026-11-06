"""Furniture collision sidecars for the Bazaar hero rooms: out/interiors/<id>.col.json (runs inside build_city.py, after the placements are resolved).

Boxes are in the SAME three.js space as out/interiors/<id>.json: [cx, cz, hx, hz, y0, y1, rotY] (cz = -blender_y, rotY = the placement's yaw,
hx/hz = half extents along the box's local x / z, y0..y1 absolute heights). Footprints come from the measured `dims` of the CC0 library props
(assets_kit.LIB) and from the vertex bounds of the procedural pieces (rooms.py / press.py -> kit.MBS "LIB_<name>::*"). Nothing the bot must
reach is boxed over: every seat approach point (kit.ANCHORS) keeps CLEAR m between itself and every box (boxes get trimmed on that side;
a box that COVERS an approach point is a hard error) and the straight door path (opening width, 3 m deep) must be box-free.
Extra keys: `seats` ([x, z] of each seat, for a runtime that wants to relax the seat furniture while somebody sits), `floorY`."""
import json, math, os
import kit, assets_kit
from collision import WALK_STEP, DOOR_W

CLEAR = 0.40            # walker capsule radius (walker.ts / 10-walker.md): the approach point stays this far from every box
DOOR_DEPTH = 3.0
SKIP = {"rug_6x4", "rug_4x3", "lantern_hang", "menu_board", "frames_wall", "newspaper_line", "wall_clock", "books_a", "books_b", "books_c", "paper_stack",
        "desk_lamp_arm_01", "binder_notebook", "vintage_radio_transceiver", "book_encyclopedia_set_01", "CashRegister_01", "ceramic_pot", "brass_goblets",
        "metal_jug", "vintage_oil_lamp"}

# procedural pieces whose vertex bounds overstate the solid part (the press's slanted feed board is a flat sheet the clerk stands against)
OVERRIDE = {"press_machine": (-1.75, -0.9, 0.0, 1.85, 0.9, 2.0)}
_PB = {}
def piece_bounds(key):
    """(minx, miny, minz, maxx, maxy, maxz) in the asset's local Blender frame, or None."""
    if key in _PB: return _PB[key]
    r = OVERRIDE.get(key)
    if r: _PB[key] = r; return r
    if key in assets_kit.LIB:                                             # imported CC0 asset: origin = bottom centre
        dx, dy, dz = assets_kit.LIB[key]["dims"]; r = (-dx / 2, -dy / 2, 0.0, dx / 2, dy / 2, dz)
    else:
        vs = [v for k, b in kit.MBS.items() if k.startswith(f"LIB_{key}::") for v in b.v]
        if vs: r = tuple(min(v[i] for v in vs) for i in range(3)) + tuple(max(v[i] for v in vs) for i in range(3))
    _PB[key] = r; return r

def _rot(x, y, a): c, s = math.cos(a), math.sin(a); return x * c - y * s, x * s + y * c

class Box:
    """Blender-frame oriented box: centre (cx, cy), yaw, local extents relative to the centre."""
    def __init__(s, cx, cy, rot, lx0, lx1, ly0, ly1, z0, z1, key): s.cx, s.cy, s.rot, s.lx0, s.lx1, s.ly0, s.ly1, s.z0, s.z1, s.key = cx, cy, rot, lx0, lx1, ly0, ly1, z0, z1, key
    def local(s, x, y): return _rot(x - s.cx, y - s.cy, -s.rot)
    def dist(s, x, y):
        qx, qy = s.local(x, y); return math.hypot(max(s.lx0 - qx, 0, qx - s.lx1), max(s.ly0 - qy, 0, qy - s.ly1))
    def covers(s, x, y):
        qx, qy = s.local(x, y); return s.lx0 < qx < s.lx1 and s.ly0 < qy < s.ly1
    def corners(s): return [(s.cx + _rot(x, y, s.rot)[0], s.cy + _rot(x, y, s.rot)[1]) for x, y in ((s.lx0, s.ly0), (s.lx1, s.ly0), (s.lx1, s.ly1), (s.lx0, s.ly1))]
    def trim_for(s, x, y):
        """Pull one side in so (x, y) is CLEAR away; False if that would leave a sliver."""
        qx, qy = s.local(x, y); best = None
        for side, nv in (("lx1", qx - CLEAR), ("lx0", qx + CLEAR), ("ly1", qy - CLEAR), ("ly0", qy + CLEAR)):
            lx0, lx1, ly0, ly1 = s.lx0, s.lx1, s.ly0, s.ly1
            if side == "lx1": lx1 = nv
            elif side == "lx0": lx0 = nv
            elif side == "ly1": ly1 = nv
            else: ly0 = nv
            if lx1 - lx0 < 0.1 or ly1 - ly0 < 0.1: continue
            if (side in ("lx1", "ly1") and nv > (s.lx1 if side == "lx1" else s.ly1)) or (side in ("lx0", "ly0") and nv < (s.lx0 if side == "lx0" else s.ly0)): continue
            a = (lx1 - lx0) * (ly1 - ly0)
            if best is None or a > best[0]: best = (a, lx0, lx1, ly0, ly1)
        if not best: return False
        s.lx0, s.lx1, s.ly0, s.ly1 = best[1:]; return True
    def trim_door(s, poly, min_size=0.15):
        """Pull the best side in (0.02 m steps) until the box no longer touches the door corridor; False -> drop the box."""
        best = None; o = (s.lx0, s.lx1, s.ly0, s.ly1)
        for side in range(4):
            for k in range(1, 400):
                v = list(o); d = 0.02 * k
                if side == 0: v[0] = o[0] + d
                elif side == 1: v[1] = o[1] - d
                elif side == 2: v[2] = o[2] + d
                else: v[3] = o[3] - d
                if v[1] - v[0] < min_size or v[3] - v[2] < min_size: break
                t = Box(s.cx, s.cy, s.rot, v[0], v[1], v[2], v[3], s.z0, s.z1, s.key)
                if not _sat(poly, t.corners()):
                    a = (v[1] - v[0]) * (v[3] - v[2])
                    if best is None or a > best[0]: best = (a, v)
                    break
        if not best: return False
        s.lx0, s.lx1, s.ly0, s.ly1 = best[1]; return True
    def out(s):
        mx, my = (s.lx0 + s.lx1) / 2, (s.ly0 + s.ly1) / 2; ox, oy = _rot(mx, my, s.rot)
        return [round(s.cx + ox, 3), round(-(s.cy + oy), 3), round((s.lx1 - s.lx0) / 2, 3), round((s.ly1 - s.ly0) / 2, 3), round(s.z0, 3), round(s.z1, 3), round(s.rot, 4)]

def _sat(pa, pb):
    """Convex polygon overlap (strict)."""
    for poly in (pa, pb):
        for k in range(len(poly)):
            ax, ay = poly[k]; bx, by = poly[(k + 1) % len(poly)]; nx, ny = ay - by, bx - ax
            pa_ = [nx * x + ny * y for x, y in pa]; pb_ = [nx * x + ny * y for x, y in pb]
            if max(pa_) <= min(pb_) + 1e-9 or max(pb_) <= min(pa_) + 1e-9: return False
    return True

def room_boxes(bid, placements, floor_abs):
    boxes = []; skipped = {}
    for p in placements:
        _, key, x, y, z, rot, sc = p
        if key in SKIP or key.startswith("bottle_"): continue
        bnd = piece_bounds(key)
        if bnd is None: skipped[key] = skipped.get(key, 0) + 1; continue
        mnx, mny, mnz, mxx, mxy, mxz = [v * sc for v in bnd]
        if z - floor_abs > 0.3 or z + mnz - floor_abs > 1.0 or mxz - mnz < 0.25 or (mxx - mnx) < 0.05: continue     # sits on something / hangs / flat (rugs)
        boxes.append(Box(x, y, rot, mnx, mxx, mny, mxy, z + mnz, z + mxz, key))
    return boxes, skipped

def write(HERO_INFO, outdir):
    by = {}
    for p in kit.PLACEMENTS: by.setdefault(p[0], []).append(p)
    anchors = {}
    for a in kit.ANCHORS: anchors.setdefault(a["building"], []).append(a)
    errors = []; door_trim = 0; door_drop = []; trimmed = 0; total = 0; unknown = {}; sizes = []
    for bid, hi in HERO_INFO.items():
        fr = hi["fr"]; W = hi["W"]; floor_abs = fr.z0 + WALK_STEP
        boxes, sk = room_boxes(bid, by.get(bid, []), floor_abs)
        for k, v in sk.items(): unknown[k] = unknown.get(k, 0) + v
        for a in anchors.get(bid, []):
            ax, ay = a["approach"][0], -a["approach"][1]                          # anchors are stored in three space
            for b in boxes:
                if b.covers(ax, ay): errors.append((bid, a["id"], "approach point is INSIDE box", b.key, round(ax, 2), round(-ay, 2)))
                elif b.dist(ax, ay) < CLEAR - 1e-6:
                    if b.trim_for(ax, ay): trimmed += 1
                    else: errors.append((bid, a["id"], "cannot clear approach point", b.key))
        dpoly = [fr.xy(hi["door_u"] - DOOR_W / 2, 0.5), fr.xy(hi["door_u"] + DOOR_W / 2, 0.5), fr.xy(hi["door_u"] + DOOR_W / 2, -DOOR_DEPTH), fr.xy(hi["door_u"] - DOOR_W / 2, -DOOR_DEPTH)]
        for b in list(boxes):
            if b.z0 < floor_abs + 1.8 and _sat(dpoly, b.corners()):
                if b.trim_door(dpoly): door_trim += 1
                else: boxes.remove(b); door_drop.append((bid, b.key))
        seats = [[round(a["seat"][0], 3), round(a["seat"][1], 3)] for a in anchors.get(bid, [])]
        doc = {"id": bid, "units": "m, three.js space: [cx, cz, hx, hz, y0, y1, rotY]", "floorY": round(floor_abs, 3), "boxes": [b.out() for b in boxes], "seats": seats}
        s = json.dumps(doc, separators=(",", ":")); open(f"{outdir}/{bid}.col.json", "w").write(s); sizes.append(len(s)); total += len(boxes)
    print("COL_INTERIORS", len(HERO_INFO), "rooms,", total, "boxes,", trimmed, "trimmed for approach clearance,", door_trim, "trimmed /", len(door_drop), "dropped for the door path", {k: sum(1 for d in door_drop if d[1]==k) for k in {d[1] for d in door_drop}}, "bytes total", sum(sizes), "max", max(sizes), "| no bounds for", unknown)
    for pth in (f"{outdir}/index.json", os.path.join(os.path.dirname(outdir), "heroes.json")):          # index rows learn where their furniture boxes live
        rows = json.load(open(pth))
        for r in rows: r["collision"] = f"/assets/interiors/{r['id']}.col.json"
        json.dump(rows, open(pth, "w"), separators=(",", ":")) if pth.endswith("index.json") else json.dump(rows, open(pth, "w"), indent=1)
    if errors:
        for e in errors[:40]: print("  COL ERROR", e)
        raise SystemExit(f"col_interiors: {len(errors)} errors (a box covers an approach point or blocks the door path)")
