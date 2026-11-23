#!/usr/bin/env python3
"""Move each shopfront place of city3-places.json onto its room's real door (interiors/index.json).

The places were laid at the lot centre; the interior pass later put the door elsewhere on the same wall, up to 6 m away. scout.ts documents that a shopfront
stands at the door, and a go_to lot arrives at `stand`. `door`, `pos` and `stand` all move by the same vector, so the offset from the door to the stand keeps its
direction and length. A stand that sits on the door line itself (a shop-103 style wall-line point) goes OUT_OF_DOOR m outside it, away from the room: a stand on the wall
line flips between reachable and "no safe route" with the navmesh grid (shop-103 did after the 2026-11 rebakes; 0.3 m outside arrives). Places with no room, and rooms
with no door, are left alone. Idempotent.

  python3 tools/city3/sync_places.py [--dry-run | --selftest]      (run from the repo root)
"""
import argparse
import json
import sys

ASSETS = "apps/console/public/assets/"
OUT_OF_DOOR = 0.4


def sync(places, rooms, rects=None):
    """-> (places, moved ids). rooms: {room id: door [x, z]}; rects: {room id: [x0, z0, x1, z1]} for the step out of the door"""
    moved = []
    for p in places:
        d = rooms.get(p.get("room"))
        if p["kind"] != "shopfront" or d is None:
            continue
        dx, dz = round(d[0] - p["door"][0], 3), round(d[1] - p["door"][1], 3)
        if abs(dx) >= 0.05 or abs(dz) >= 0.05:
            for k in ("pos", "stand", "door"):
                p[k] = [round(p[k][0] + dx, 2), round(p[k][1] + dz, 2)]
            moved.append(p["id"])
        r = (rects or {}).get(p["room"])
        if r and abs(p["stand"][0] - p["door"][0]) < 0.2 and abs(p["stand"][1] - p["door"][1]) < 0.2:
            ex, ez = p["door"][0] - (r[0] + r[2]) / 2, p["door"][1] - (r[1] + r[3]) / 2
            ox, oz = (1 if ex > 0 else -1, 0) if abs(ex) > abs(ez) else (0, 1 if ez > 0 else -1)
            p["stand"] = [round(p["door"][0] + ox * OUT_OF_DOOR, 2), round(p["door"][1] + oz * OUT_OF_DOOR, 2)]
            if p["id"] not in moved:
                moved.append(p["id"])
    return places, moved


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        pl, m = sync([{"id": "shop-1", "kind": "shopfront", "room": "shop-1", "pos": [0, 5], "stand": [0, 3], "door": [0, 5]}, {"id": "stall-0", "kind": "stall"}], {"shop-1": [4, 5]})
        assert m == ["shop-1"] and pl[0]["door"] == [4, 5] and pl[0]["stand"] == [4, 3] and pl[0]["pos"] == [4, 5]
        assert sync(pl, {"shop-1": [4, 5]})[1] == []   # idempotent
        pl = [{"id": "shop-2", "kind": "shopfront", "room": "shop-2", "pos": [0, -10], "stand": [0, -10], "door": [0, -10]}]   # stand on the wall line, front toward -z
        pl, m = sync(pl, {"shop-2": [0, -10]}, {"shop-2": [-5, -10, 5, 2]})
        assert m == ["shop-2"] and pl[0]["stand"] == [0, -10.4] and pl[0]["door"] == [0, -10], pl
        assert sync(pl, {"shop-2": [0, -10]}, {"shop-2": [-5, -10, 5, 2]})[1] == []
        print("selftest ok"); sys.exit(0)
    idx = [e for e in json.load(open(ASSETS + "interiors/index.json")) if e.get("door")]
    rooms, rects = {e["id"]: e["door"] for e in idx}, {e["id"]: e["rect"] for e in idx}
    places, moved = sync(json.load(open(ASSETS + "city3-places.json")), rooms, rects)
    print({"moved": len(moved)}, moved[:8])
    if moved and not a.dry_run:
        with open(ASSETS + "city3-places.json", "w") as f:
            json.dump(places, f, indent=1)
            f.write("\n")
