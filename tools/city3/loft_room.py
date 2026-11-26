"""Author the modern loft room: layout, collision boxes and seats for house-cabin-2.

Furniture comes from `kit_loft.py` (modern-loft-interior.glb); this script places it in the
Lakeside Cabin shell (6.29 x 14.32 m, floor 0.48 m, door on the east wall at z=27.2) and keeps the
three files that describe a room in step:

    interiors/house-cabin-2.json       layout: props + lights
    interiors/house-cabin-2.col.json   collision boxes for the walker
    city3-anchors.json                 the seats an agent can claim

Footprints: the kit manifest records dims in BLENDER space (x = width, y = depth, z = height), so a
piece at yaw 0 occupies (width, depth) in (x, z); yaw rotates that rectangle.

    python3 tools/city3/loft_room.py [--dry-run]
"""
import argparse, json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.abspath(os.path.join(HERE, "..", "..", "apps", "console", "public", "assets"))
ROOM = "house-zen-pavilion-1"
FLOOR = 0.48

# key, x, z, yaw (radians; the prop's front is +Z at yaw 0), y offset above the floor
PLACE = [
    # Measured floor plan (zen-pavilion-y270.col.glb): one open room x -27.0..-21.9,
    # z -117.2..-111.7, porch/door on the south edge at x=-24.2.
    # living (north half)
    ("loft_sofa", -26.45, -115.60, math.pi / 2, 0),
    ("loft_coffee", -24.95, -115.60, 0, 0),
    ("loft_media", -22.10, -115.60, -math.pi / 2, 0),
    ("loft_tv", -22.10, -115.60, -math.pi / 2, 0.341),
    ("loft_armchair", -24.95, -113.95, math.pi, 0),
    ("loft_side", -26.35, -113.95, 0, 0),
    ("loft_pillows", -26.30, -115.15, math.pi / 2, 0.45),
    ("loft_plant", -26.55, -116.95, 0, 0),
    ("loft_mirror", -26.95, -114.60, math.pi / 2, 0),
    ("loft_shelf", -23.30, -116.95, 0, 0),
    ("loft_ceiling", -24.60, -115.50, 0, 2.00),
    # dining (south half, clear of the door lane)
    ("loft_dining", -24.30, -112.70, 0, 0),
    ("loft_dining_chair", -24.80, -113.50, 0, 0),
    ("loft_dining_chair", -23.80, -113.50, 0, 0),
    ("loft_pendant", -24.30, -112.70, 0, 1.85),
]

# key -> seats: (offset from the prop centre, facing or None for the prop's yaw, approach side)
SEATS = {
    "loft_sofa": [((-0.15, -0.45), math.pi / 2, "front"), ((-0.15, 0.45), math.pi / 2, "front")],
    "loft_dining_chair": [((0, 0), None, "back")],
    "loft_bar_chair": [((0, 0), math.pi / 2, "back")],
}

# key, id, kind, label, stand-side, facing offset, pilot position, and how it is used:
#   clip  - catalog clip the figure plays (absent: the generic Interact reach)
#   mode  - toggle (default) | momentary | once
#   verb  - the prompt word ("Watch", "Listen to", "Read")
USE = [
    ("loft_tv", "loft-tv", "tv", "Television", 0.75, 0, (0.0, 1.02, -0.05),
     {"verb": "Watch"}),
    ("loft_media", "loft-stereo", "stereo", "Stereo", 0.55, 0, (0.0, 0.30, 0.0),
     {"verb": "Listen to"}),
    ("loft_shelf", "loft-shelf", "bookshelf", "Bookshelf", 0.50, 0.0, (0.0, 1.06, 0.0),
     {"clip": "PickUp", "mode": "once", "verb": "Read"}),
]

LIGHTS = [
    (-24.60, 2.50, -115.50, "#ffe6c4", 26),
    (-24.30, 2.35, -112.70, "#ffe9d0", 22),
    (-22.40, 1.30, -115.50, "#fff2dc", 6),
]


def load_manifest():
    d = json.load(open(os.path.join(HERE, "out", "modern-loft.json")))
    return {a["key"]: a for a in d["assets"]}


