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


def prune(rows, cleared=ALL, key="id"):
    """rows without the ones whose `key` is a cleared shop lot; second value: the rows dropped"""
    gone = {f"shop-{i}" for i in cleared}
    return [r for r in rows if r[key] not in gone], [r[key] for r in rows if r[key] in gone]


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
        print("selftest ok"); sys.exit(0)
    for name, key, kw in (("city3-places.json", "id", {"indent": 1}), ("city3-anchors.json", "building", {"separators": (",", ":")})):
        rows = json.load(open(ASSETS + name))
        keep, gone = prune(rows, key=key)
        print(name, {"kept": len(keep), "dropped": len(gone)})
        if gone and not a.dry_run:
            with open(ASSETS + name, "w") as f:
                json.dump(keep, f, **kw)
                f.write("\n")
