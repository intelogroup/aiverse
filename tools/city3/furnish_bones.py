#!/usr/bin/env python3
"""Furnish the generated bones rooms from the shipped CC0 prop library.

Reads tools/city3/out/bones_all.json (bones.py --emit, per-room rects + door
points) and world-city3-library.glb (LIB_<key> bounds, front = +z), and writes
interiors/shop-N.json (props) and shop-N.col.json (furniture boxes) for every
bones lot. Pure python, deterministic, no Blender.

Each room is laid out in its own frame: u across the room (0 = the door), v
from the door wall into the room. A lane |u| < LANE stays clear from the door
to the far wall so the walker (r 0.4) always crosses the room.

  python3 tools/city3/furnish_bones.py [--lots 46,47] [--dry-run]
Afterwards rebake the navmesh and run nav_bones_check.ts.
"""
import argparse
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
ASSETS = os.path.join(ROOT, "apps", "console", "public", "assets")
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))

FLOOR_Y = 0.2
LANE = 0.95            # half-width of the clear door-to-far-wall lane
LANE_STREET = 1.35     # the street-door room keeps a wider lane
HANG = {"lantern_hang", "menu_board", "frames_wall", "wall_clock", "newspaper_line"}
FLAT = {"rug_4x3", "rug_6x4"}
NO_COL = HANG | FLAT | {"books_a", "books_b", "books_c", "paper_stack", "metal_jug",
                        "brass_goblets", "ceramic_pot", "CashRegister_01"}
KINDS = ["shop", "cafe", "library", "workshop"]
# (lot, floor) pairs to skip. Empty: nav_rooms_check.ts reports three shop-98
# ground rooms (f0N1 f0S2 f0N2) unreachable even with no furniture, so that is
# a navmesh issue of the bones, not of this script (open, not debugged).
LEAVE_EMPTY = set()


def lib_dims(path):
    """LIB_<key> -> (xmin, ymin, zmin, xmax, ymax, zmax) in the asset's frame."""
    import numpy as np
    from bridge_wave1 import Glb
    j = Glb(path).gltf
    nodes = j["nodes"]

    def local(n):
        T = np.eye(4)
        if "matrix" in n:
            return np.array(n["matrix"]).reshape(4, 4).T
        x, y, z, w = n.get("rotation", [0, 0, 0, 1])
        R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
        T[:3, :3] = R * np.array(n.get("scale", [1, 1, 1]))
        T[:3, 3] = n.get("translation", [0, 0, 0])
        return T

    def bounds(i, M):
        n = nodes[i]
        M2 = M @ local(n)
        lo, hi = np.full(3, 1e9), np.full(3, -1e9)
        if "mesh" in n:
            for p in j["meshes"][n["mesh"]]["primitives"]:
                a = j["accessors"][p["attributes"]["POSITION"]]
                for c in [[x, y, z, 1] for x in (a["min"][0], a["max"][0])
                          for y in (a["min"][1], a["max"][1]) for z in (a["min"][2], a["max"][2])]:
                    w = (M2 @ np.array(c))[:3]
                    lo, hi = np.minimum(lo, w), np.maximum(hi, w)
        for c in n.get("children", []):
            l, h = bounds(c, M2)
            lo, hi = np.minimum(lo, l), np.maximum(hi, h)
        return lo, hi
    out = {}
    for i, n in enumerate(nodes):
        if n.get("name", "").startswith("LIB_"):
            lo, hi = bounds(i, np.eye(4))
            out[n["name"][4:]] = [float(v) for v in (*lo, *hi)]
    return out


