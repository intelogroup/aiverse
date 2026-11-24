#!/usr/bin/env python3
"""Drop the shopfront places and the seats of lots bridge_bazaar_demolish.py cleared, from city3-places.json and city3-anchors.json.

A cleared lot is a lawn, but its place and its chairs stay in those files, so an agent can still go_to or enter the place and sit on a chair that stands
in the air. Idempotent. Neither file has a generator in this repo, so this is their one writer; re-run it after every demolition wave.

  python3 tools/city3/prune_places.py [--dry-run | --selftest]      (run from the repo root)
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bridge_bazaar_demolish import ALL


ASSETS = "apps/console/public/assets/"


def prune(rows, cleared=ALL, key="id", rooms=None):
    """rows without the ones whose `key` is a cleared shop lot, or (rooms given) a seat or place tied to a room that no longer exists; second value: the rows dropped"""
    gone = {f"shop-{i}" for i in cleared}
    dead = lambda r: r[key] in gone or (rooms is not None and (r.get("building") or r.get("room")) not in (None, *rooms))
    return [r for r in rows if not dead(r)], [r[key] for r in rows if dead(r)]


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        keep, gone = prune([{"id": "shop-1"}, {"id": "shop-124"}, {"id": "stall-0"}], {124})
        assert [p["id"] for p in keep] == ["shop-1", "stall-0"] and gone == ["shop-124"]
        keep, gone = prune([{"id": "c1", "building": "shop-124"}, {"id": "c2", "building": "tea"}], {124}, "building")
        assert [p["id"] for p in keep] == ["c2"] and gone == ["shop-124"]
        keep, gone = prune([{"id": "c3", "building": "press"}, {"id": "c4", "building": "tea"}, {"id": "stall-1"}], set(), "id", rooms={"tea"})
        assert [p["id"] for p in keep] == ["c4", "stall-1"] and gone == ["c3"], (keep, gone)
        print("selftest ok"); sys.exit(0)
    rooms = {r["id"] for r in json.load(open(ASSETS + "interiors/index.json"))}
    for name, key, kw in (("city3-places.json", "id", {"indent": 1}), ("city3-anchors.json", "building", {"separators": (",", ":")})):
        rows = json.load(open(ASSETS + name))
        keep, gone = prune(rows, key=key, rooms=rooms)
        print(name, {"kept": len(keep), "dropped": len(gone)})
        if gone and not a.dry_run:
            with open(ASSETS + name, "w") as f:
                json.dump(keep, f, **kw)
                f.write("\n")
