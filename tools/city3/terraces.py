"""Garden Terraces — modern residential district (west of the Bazaar): stepped white terraces with timber screens, green roofs, villas with pools, gardens and a canal.
Run: blender -b --python terraces.py [-- ij ...]  -> out/world-terraces.glb, out/terraces-plan.json. Local origin = district centre."""
import bpy, json, math, os, random, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from mkit import *
import mdetails as D
import collision as CX
COL = CX.Col()                                                  # collision solids (collision.py); exported after the visual GLB
clear_blender(); Z = 0.2; FH = 3.4; LAND = 180.0; SW = 3.5; rng = random.Random(7071)
for k, tag in (("road", "road_m"), ("sidewalk", "plaza_herring"), ("stucco", None), ("slat", "wood_slat"), ("stone", "stone_clad"), ("panel", "panel_conc"), ("terrazzo", None), ("roofgrey", "roof_grey"), ("bitumen", None)):
    pbr_mat(k, tag or k)
pbr_mat("greenroof", "grass004", rough=0.95)   # ambientCG short grass on the planted roofs (was a flat palette-moss quad); rough overridden — the set's authored roughness map averages 0.26, a sheen no lawn has, and mkit materials take the scalar
img_mat("glass", "glass_atlas.jpg", "glass_emit.jpg", rough=0.07, metal=0.6, emit=1.0); img_mat("msign", "msigns.jpg", "msigns.jpg", rough=0.4, emit=0.5)
palette_mat("palette"); palette_mat("led", emit=3.0); palette_mat("water", rough=0.03); glass_mat("shopglass")
TL = {"road": 2.1, "sidewalk": 2.0, "stucco": 1.8, "slat": 1.7, "stone": 2.0, "panel": 2.0, "terrazzo": 2.0, "roofgrey": 4.0, "bitumen": 6.0}
LINES = [(-110, 12), (0, 24), (110, 12)]
edges = [-LAND]
for c, w in LINES: edges += [c - w / 2, c + w / 2]
edges.append(LAND)
BL = [(edges[i], edges[i + 1]) for i in range(0, len(edges), 2)]
KIND = {(0, 0): "villas", (0, 1): "terrace", (0, 2): "terrace", (0, 3): "villas", (1, 0): "terrace", (1, 1): "garden", (1, 2): "terrace", (1, 3): "terrace",
        (2, 0): "terrace", (2, 1): "terrace", (2, 2): "garden", (2, 3): "terrace", (3, 0): "villas", (3, 1): "villas", (3, 2): "villas", (3, 3): "villas"}
PLAN = {"district": "terraces", "land": LAND, "blocks": [], "buildings": [], "streets": [{"c": c, "w": w} for c, w in LINES], "trees": [], "lamps": []}
floor_quad("road", -LAND, -LAND, LAND, LAND, Z - 0.03, TL["road"])
for i, (x0, x1) in enumerate(BL):
    for j, (y0, y1) in enumerate(BL):
        floor_quad("sidewalk", x0, y0, x1, y1, Z, TL["sidewalk"]); PLAN["blocks"].append({"i": i, "j": j, "kind": KIND[(i, j)], "rect": [x0, y0, x1, y1]})
        for (a, b, c_, d_) in ((x0, y0, x1, y0 + 0.22), (x0, y1 - 0.22, x1, y1), (x0, y0, x0 + 0.22, y1), (x1 - 0.22, y0, x1, y1)): pquad("palette", (a, b, Z + 0.006), (c_, b, Z + 0.006), (c_, d_, Z + 0.006), (a, d_, Z + 0.006), "concrete", (0, 0, 1))
for c, w in LINES:
    for off, col in ((-0.1, "paint_white"), (0.1, "paint_white")) if w >= 24 else ():
        D.stripe(c + off - 0.04, -LAND, c + off + 0.04, LAND, Z + 0.012, "paint_white"); D.stripe(-LAND, c + off - 0.04, LAND, c + off + 0.04, Z + 0.012, "paint_white")
    for s in (-1, 1) if w >= 24 else ():
        D.stripe(c + s * 8.5 - 1.1, -LAND, c + s * 8.5 + 1.1, LAND, Z + 0.012, "green"); D.stripe(-LAND, c + s * 8.5 - 1.1, LAND, c + s * 8.5 + 1.1, Z + 0.012, "green")   # bike lanes