class Room:
    """Room frame: origin on the door wall at the door, v into the room."""

    def __init__(self, r, dims):
        x0, y0, x1, y1 = r["rect"]
        self.xa, self.xb, self.za, self.zb = x0, x1, -y1, -y0      # three space
        dx, dz = r["door"][0], -r["door"][1]
        cx, cz = (self.xa + self.xb) / 2, (self.za + self.zb) / 2
        if abs(cx - dx) > abs(cz - dz):
            self.d = (1.0 if cx > dx else -1.0, 0.0)
            self.rd, self.rw = abs(self.xb - self.xa), abs(self.zb - self.za)
        else:
            self.d = (0.0, 1.0 if cz > dz else -1.0)
            self.rd, self.rw = abs(self.zb - self.za), abs(self.xb - self.xa)
        self.u = (self.d[1], -self.d[0])
        self.o = (dx, dz)
        self.y = r["z"] + FLOOR_Y
        self.street = r["street"]
        self.lane = LANE_STREET if self.street else LANE
        self.dims, self.props, self.boxes = dims, [], []
        self.footprints = []

    def world(self, u, v):
        return (self.o[0] + u * self.u[0] + v * self.d[0], self.o[1] + u * self.u[1] + v * self.d[1])

    def put(self, key, u, v, face, up=0.0, scale=1.0):
        """face = (fu, fv): where the asset's front (+z) looks, room frame."""
        d = self.dims.get(key)
        if d is None:
            return False
        fx = face[0] * self.u[0] + face[1] * self.d[0]
        fz = face[0] * self.u[1] + face[1] * self.d[1]
        th = math.atan2(fx, fz)
        c, s = math.cos(th), math.sin(th)
        px, pz = self.world(u, v)
        lx0, lx1, lz0, lz1 = d[0] * scale, d[3] * scale, d[2] * scale, d[5] * scale
        corners = [(px + x * c + z * s, pz - x * s + z * c)
                   for x in (lx0, lx1) for z in (lz0, lz1)]
        ex0, ex1 = min(p[0] for p in corners), max(p[0] for p in corners)
        ez0, ez1 = min(p[1] for p in corners), max(p[1] for p in corners)
        m = 0.05   # must stay inside the clear room rect
        if ex0 < self.xa - m or ex1 > self.xb + m or ez0 < self.za - m or ez1 > self.zb + m:
            return False
        # lane: the footprint, in room coordinates, must not enter |u| < lane
        # (the street room's bay is wider); applies to solid items only
        if key not in NO_COL and key not in HANG:
            uu = [(p[0] - self.o[0]) * self.u[0] + (p[1] - self.o[1]) * self.u[1] for p in corners]
            if min(uu) < self.lane and max(uu) > -self.lane:
                return False
            for (q0, q1, r0, r1) in self.footprints:           # no overlap
                if not (ex1 < q0 or ex0 > q1 or ez1 < r0 or ez0 > r1):
                    return False
            self.footprints.append((ex0, ex1, ez0, ez1))
        self.props.append([key, round(px, 3), round(self.y + up, 3), round(pz, 3),
                           round(th, 4), scale])
        if key not in NO_COL:
            cxl, czl = (lx0 + lx1) / 2, (lz0 + lz1) / 2
            self.boxes.append([round(px + cxl * c + czl * s, 3), round(pz - cxl * s + czl * c, 3),
                               round((lx1 - lx0) / 2, 3), round((lz1 - lz0) / 2, 3),
                               round(self.y + d[1] * scale, 3), round(self.y + d[4] * scale, 3),
                               round(th, 4)])
        return True


IN, OUT, LEFT, RIGHT = (0, 1), (0, -1), (-1, 0), (1, 0)   # facing, room frame


def side_walls(R, keys, extra=None):
    """Shelving along both side walls (u = +-rw/2), facing the room centre."""
    for sgn in (-1, 1):
        v, n = 0.45, 0
        while True:
            key = keys[(n + (sgn > 0)) % len(keys)]
            d = R.dims.get(key)
            if d is None:
                break
            w = d[3] - d[0]
            if v + w > R.rd - 0.25:
                break
            u = sgn * (R.rw / 2 - 0.05) - sgn * d[5] * 0.0
            # asset back is at z = d[2] (<= 0): origin sits that far off the wall
            u = sgn * (R.rw / 2 + d[2] - 0.02)
            R.put(key, u, v + w / 2, (-sgn, 0))
            if extra:
                R.put(extra[n % len(extra)], u, v + w / 2, (-sgn, 0))
            v += w + 0.08
            n += 1


def table_set(R, u, v, chairs=("chair_wood",), table="table_round"):
    if not R.put(table, u, v, IN):
        return False
    R.put(chairs[0], u, v - 0.8, IN)
    R.put(chairs[0], u, v + 0.8, OUT)
    return True