def footprint(dims, yaw):
    """Blender dims (x width, y depth, z height) -> half-extents of the yaw-rotated AABB."""
    w, d = dims[0] / 2, dims[1] / 2
    c, s = abs(math.cos(yaw)), abs(math.sin(yaw))
    return (w * c + d * s, w * s + d * c)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    kit = load_manifest()
    props, boxes, seats, uses = [], [], [], []

    for key, x, z, yaw, yoff in PLACE:
        if key not in kit:
            sys.exit(f"{key} is not in the kit manifest")
        dims = kit[key]["dims"]
        props.append([key, round(x, 3), round(FLOOR + yoff, 3), round(z, 3), round(yaw, 6), 1])
        # Only floor-standing pieces block the walker; wall art, lamps and toppers do not.
        if yoff == 0 and max(dims[0], dims[1]) > 0.3:
            hx, hz = footprint(dims, yaw)
            boxes.append([round(x, 3), round(z, 3), round(hx, 3), round(hz, 3), round(FLOOR, 3),
                          round(FLOOR + dims[2], 3), round(yaw, 6)])
        for (ox, oz), facing, side in SEATS.get(key, []):
            f = yaw if facing is None else facing
            fx, fz = math.sin(f), math.cos(f)
            back = -0.62 if side == "back" else 0.62
            seats.append({
                "id": f"{ROOM}-{key.replace('loft_', '')}-{len(seats)}",
                "building": ROOM,
                "kind": key.replace("loft_", ""),
                "seat": [round(x + ox, 3), round(z + oz, 3)],
                "facing": round(f, 6),
                "approach": [round(x + ox + fx * back, 3), round(z + oz + fz * back, 3)],
                "approachSide": side,
                "seatHeight": round(FLOOR + (0.42 if ("sofa" in key or "chair" in key) else 0.30), 3),
                "floorY": FLOOR,
            })

    for key, ident, kind, label, stand_off, facing_off, pilot, use in USE:
        placed = next((p for p in props if p[0] == key), None)
        if placed is None:
            sys.exit(f"{ident}: {key} is not placed")
        px, py, pz, yaw = placed[1], placed[2], placed[3], placed[4]
        f = yaw + facing_off
        uses.append({
            "id": ident, "room": ROOM, "kind": kind, "asset": key, "label": label,
            "pos": [round(px, 3), round(py, 3), round(pz, 3)], "rotY": yaw,
            "stand": [round(px + math.sin(f) * stand_off, 3), round(pz + math.cos(f) * stand_off, 3)],
            "heading": round(f + math.pi, 6), "floorY": FLOOR,
            "pilot": list(pilot), **use,
        })

    layout = {"id": ROOM, "library": "modern-loft-interior.glb", "props": props,
              "lights": [list(l) for l in LIGHTS]}
    col = {"id": ROOM, "units": "m, three.js space: [cx, cz, hx, hz, y0, y1, rotY]",
           "floorY": FLOOR, "boxes": boxes, "seats": []}

    print(f"{len(props)} props, {len(boxes)} collision boxes, {len(seats)} seats, {len(uses)} interactables")
    if args.dry_run:
        return
    for name, doc in ((f"interiors/{ROOM}.json", layout), (f"interiors/{ROOM}.col.json", col)):
        path = os.path.join(ASSETS, name)
        json.dump(doc, open(path, "w"), separators=(",", ":"))
        print("wrote", path)

    anchors_path = os.path.join(ASSETS, "city3-anchors.json")
    anchors = [a for a in json.load(open(anchors_path)) if a.get("building") != ROOM]
    anchors.extend(seats)
    json.dump(anchors, open(anchors_path, "w"), separators=(",", ":"))
    print(f"wrote {anchors_path} ({len(anchors)} anchors)")

    index_path = os.path.join(ASSETS, "interiors", "index.json")
    index = json.load(open(index_path))
    for room in index:
        if room["id"] == ROOM:
            room["name"] = "The Loft"
            room["featured"] = True
            room["interactables"] = uses
    json.dump(index, open(index_path, "w"), separators=(",", ":"))
    print("wrote", index_path)


main()