for side, (a, b, o) in {"S": ((-LAND, -LAND), (LAND, -LAND), (0, -1)), "E": ((LAND, -LAND), (LAND, LAND), (1, 0)), "N": ((LAND, LAND), (-LAND, LAND), (0, 1)), "W": ((-LAND, LAND), (-LAND, -LAND), (-1, 0))}.items():
    pquad("palette", (a[0], a[1], -3), (b[0], b[1], -3), (b[0], b[1], Z), (a[0], a[1], Z), "concrete_dk", (o[0], o[1], 0))
def block_rect(i, j): x0, x1 = BL[i]; y0, y1 = BL[j]; return (x0 + SW, y0 + SW, x1 - SW, y1 - SW)
def modern_wall(fr, L, nfl, r, z0=0.0, slat_share=0.3, big=True):
    """Glazed bays are the default cell, framed in stucco piers with slab edges. Timber
    screens survive only as full-height strips in fixed bay columns and balconies stack
    in alternating columns — the pattern is a pure function of the wall frame (origin,
    direction, base height), never per-cell dice. The legacy per-cell draws are still
    consumed in the old order and discarded, so every downstream placement in the
    district (trees, shrubs, villa footprints) rolls exactly as it did before."""
    nb = max(1, round(L / 4.5)); bw = L / nb
    hk = (int(round(fr.a[0] * 2)) * 73856093) ^ (int(round(fr.a[1] * 2)) * 19349663) ^ (int(round(fr.z0 * 2)) * 83492791) ^ (int(fr.r[0] * 2 + 2) * 297121507) ^ (int(fr.r[1] * 2 + 2) * 433024223)
    variant = hk % 3; gvar = hk % 8
    if nb >= 6: strips = ({nb // 2}, {0, nb - 1}, {nb // 3, 2 * nb // 3})[variant]
    elif nb >= 4: strips = ({nb // 2}, {0, nb - 1}, {nb // 2})[variant]
    elif nb == 3: strips = {1}
    else: strips = set()
    for f in range(nfl):
        z = z0 + f * FH
        for b in range(nb):
            u0, u1 = b * bw, (b + 1) * bw; c = (u0 + u1) / 2
            k = r.random()                                   # legacy draws, kept for stream parity
            if slat_share <= k < 0.9:
                r.randrange(8); r.randrange(3)
                if f > 0: r.random()
            if b in strips: wall(fr, u0, u1, z, z + FH, "slat", TL["slat"]); continue
            w = bw - 1.0; a, d = c - w / 2, c + w / 2; sill, head = 0.15, 3.0
            wall(fr, u0, a, z, z + FH, "stucco", TL["stucco"]); wall(fr, d, u1, z, z + FH, "stucco", TL["stucco"]); wall(fr, a, d, z, z + sill, "stucco", TL["stucco"]); wall(fr, a, d, z + head, z + FH, "stucco", TL["stucco"])
            reveal(fr, a, d, z + sill, z + head, 0.0, -0.25, "stucco", TL["stucco"])
            gu = glaze_uv(gvar, b % 3); tquad("glass", fr.p(a, -0.26, z + sill), fr.p(d, -0.26, z + sill), fr.p(d, -0.26, z + head), fr.p(a, -0.26, z + head), [(gu[0], gu[1]), (gu[2], gu[1]), (gu[2], gu[3]), (gu[0], gu[3])], fr.o(0, 1))
            for q in (1, 2): fbox(fr, a + w * q / 3 - 0.025, a + w * q / 3 + 0.025, -0.27, -0.2, z + sill, z + head, "alu_dk")
            if f > 0 and b % 2 == variant % 2:
                wbox(fr, a - 0.2, d + 0.2, 0, 1.3, z - 0.02, z + 0.16, "panel", TL["panel"]); P = fr.p
                mb("shopglass").quad(P(a - 0.2, 1.3, z + 0.16), P(d + 0.2, 1.3, z + 0.16), P(d + 0.2, 1.3, z + 1.1), P(a - 0.2, 1.3, z + 1.1), (0, 0), (1, 0), (1, 1), (0, 1), fr.o(0, 1)); fbox(fr, a - 0.2, d + 0.2, 1.27, 1.33, z + 1.08, z + 1.14, "alu")
            else: fbox(fr, a - 0.1, d + 0.1, 0, 0.12, z - 0.05, z + 0.08, "white")
        fbox(fr, 0, L, 0, 0.08, z + FH - 0.12, z + FH, "white")
def green_roof(rect, z, r, shrubs=0.04):
    x0, y0, x1, y1 = rect; poly = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    tquad("greenroof", (x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z), [(x0 / 2, y0 / 2), (x1 / 2, y0 / 2), (x1 / 2, y1 / 2), (x0 / 2, y1 / 2)], (0, 0, 1))
    for fr, L in edge_frames(poly, z): wbox(fr, 0, L, -0.3, 0.0, 0.0, 0.5, "stucco", TL["stucco"])
    for _ in range(int((x1 - x0) * (y1 - y0) * shrubs)): D.shrub(r.uniform(x0 + 1, x1 - 1), r.uniform(y0 + 1, y1 - 1), z, r, r.uniform(0.4, 0.8), r.choice(["leaf", "moss", "leaf_lt", "pink", "lilac"]))
def deck(rect, z, r, trees=2):
    x0, y0, x1, y1 = rect; tquad("terrazzo", (x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z), [(x0 / 2, y0 / 2), (x1 / 2, y0 / 2), (x1 / 2, y1 / 2), (x0 / 2, y1 / 2)], (0, 0, 1))
    poly = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    for fr, L in edge_frames(poly, z):
        P = fr.p; mb("shopglass").quad(P(0.1, -0.15, 0), P(L - 0.1, -0.15, 0), P(L - 0.1, -0.15, 1.1), P(0.1, -0.15, 1.1), (0, 0), (1, 0), (1, 1), (0, 1), fr.o(0, 1)); fbox(fr, 0, L, -0.2, -0.1, 1.08, 1.14, "alu")
    for _ in range(trees): D.planter(r.uniform(x0 + 3, x1 - 3), r.uniform(y0 + 2, y1 - 2), z, 2.6, 1.1, r)
    for _ in range(2): D.bench(r.uniform(x0 + 3, x1 - 3), r.uniform(y0 + 2, y1 - 2), z, True)
def terrace_building(x0, y0, x1, y1, r, base_floors, tag):
    """Three stacked slabs stepping back (north) so every level has a planted roof deck in front of the next.
    DELETED as buildings (Jim's order, physics census 2026-11-06): each tier steps north AND grows, so
    tier 1 bears on 16-20% of its footprint and tier 2 on 24-29%, north walls float 7.0-23.8 m, no wall
    lands on a wall. terrace() still runs this builder into a throwaway group and discards the result --
    geometry buckets purged, plan entries truncated -- purely so the block's RNG stream is consumed
    identically and every surviving placement (dress(), villas, gardens) stays byte-identical."""
    step = (y1 - y0) / 3.0; z = Z
    for k in range(3):
        ya = y0 + k * step * 0.9; fl = base_floors + (1 if k == 1 else 0)
        rect = (x0 + k * 0.0, ya, x1, y1 if k == 2 else y0 + (k + 1) * step + 2)
        for side in ("S", "E", "N", "W"):
            fr, L = frame_for(rect, side, z)
            modern_wall(fr, L, fl, r, 0.0, 0.25 if side != "S" else 0.2)
        top = z + fl * FH; poly = [(rect[0], rect[1]), (rect[2], rect[1]), (rect[2], rect[3]), (rect[0], rect[3])]
        if k == 2: green_roof(rect, top, r, 0.012)
        else:
            nxt_y = y0 + (k + 1) * step * 0.9; deck((rect[0] + 1, nxt_y - 0.0 if False else rect[1] + 0.5, rect[2] - 1, nxt_y - 0.3) if False else (rect[0] + 0.8, rect[1] + 0.8, rect[2] - 0.8, min(nxt_y, rect[3]) - 0.3), top, r, 3) if False else None
            green_roof((rect[0], rect[1], rect[2], nxt_y), top, r, 0.04) if False else None
            deck((rect[0] + 0.6, rect[1] + 0.6, rect[2] - 0.6, nxt_y - 0.2), top, r, 3)
            green_roof((rect[0], nxt_y, rect[2], rect[3]), top, r, 0.01) if rect[3] > nxt_y + 1 else None
        PLAN["buildings"].append({"id": f"{tag}{k}", "poly": [[round(a, 2), round(b, 2)] for a, b in poly], "floors": fl, "h": round(top - Z, 2), "kind": "terrace", "style": "stucco"})
        z = top
def dress(rect, r):
    x0, y0, x1, y1 = rect
    for side in ("S", "E", "N", "W"):
        fr, L = frame_for((x0 - SW, y0 - SW, x1 + SW, y1 + SW), side, Z); out = fr.o(0, 1)
        for k in range(int(L // 22)): D.lamp(*fr.xy(8 + k * 22.0, 0.9), Z, (out[0], out[1])); PLAN["lamps"].append(list(fr.xy(8 + k * 22.0, 0.9)))
        for k in range(int(L // 20)):
            x, y = fr.xy(5 + k * 14.0, 1.2); D.tree_grate(x, y, Z + 0.02); D.tree(x, y, Z + 0.02, r, r.uniform(5, 7.5)); PLAN["trees"].append([x, y])
        for k in range(int(L // 20)): D.bench(*fr.xy(12 + k * 20.0, 2.8), Z, abs(fr.r[0]) > 0.5); D.bike_rack(*fr.xy(18 + k * 20.0, 2.8), Z, abs(fr.r[0]) > 0.5)
def terrace(i, j, r):
    x0, y0, x1, y1 = block_rect(i, j)
    with grp(f"b{i}{j}"):
        floor_quad("sidewalk", x0, y0, x1, y1, Z + 0.015, TL["sidewalk"])
        W = x1 - x0; xs = x0 + 4
        while xs < x1 - 20:
            w = min(r.choice([26, 32, 38]), x1 - 4 - xs)
            if w < 18: break
            nb_ = len(PLAN["buildings"]); nt_ = len(PLAN["trees"])
            with grp(f"gone{i}{j}"):   # deleted stacks: build only to consume the RNG draws, then discard
                terrace_building(xs, y0 + 8, xs + w, y1 - 8, r, r.choice([2, 2, 3]), f"t{i}{j}_{int(xs)}")
            del PLAN["buildings"][nb_:]; del PLAN["trees"][nt_:]
            for key in [k for k in MBS if k.startswith(f"gone{i}{j}::")]: del MBS[key]
            xs += w + 6
        dress((x0, y0, x1, y1), r)
        garden_infill((x0, y0, x1, y1), r)
def garden_infill(rect, r):
    """Freed stack plots become garden ground, on the garden blocks' own pattern (garden() minus the
    canal): lawn over the block interior, scattered pack trees + shrubs, benches along the south edge.
    Runs after dress() on the block's RNG stream, so no surviving placement moves; its trees append
    to PLAN["trees"] and pick up collision trunks from the plan like every other tree. D.tree() draws
    variants/rotations from mdetails' district-global _trng, so that stream is snapshotted and restored
    around the infill -- otherwise every later block's trees would re-roll their variants."""
    x0, y0, x1, y1 = rect; cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    _ts = D._trng.getstate()
    tquad("palette", (x0, y0, Z + 0.04), (x1, y0, Z + 0.04), (x1, y1, Z + 0.04), (x0, y1, Z + 0.04), [pal_uv("grass")] * 4, (0, 0, 1))
    for _ in range(36):
        x, y = r.uniform(x0 + 3, x1 - 3), r.uniform(y0 + 3, y1 - 3)
        D.tree(x, y, Z + 0.04, r, r.uniform(5, 9), r.choice(["round", "slim"])); PLAN["trees"].append([x, y])
    for k in range(8): px = x0 + 10 + k * (x1 - x0 - 20) / 7; D.bench(px, y0 + 6 if k % 2 else y1 - 6, Z + 0.04, True)
    for _ in range(16): D.shrub(r.uniform(x0 + 3, x1 - 3), r.uniform(y0 + 3, y1 - 3), Z + 0.04, r, r.uniform(0.5, 1.0), r.choice(["pink", "lilac", "leaf_lt", "yellow"]))
    D._trng.setstate(_ts)
def villas(i, j, r):
    x0, y0, x1, y1 = block_rect(i, j)
    with grp(f"b{i}{j}"):
        tquad("palette", (x0, y0, Z + 0.03), (x1, y0, Z + 0.03), (x1, y1, Z + 0.03), (x0, y1, Z + 0.03), [pal_uv("grass")] * 4, (0, 0, 1))
        nx = int((x1 - x0) // 38) or 1; ny = int((y1 - y0) // 38) or 1
        for a in range(nx):
            for b in range(ny):
                cx = x0 + (a + 0.5) * (x1 - x0) / nx; cy = y0 + (b + 0.5) * (y1 - y0) / ny; w = r.uniform(18, 24); d = r.uniform(12, 15)
                rect = (cx - w / 2, cy - d / 2, cx + w / 2, cy + d / 2); fl = r.choice([2, 2, 3])
                for side in ("S", "E", "N", "W"): fr, L = frame_for(rect, side, Z); modern_wall(fr, L, fl, r, 0.0, 0.35)
                top = Z + fl * FH; poly = [(rect[0], rect[1]), (rect[2], rect[1]), (rect[2], rect[3]), (rect[0], rect[3])]
                poly_cap("roofgrey", poly, top, 4.0)
                for fr, L in edge_frames(poly, top): wbox(fr, -0.6, L + 0.6, -0.3, 0.9, 0.0, 0.22, "panel", TL["panel"]) if False else wbox(fr, 0, L, -0.2, 0.9, 0.0, 0.22, "panel", TL["panel"])
                px, py = cx - w / 2 - 6, cy                                     # pool + timber pergola beside the house
                COL.box("props", px - 4, py - 2.5, Z - 0.1, px + 4, py + 2.5, Z + 0.9); pbox(px - 4, py - 2.5, px + 4, py + 2.5, Z + 0.03, Z + 0.15, "concrete"); mb("water").quad((px - 3.7, py - 2.2, Z + 0.1), (px + 3.7, py - 2.2, Z + 0.1), (px + 3.7, py + 2.2, Z + 0.1), (px - 3.7, py + 2.2, Z + 0.1), (0, 0), (1, 0), (1, 1), (0, 1), (0, 0, 1))
                for sx in (-1, 1):
                    for sy in (-1, 1): cyl(cx + w / 2 + 3 + sx * 2.2, cy + sy * 2.2, Z + 0.03, Z + 2.6, 0.08, 6, "wood_dk")
                for k in range(6): pbox(cx + w / 2 + 0.7, cy - 2.6 + k * 1.0, cx + w / 2 + 5.4, cy - 2.4 + k * 1.0, Z + 2.6, Z + 2.72, "wood")
                for _ in range(3): D.tree(r.uniform(x0 + 3, x1 - 3), r.uniform(y0 + 3, y1 - 3), Z + 0.03, r, r.uniform(5, 8))
                PLAN["buildings"].append({"id": f"v{i}{j}{a}{b}", "poly": [[round(p, 2), round(q, 2)] for p, q in poly], "floors": fl, "h": round(top - Z, 2), "kind": "villa", "style": "stucco"})
        dress((x0, y0, x1, y1), r)
def garden(i, j, r):
    x0, y0, x1, y1 = block_rect(i, j); cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    with grp(f"b{i}{j}"):
        tquad("palette", (x0, y0, Z + 0.04), (x1, y0, Z + 0.04), (x1, y1, Z + 0.04), (x0, y1, Z + 0.04), [pal_uv("grass")] * 4, (0, 0, 1))
        COL.box("props", x0, cy - 5, Z - 0.5, x1, cy + 5, Z + 0.9); pbox(cx - (x1 - x0) / 2, cy - 5, cx + (x1 - x0) / 2, cy + 5, Z + 0.04, Z + 0.35, "concrete"); mb("water").quad((x0 + 0.3, cy - 4.7, Z + 0.28), (x1 - 0.3, cy - 4.7, Z + 0.28), (x1 - 0.3, cy + 4.7, Z + 0.28), (x0 + 0.3, cy + 4.7, Z + 0.28), (0, 0), (1, 0), (1, 1), (0, 1), (0, 0, 1))   # canal
        for bx in (x0 + (x1 - x0) * 0.3, x0 + (x1 - x0) * 0.7):
            pbox(bx - 2.2, cy - 5.2, bx + 2.2, cy + 5.2, Z + 0.34, Z + 0.5, "wood"); [pbox(bx + s * 2.1 - 0.05, cy - 5.2, bx + s * 2.1 + 0.05, cy + 5.2, Z + 0.5, Z + 1.2, "alu") for s in (-1, 1)]
        for _ in range(36):
            x, y = r.uniform(x0 + 3, x1 - 3), r.uniform(y0 + 3, y1 - 3)
            if abs(y - cy) > 8: D.tree(x, y, Z + 0.04, r, r.uniform(5, 9), r.choice(["round", "slim"])); PLAN["trees"].append([x, y])
        for k in range(8): px = x0 + 10 + k * (x1 - x0 - 20) / 7; pbox(px - 3, y0 + 6, px + 3, y0 + 7, Z + 0.04, Z + 2.6, "wood_dk") if False else D.bench(px, y0 + 6 if k % 2 else y1 - 6, Z + 0.04, True)
        for _ in range(16): D.shrub(r.uniform(x0 + 3, x1 - 3), r.uniform(y0 + 3, y1 - 3), Z + 0.04, r, r.uniform(0.5, 1.0), r.choice(["pink", "lilac", "leaf_lt", "yellow"]))
        dress((x0, y0, x1, y1), r)
BUILD = {"terrace": terrace, "villas": villas, "garden": garden}
only = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
for (i, j), k in KIND.items():
    if only and f"{i}{j}" not in only: continue
    BUILD[k](i, j, random.Random(300 + i * 10 + j))
realise({"road": "Road", "sidewalk": "Sidewalk", "glass": "Glass", "shopglass": "ShopGlass", "palette": "Props", "led": "Led", "msign": "Signs", "greenroof": "GreenRoof"})
agg = {}
for k, v in MBS.items(): agg[k.rpartition("::")[2]] = agg.get(k.rpartition("::")[2], 0) + len(v.f)
print("TRIS", sum(agg.values()), dict(sorted(agg.items(), key=lambda kv: -kv[1])[:8]))
os.makedirs(f"{HERE}/out", exist_ok=True); bpy.ops.wm.save_as_mainfile(filepath=f"{HERE}/out/terraces.blend")
export_glb(f"{HERE}/out/world-terraces.glb"); json.dump(PLAN, open(f"{HERE}/out/terraces-plan.json", "w"))
# ---- collision: ground, quay (open where the Bazaar bridge lands: east edge), plan footprints (plan "h" = height above Z), trunks, lamps; pools and garden canals are solid blocks (no ground over water)
COL.ground_rect("ground", -LAND, -LAND, LAND, LAND, Z); CX.quay(COL, LAND, Z, "E")
for b in PLAN["buildings"]: COL.prism("buildings", b["poly"], Z - 0.3, Z + b["h"])
for (x, y) in PLAN["trees"]: COL.cyl("props", x, y, Z - 0.1, Z + 3.0, 0.25, 6)
for (x, y) in PLAN["lamps"]: COL.cyl("props", x, y, Z - 0.1, Z + 4.0, 0.15, 6)
CX.finish(COL, f"{HERE}/out/world-terraces-collision.glb")
