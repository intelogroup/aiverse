#!/usr/bin/env python3
"""Move each shopfront place of city3-places.json onto its room's real door (interiors/index.json).

The places were laid at the lot centre; the interior pass later put the door elsewhere on the same wall, up to 6 m away. scout.ts documents that a shopfront
stands at the door, and a go_to lot arrives at `stand`. `door`, `pos` and `stand` all move by the same vector, so the offset from the door to the stand keeps its
direction and length. Places with no room, and rooms with no door, are left alone. Idempotent.

  python3 tools/city3/sync_places.py [--dry-run | --selftest]      (run from the repo root)
"""
import argparse
import json
import sys

ASSETS = "apps/console/public/assets/"


def sync(places, rooms):
    """-> (places, moved ids). rooms: {room id: door [x, z]}"""
    moved = []
    for p in places:
        d = rooms.get(p.get("room"))
        if p["kind"] != "shopfront" or d is None:
            continue
        dx, dz = round(d[0] - p["door"][0], 3), round(d[1] - p["door"][1], 3)
        if abs(dx) < 0.05 and abs(dz) < 0.05:
            continue
        for k in ("pos", "stand", "door"):
            p[k] = [round(p[k][0] + dx, 2), round(p[k][1] + dz, 2)]
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
        print("selftest ok"); sys.exit(0)
    rooms = {e["id"]: e["door"] for e in json.load(open(ASSETS + "interiors/index.json")) if e.get("door")}
    places, moved = sync(json.load(open(ASSETS + "city3-places.json")), rooms)
    print({"moved": len(moved)}, moved[:8])
    if moved and not a.dry_run:
        with open(ASSETS + "city3-places.json", "w") as f:
            json.dump(places, f, indent=1)
            f.write("\n")
