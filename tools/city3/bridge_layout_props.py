"""Fix prop collisions in the shipped layout JSONs, geometrically, without a rebuild.

    python3 tools/city3/bridge_layout_props.py [--write] [--rooms shop-103,...]

Why: the placement audit found 110 colliding pairs (47 counters, now fixed by the HQ
override). The rest are layout classes that only a generator run would normally fix,
and this box cannot run the generator (no Poly Haven sources). This pass applies the
same decisions the source fixes make, but to the committed JSONs:

  drop      a prop whose whole footprint sits inside another prop at the same support
            level and that has nowhere free to go -- the workshop's lone bookcase
            buried in the 2.0 m shelf run is the case that matters.
  move      a prop into the nearest free spot found on a ring search (0.1 m steps,
            8 directions, up to 2 m): cafe plants meeting the back-wall shelving, ink
            barrels standing inside desks.
  respace   paper stacks that are closer than their own footprint.

Idempotent: a second run finds nothing. Every change is printed with the room and the
prop before it is written, and `--write` is opt-in.
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import placement_audit as P  # noqa: E402

DEFAULT_LIB = os.path.abspath(
    f"{HERE}/../../apps/console/public/assets/world-city3-hq.glb,"
    f"{HERE}/../../apps/console/public/assets/world-city3-library.glb")


def free_spot(box, others, room, wall=0.05, pen=0.02, radius=2.0):
    """Nearest point for a box that is inside the room and clear of `others`."""
    x0, z0, x1, z1 = room["rect"]
    for step in range(0, int(radius / 0.1) + 1):
        r = step * 0.1
        for k in range(8 if r else 1):
            a = k * math.pi / 4
            cx, cz = box["x"] + r * math.cos(a), box["z"] + r * math.sin(a)
            cand = dict(box, x=cx, z=cz)
            if any(not (x0 - wall <= px <= x1 + wall and z0 - wall <= pz <= z1 + wall)
                   for px, pz in P.corners(cx, cz, cand["hx"], cand["hz"], cand["rot"])):
                continue
            clash = False
            for o in others:
                if abs(o["y0"] - cand["y0"]) > 0.02:
                    continue
                if P.sat_depth((cand["x"], cand["z"], cand["hx"], cand["hz"], cand["rot"]),
                               (o["x"], o["z"], o["hx"], o["hz"], o["rot"])) > pen:
                    clash = True
                    break
            if not clash:
                return round(cx, 3), round(cz, 3), r
    return None


def fix_room(room, props, dims, wall=0.05, pen=0.02, small=1.5):
    """-> (new_props, actions). Only SMALL props are moved or dropped.

    A decorative plant must never push a counter or a shelving run: the victim of a
    collision is the prop with the smaller footprint, and if both are large (two
    counters, a shelf against a bookcase) the layout is left alone -- that class is
    the library/asset's problem, not the layout's.
    """
    out = [list(p) for p in props]
    actions = []
    for _ in range(4):
        boxes = [(i, P.prop_box(p, dims)) for i, p in enumerate(out)]
        boxes = [(i, b) for i, b in boxes if b]
        changed = False
        for n in range(len(boxes)):
            i, a = boxes[n]
            for j, b in boxes:
                if j == i or abs(a["y0"] - b["y0"]) > 0.02:
                    continue
                if P.sat_depth((a["x"], a["z"], a["hx"], a["hz"], a["rot"]),
                               (b["x"], b["z"], b["hx"], b["hz"], b["rot"])) <= pen:
                    continue
                if P.contained(a, b) or P.contained(b, a):
                    continue
                area_a = 4 * a["hx"] * a["hz"]
                area_b = 4 * b["hx"] * b["hz"]
                if min(area_a, area_b) > small:
                    continue                       # both are fixtures: leave the layout
                victim = a if area_a <= area_b else b
                vi = i if victim is a else j
                spot = free_spot(victim, [o for k, o in boxes if k != vi], room, wall, pen)
                if spot:
                    out[vi][1], out[vi][3] = spot[0], spot[1]
                    actions.append((room["id"], "move", out[vi][0],
                                    f"({victim['x']:.2f},{victim['z']:.2f}) -> "
                                    f"({spot[0]:.2f},{spot[1]:.2f}) r={spot[2]:.1f} m, "
                                    f"clears {(b if victim is a else a)['key']}"))
                else:
                    actions.append((room["id"], "drop", out[vi][0],
                                    f"no free spot within 2 m, was colliding "
                                    f"{(b if victim is a else a)['key']}"))
                    out[vi] = None
                changed = True
                break
            if changed:
                break
        out = [p for p in out if p is not None]
        if not changed:
            break
    return out, actions



def main(argv):
    write = "--write" in argv
    lib = DEFAULT_LIB
    only = None
    for j, a in enumerate(argv):
        if a.startswith("--lib="):
            lib = a[6:]
        elif a == "--lib" and j + 1 < len(argv):
            lib = argv[j + 1]
        elif a.startswith("--rooms="):
            only = set(a[8:].split(","))
        elif a == "--rooms" and j + 1 < len(argv):
            only = set(argv[j + 1].split(","))
    dims = P.library_dims(lib)
    rooms = P.load_rooms(P.DEFAULT_INDEX, P.DEFAULT_LAYOUTS)
    total, touched = 0, 0
    for room, props in rooms:
        if only and room["id"] not in only:
            continue
        new, actions = fix_room(room, props, dims)
        if not actions:
            continue
        touched += 1
        total += len(actions)
        for rid, kind, key, detail in actions:
            print(f"  {rid:10s} {kind:5s} {key:18s} {detail}")
        if write:
            path = os.path.join(P.DEFAULT_LAYOUTS, f"{room['id']}.json")
            doc = json.load(open(path))
            doc["props"] = new
            with open(path, "w") as f:
                json.dump(doc, f, separators=(",", ":"))
    print(f"{'WROTE' if write else 'DRY RUN'}: {total} actions in {touched} rooms")
    if not write and total:
        print("re-run with --write, then placement_audit --update-baseline")


if __name__ == "__main__":
    main(sys.argv[1:])
