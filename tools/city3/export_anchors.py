"""Ship seats: apps/console/public/assets/city3-anchors.json, derived from the SHIPPED furnished rooms.

Shop seats come from interiors/shop-N.json (chair_wood, armchair_blue on the ground floor), not from out/hero-anchors.json:
furnish_bones.py re-furnished the shops after hero-anchors.json was built, so those anchors point at furniture that is gone.
Tea House and press entries already in the shipped file are kept (tea_house/furnish.mjs and hero.py author them).
A prop's yaw is where a seated body faces (asset front = +z, heading = atan2(fx, fz)); the stand point is 0.62 m behind the chair.
A seat is dropped when that stand point is outside the room or inside furniture (checked against shop-N.col.json).
Each seat gets a `group`: the table it sits at, so a pair can be told from two strangers.
  python3 export_anchors.py     (from tools/city3, after furnish_bones.py)
"""
import json, math, os

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "../../apps/console/public/assets")
SHIPPED = os.path.join(ASSETS, "city3-anchors.json")
# shortcut: seat heights are the hero-anchors medians per kind (chair 0.46, armchair 0.45), not measured per asset; re-measure if sit poses look off.
KINDS = {"chair_wood": ("chair", 0.46), "armchair_blue": ("armchair", 0.45)}
GROUND_Y = 0.2   # furnish_bones.FLOOR_Y; upper floors (y 4.4, 8.2, 12.0) are not walkable yet
BACK = 0.62      # stand point behind the seat
TABLE_R = 1.6    # a seat within this of a table prop belongs to it
CLEAR = 0.1      # stand point must be this far outside any furniture box


def in_box(x, z, b, margin=0.0):
    cx, cz, hx, hz, _, _, rot = b
    dx, dz = x - cx, z - cz
    c, s = math.cos(rot), math.sin(rot)
    return abs(dx * c - dz * s) <= hx + margin and abs(dx * s + dz * c) <= hz + margin


def shop_seats(room):
    rid = room["id"]
    props = json.load(open(os.path.join(ASSETS, "interiors", f"{rid}.json")))["props"]
    boxes = json.load(open(os.path.join(ASSETS, "interiors", f"{rid}.col.json")))["boxes"]
    boxes = [b for b in boxes if b[4] < 1.0]   # ground-floor furniture only
    x0, z0, x1, z1 = room["rect"]
    tables = [p for p in props if "table" in p[0].lower() and abs(p[2] - GROUND_Y) < 0.05]
    out = []
    for i, p in enumerate(props):
        if p[0] not in KINDS or abs(p[2] - GROUND_Y) > 0.05:
            continue
        kind, height = KINDS[p[0]]
        x, z, yaw = p[1], p[3], p[4]
        ax, az = x - BACK * math.sin(yaw), z - BACK * math.cos(yaw)
        if not (min(x0, x1) + 0.4 <= ax <= max(x0, x1) - 0.4 and min(z0, z1) + 0.4 <= az <= max(z0, z1) - 0.4):
            continue
        if any(in_box(ax, az, b, CLEAR) for b in boxes if not in_box(x, z, b)):
            continue
        row = dict(id=f"{rid}-{kind}-{i}", building=rid, kind=kind, seat=[round(x, 2), round(z, 2)], facing=round(yaw, 4),
                   approach=[round(ax, 2), round(az, 2)], approachSide="back", seatHeight=height, floorY=GROUND_Y)
        near = min(((math.hypot(x - t[1], z - t[3]), j) for j, t in enumerate(tables)), default=None)
        if near and near[0] <= TABLE_R:
            row["group"] = f"{rid}-table-{near[1]}"
        out.append(row)
    return out


def main():
    rooms = [r for r in json.load(open(os.path.join(ASSETS, "interiors/index.json"))) if r["id"].startswith("shop-")]
    kept = [a for a in json.load(open(SHIPPED)) if not a["building"].startswith("shop-")]
    for a in kept:
        if a["building"] == "tea" and "group" not in a:
            a["group"] = a["id"].rsplit("-", 1)[0]
    seats = [a for r in rooms for a in shop_seats(r)]
    json.dump(kept + seats, open(SHIPPED, "w"), separators=(",", ":"))
    print(len(kept), "kept,", len(seats), "shop seats in", len({a["building"] for a in seats}), "rooms;", sum(1 for a in seats if "group" in a), "grouped")


main()
