"""Tea House furniture layout (plan coordinates u,d = metres from the lot's west/south corner, as plan.json).
Each item: (prop id, u, d, face_to (u,d) or yaw radians). Props are Poly Haven CC0 pieces (assets/tea-props).
build(plan, dims) validates every item: inside its room (inset), clear of every door keep-out, no overlap."""
import math

# per-prop yaw correction (radians) if a model's front is not +Z; tuned by looking at renders
YAW0 = {}


def sets_G():
    out = []
    for u in (5.45, 9.05):                                                    # second row behind the existing tea tables
        out += [("chinese_tea_table", u, 4.95, 0.0), ("chinese_stool", u - 0.82, 4.95, (u, 4.95)), ("chinese_stool", u + 0.82, 4.95, (u, 4.95))]
    out += [("chinese_sofa", 18.6, 0.95, (18.6, 5.0)), ("chinese_tea_table", 18.4, 1.95, 0.0),
            ("chinese_armchair", 16.95, 1.95, (18.4, 1.95))]                      # entry lounge
    return out


EXISTING_G = "apps/console/public/assets/interiors/tea.col.json"


def home(u0, kind):
    # flush packing: gaps are either <0.4 m (not walkable, so no dead-end pockets) or wide aisles
    o = [("vintage_day_bed", u0 + 0.68, 1.45, (u0 + 3, 1.45)), ("painted_wooden_nightstand", u0 + 0.45, 2.78, (u0 + 3, 2.78)),
         ("sofa_02", u0 + 2.6, 1.0, (u0 + 2.6, 4.0))]
    o += [("side_table_01", u0 + 3.85, 0.9, (u0 + 3, 0.9))] if kind == "L2" else [("modern_coffee_table_01", u0 + 2.6, 2.0, math.pi / 2)]
    return o


def study(u0, u1, d1, wall_shelf=True):
    o = [("painted_wooden_table", (u0 + u1) / 2, d1 - 0.8, math.pi), ("painted_wooden_chair_01", (u0 + u1) / 2, d1 - 1.7, ((u0 + u1) / 2, d1 - 0.8))]
    if wall_shelf: o.append(("wooden_bookshelf_worn", u1 - 0.42, (d1 + 7.6) / 2, (u0, (d1 + 7.6) / 2)))
    return o


LAYOUT = {
    "G": sets_G(),
    "L1": [("chinese_console_table", 0.62, 1.4, (9, 1.4)), ("chinese_tea_table", 4.4, 1.15, 0.0),
           ("chinese_stool", 3.65, 1.15, (4.4, 1.15)), ("chinese_stool", 5.15, 1.15, (4.4, 1.15)), ("chinese_stool", 4.4, 1.9, (4.4, 1.15)),
           ("planter_box_01", 7.6, 0.65, (7.6, 4.0)),
           ("chinese_sofa", 10.0, 1.0, (10.0, 4.0)), ("modern_coffee_table_01", 10.0, 2.0, math.pi / 2),
           ("chinese_armchair", 11.02, 2.0, (10.0, 2.0)), ("planter_box_01", 15.7, 0.65, (15.7, 4.0)),
           ("wooden_bookshelf_worn", 24.28, 1.3, (17, 1.3)), ("wooden_bookshelf_worn", 24.28, 2.7, (17, 2.7)),
           ("wooden_bookshelf_worn", 17.05, 1.6, (30, 1.6)),
           ("painted_wooden_table", 20.6, 1.55, 0.0),
           ("painted_wooden_chair_01", 20.0, 0.75, (20.0, 1.55)), ("painted_wooden_chair_01", 21.2, 0.75, (21.2, 1.55)),
           ("painted_wooden_chair_01", 19.0, 1.55, (20.6, 1.55)), ("painted_wooden_chair_01", 22.2, 1.55, (20.6, 1.55))],
    "L2": [], "L3": [],
}
LAYOUT["L1"] += study(8.55, 12.8, 11.7)
for L in ("L2", "L3"):
    for u0 in (0.3, 8.5, 16.6): LAYOUT[L] += home(u0, L)
LAYOUT["L2"] += study(8.55, 12.8, 11.7)
LAYOUT["L3"] += study(8.55, 12.8, 11.7) + [("vintage_day_bed", 6.4, 11.1, 0.0)]