def corner_items(R, sgn):
    R.put("wooden_crate_01", sgn * (R.rw / 2 - 0.65), R.rd - 0.35, OUT)
    R.put("ink_barrel", -sgn * (R.rw / 2 - 0.5), R.rd - 0.45, OUT)
    R.put("potted_plant_02", sgn * (R.rw / 2 - 0.55), 0.55, IN)


def furnish(R, kind, sgn):
    mid = R.rd * 0.52
    tab = R.rw / 2 - 1.15
    if kind == "shop":
        side_walls(R, ["shelf_goods_a", "shelf_goods_b"])
        R.put(("display_table_a", "display_table_b")[(sgn > 0) * 1], sgn * 2.15, mid + 0.2, IN)
        R.put("shop_counter", -sgn * 2.1, R.rd - 1.0, OUT)
        corner_items(R, sgn)
    elif kind == "cafe":
        table_set(R, -tab, mid, ("chair_wood",))
        table_set(R, tab, mid + 0.1, ("chair_wood",))
        R.put("counter_2m", sgn * 2.0, R.rd - 0.75, OUT)
        R.put("CashRegister_01", sgn * 2.0, R.rd - 0.75, OUT, up=1.12)
        R.put("menu_board", sgn * (R.rw / 2 - 0.05), 2.4, (-sgn, 0))
        corner_items(R, -sgn)
        R.put("lantern_hang", sgn * 2.0, mid, IN, up=3.4)
    elif kind == "library":
        side_walls(R, ["wooden_bookshelf_worn"], ["books_a", "books_b", "books_c"])
        R.put("rug_4x3", sgn * 1.9, mid, IN, scale=0.6)
        R.put("armchair_blue", sgn * 1.9, mid, IN)
        R.put("floor_lamp", sgn * (R.rw / 2 - 0.55), R.rd - 0.55, IN)
        R.put("potted_plant_02", -sgn * (R.rw / 2 - 0.55), 0.55, IN)
    else:   # workshop
        for k, v in enumerate((1.3, 2.9)):
            R.put("press_desk", sgn * (R.rw / 2 - 0.6), v + 0.1 * k, (-sgn, 0))
        R.put("shelf_goods_a", -sgn * (R.rw / 2 - 0.1), 1.7, (sgn, 0))
        corner_items(R, sgn)
        R.put("wooden_bookshelf_worn", sgn * 1.9, R.rd - 0.35, OUT)


def kind_for(lot, template, room):
    if room["floor"] == 0 and template in KINDS:
        return template
    return KINDS[(lot["id"] + room["i"] + room["floor"] + (room["tag"] == "N")) % len(KINDS)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lots", default="all")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    data = json.load(open(os.path.join(HERE, "out", "bones_all.json")))
    idx = {r["id"]: r for r in json.load(open(os.path.join(ASSETS, "interiors", "index.json")))}
    dims = lib_dims(os.path.join(ASSETS, "world-city3-library.glb"))
    want = None if a.lots == "all" else {int(v) for v in a.lots.split(",")}
    tot_p = tot_b = 0
    for lot in data:
        if want and lot["id"] not in want:
            continue
        tmpl = idx.get("shop-%d" % lot["id"], {}).get("template", "shop")
        props, boxes = [], []
        for room in lot["rooms"]:
            if (lot["id"], room["floor"]) in LEAVE_EMPTY:
                continue
            R = Room(room, dims)
            furnish(R, kind_for(lot, tmpl, room), 1 if (lot["id"] + room["i"] + room["floor"]) % 2 else -1)
            props += R.props
            boxes += R.boxes
        tot_p, tot_b = tot_p + len(props), tot_b + len(boxes)
        if a.dry_run:
            continue
        sid = "shop-%d" % lot["id"]
        with open(os.path.join(ASSETS, "interiors", sid + ".json"), "w") as f:
            json.dump({"id": sid, "library": "world-city3-library.glb", "props": props},
                      f, separators=(",", ":"))
        with open(os.path.join(ASSETS, "interiors", sid + ".col.json"), "w") as f:
            json.dump({"id": sid, "units": "m, three.js space: [cx, cz, hx, hz, y0, y1, rotY]",
                       "floorY": FLOOR_Y, "boxes": boxes, "seats": []}, f, separators=(",", ":"))
    print("props", tot_p, "boxes", tot_b)


if __name__ == "__main__":
    main()
