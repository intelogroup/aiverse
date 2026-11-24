#!/usr/bin/env python3
"""Add one shopfront place per citadel lot (shop-148..155) to city3-places.json.

The citadel townhouses are visual kits with no interior room, so these places have no `room`/`door`: go_to arrives at `stand`, 0.4 m outside the
frontage centre; `heading` faces outward (S 0, N pi, E pi/2, W -pi/2), the same convention as the other shopfronts. The name comes from the lot's first kit.
Lot rects and kits are read from the same plan the pass uses (bridge_citadel_townhouses.build_plan), so a re-dressed lot (swap_citadel_lot.py) renames
on a rerun if given its slugs with --slugs LOT=a,b,c. Idempotent: an existing place of the same id is replaced.

  python3 tools/city3/add_citadel_places.py [--dry-run] [--slugs 155=guingamp_shop_1,nivelles_house_1,bordeaux_flat_1_corner]   (repo root)
"""
import argparse
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
PLACES = "apps/console/public/assets/city3-places.json"
OUT = 0.4
HEADING = {"S": 0.0, "N": math.pi, "E": math.pi / 2, "W": -math.pi / 2}
# a kit's display name is its slug, title-cased: "troyes_shop_7" -> "Troyes Shop 7"
NAME = lambda slug: " ".join(w.capitalize() for w in slug.split("_"))


def place_for(lot, slug):
    x0, z0, x1, z1 = lot["rect"]
    f = lot["face"]
    cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    pos = {"S": (cx, z1), "N": (cx, z0), "E": (x1, cz), "W": (x0, cz)}[f]
    dx, dz = {"S": (0, OUT), "N": (0, -OUT), "E": (OUT, 0), "W": (-OUT, 0)}[f]
    return {"id": f"shop-{lot['id']}", "kind": "shopfront", "name": f"Citadel {NAME(slug)}", "pos": [round(pos[0], 2), round(pos[1], 2)],
            "heading": round(HEADING[f], 5), "stand": [round(pos[0] + dx, 2), round(pos[1] + dz, 2)]}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--slugs", action="append", default=[], help="LOT=slug,slug: the kits a re-dressed lot now has (default: the pass's plan)")
    a = ap.parse_args()
    import bridge_citadel_townhouses as T
    plan, _ = T.build_plan()
    over = {int(k): v.split(",") for k, v in (s.split("=") for s in a.slugs)}
    new = [place_for(p["lot"], over.get(lid, [it["slug"] for it in p["items"]])[0]) for lid, p in sorted(plan.items())]
    places = json.load(open(PLACES))
    keep = [p for p in places if p["id"] not in {n["id"] for n in new}]
    out = keep + new
    for n in new:
        print(json.dumps(n))
    if not a.dry_run:
        json.dump(out, open(PLACES, "w"), indent=1)
        open(PLACES, "a").write("\n")
        print("wrote", PLACES, len(out), "places")