def rot_rect(cx, cz, w, d, yaw):
    c, s = abs(math.cos(yaw)), abs(math.sin(yaw))
    return (cx - (w * c + d * s) / 2, cx + (w * c + d * s) / 2, cz - (w * s + d * c) / 2, cz + (w * s + d * c) / 2)


def keepouts(level):
    out = []
    for dr in level["doors"]:
        if dr["mode"] in ("lift", "hatch"): continue
        c, w, at = dr["center"], dr["width"], dr["at"]
        if dr["axis"] == "d": out.append((c - w / 2 - 0.45, c + w / 2 + 0.45, at - 1.7, at + 1.7))
        else: out.append((at - 1.7, at + 1.7, c - w / 2 - 0.45, c + w / 2 + 0.45))
    return out


def build(plan, dims, strict=True):
    """dims[prop] = (width_x, height_y, depth_z, offx, offz) of the model bbox. Returns {level: [placement dict]}."""
    res, errs = {}, []
    for lv in plan["levels"]:
        L = lv["id"]; rooms = [r for r in lv["rooms"] if r["kind"] not in ("stair",)]
        ko = keepouts(lv); placed = []
        ko += [(r['rect'][2] - 1.7, r['rect'][2], r['rect'][1], r['rect'][3]) for r in lv['rooms'] if r['id'].endswith('-living')]  # living -> kitchen/bath strip
        if L == "G":                                                         # existing instanced tables/booth/radio/register
            import json as _j, os as _o
            col = _j.load(open(_o.path.join(_o.path.dirname(__file__), "..", "..", "..", EXISTING_G)))
            for k, b in enumerate(col["boxes"]):
                u, d = b[0] + 37.5, -(b[1] + 72.5)
                placed.append({"name": f"existing#{k}", "rect": (u - b[2], u + b[2], d - b[3], d + b[3])})
        for n, (pid, u, d, face) in enumerate(LAYOUT.get(L, [])):
            w, h, dep, ox, oz = dims[pid]
            if isinstance(face, tuple):
                tu, td = face; yaw = math.atan2(tu - u, d - td) if (tu, td) != (u, d) else 0.0
            else: yaw = face
            yaw += YAW0.get(pid, 0.0)
            # model-space bbox centre offset rotated into plan space (local x=u, z=-d)
            c, s = math.cos(yaw), math.sin(yaw)
            cx = u + ox * c + oz * s; cz = -d + (-ox * s + oz * c)
            x0, x1, z0, z1 = rot_rect(cx, cz, w, dep, yaw); rect = (x0, x1, -z1, -z0)  # (u0,u1,d0,d1)
            room = next((r for r in rooms if r["rect"][0] - 1e-6 <= u <= r["rect"][2] + 1e-6 and r["rect"][1] - 1e-6 <= d <= r["rect"][3] + 1e-6), None)
            name = f"{L}#{n} {pid}"
            if room is None: errs.append(f"{name}: not in any room"); continue
            ru0, rd0, ru1, rd1 = room["rect"]
            if not (rect[0] >= ru0 + .12 and rect[1] <= ru1 - .12 and rect[2] >= rd0 + .12 and rect[3] <= rd1 - .12):
                errs.append(f"{name}: leaves room {room['id']} {tuple(round(v,2) for v in rect)} vs {room['rect']}")
            for k in ko:
                if rect[0] < k[1] and rect[1] > k[0] and rect[2] < k[3] and rect[3] > k[2]: errs.append(f"{name}: blocks a door keep-out {tuple(round(v,2) for v in k)}")
            for p in placed:
                a = p["rect"]
                if rect[0] < a[1] - .03 and rect[1] > a[0] + .03 and rect[2] < a[3] - .03 and rect[3] > a[2] + .03: errs.append(f"{name}: overlaps {p['name']}")
            placed.append({"name": name, "prop": pid, "u": u, "d": d, "yaw": yaw, "rect": rect, "h": h, "room": room["id"]})
        res[L] = [p for p in placed if "prop" in p]
    if errs and strict: raise SystemExit("LAYOUT ERRORS:\n  " + "\n  ".join(errs))
    return res, errs
