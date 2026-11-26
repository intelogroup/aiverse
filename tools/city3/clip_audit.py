"""Structural audit of the animation clips shipped in the cast GLBs.

    python3 tools/city3/clip_audit.py [glb ...] [--dir apps/console/public/assets]
                                      [--selftest]

Pure python: durations come from each sampler-input accessor's declared min/max,
so this reads a 54-clip rig in milliseconds without decoding a keyframe. The
cast GLBs are not meshopt-compressed, but nothing here depends on that.

Findings (exit 1 on the first three):
  * duplicate clip name            -- two clips, one name: the runtime plays one.
  * orphan channel                 -- a channel targeting a node that is not a
                                      joint of any skin (a broken bone target).
  * zero-length / empty clip       -- duration 0, or a sampler whose time range
                                      collapses: the clip plays as a freeze.
  * partial clip                   -- animates fewer joints than the file's modal
                                      count; reported, not failed (blink/look
                                      clips legitimately touch few bones).
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import glb as G  # noqa: E402

ROOT = os.path.abspath(f"{HERE}/../..")
DEFAULT_DIR = f"{ROOT}/apps/console/public/assets"


def audit_doc(doc):
    """-> (clips, findings) for one parsed glTF document."""
    g = G.GLB("doc", doc, b"", 0)
    clips = G.animations(g)
    names = {}
    for c in clips:
        names.setdefault(c["name"], []).append(c)
    findings = []
    for name, cs in names.items():
        if len(cs) > 1:
            findings.append(("duplicate name", f"{name} x{len(cs)}"))
    for c in clips:
        if c["duration"] <= 1e-6:
            findings.append(("zero-length clip", f"{c['name']} duration {c['duration']}"))
        if c["orphans"]:
            findings.append(("orphan channel", f"{c['name']} {c['orphans']} channels "
                              f"target non-joints"))
    modal = max((c["targets"] for c in clips), default=0)
    for c in clips:
        if 0 < c["targets"] < modal:
            findings.append(("partial clip", f"{c['name']} {c['targets']}/{modal} joints"))
    return clips, findings


def summarise(path, clips, findings):
    stems = [c["duration"] for c in clips]
    print(f"== {os.path.basename(path)}  clips {len(clips)}  "
          f"channels {sum(c['channels'] for c in clips)}  "
          f"duration {min(stems, default=0):.2f}-{max(stems, default=0):.2f} s")
    hard = [f for f in findings if f[0] in ("duplicate name", "orphan channel",
                                            "zero-length clip")]
    soft = [f for f in findings if f not in hard]
    if hard:
        for kind, detail in hard:
            print(f"  FAIL {kind:18s} {detail}")
    for kind, detail in soft[:6]:
        print(f"  note {kind:18s} {detail}")
    if len(soft) > 6:
        print(f"  note ... {len(soft) - 6} more")
    return len(hard)


def selftest(path):
    """Plant a duplicate, an orphan channel and a zero-length clip in a real doc."""
    g = G.load(path)
    doc = json.loads(json.dumps(g.doc))
    doc["animations"][1]["name"] = doc["animations"][0]["name"]
    doc["animations"].append(json.loads(json.dumps(doc["animations"][0])))
    doc["animations"][-1]["name"] = "Zero_Len_Planted"
    doc["accessors"].append({"count": 2, "componentType": 5126, "type": "SCALAR",
                             "min": [0.0], "max": [0.0]})
    zero_acc = len(doc["accessors"]) - 1
    doc["animations"][-1]["samplers"] = [dict(doc["animations"][0]["samplers"][0],
                                              input=zero_acc)]
    doc["animations"][-1]["channels"] = [dict(doc["animations"][0]["channels"][0],
                                              sampler=0)]
    bogus = len(doc["nodes"])
    doc["nodes"].append({"name": "W_orphan", "translation": [0, 0, 0]})
    doc["animations"][-1]["channels"].append(
        {"sampler": 0, "target": {"node": bogus, "path": "translation"}})
    clips, findings = audit_doc(doc)
    kinds = {f[0] for f in findings}
    return [("duplicate name planted", "caught", "duplicate name" in kinds),
            ("zero-length planted", "caught", "zero-length clip" in kinds),
            ("orphan channel planted", "caught", "orphan channel" in kinds)]


def pin(clips):
    """{clip name: duration} for one body — the thing a rename or retime breaks."""
    return {c["name"]: c["duration"] for c in clips}


def compare_pins(body, now, ref, tol=0.02):
    """-> list of drift descriptions between a pinned and current clip map."""
    out = []
    for name, dur in ref.items():
        if name not in now:
            out.append(f"{body}: clip '{name}' missing")
        elif dur > 0 and abs(now[name] - dur) / dur > tol:
            out.append(f"{body}: '{name}' {dur:.3f}s -> {now[name]:.3f}s")
    for name in now:
        if name not in ref:
            out.append(f"{body}: new clip '{name}' ({now[name]:.3f}s)")
    return out


def main(argv):
    paths = [a for a in argv if a.endswith((".glb", ".gltf"))]
    d = DEFAULT_DIR
    for a in argv:
        if a.startswith("--dir="):
            d = a[6:]
    pin_path = next((a.split("=", 1)[1] for a in argv if a.startswith("--pin=")), None)
    base_path = next((a.split("=", 1)[1] for a in argv if a.startswith("--baseline=")), None)
    if not paths:
        paths = sorted(os.path.join(d, f) for f in os.listdir(d)
                       if f.startswith("cast-") and f.endswith(".glb"))
    total_fail, rows, pins = 0, [], {}
    for p in paths:
        g = G.load(p)
        clips, findings = audit_doc(g.doc)
        total_fail += summarise(p, clips, findings)
        pins[os.path.basename(p)] = pin(clips)
        rows.append((os.path.basename(p), len(clips), len(findings), g))
    print(f"\nBODIES {len(rows)}  clips {sum(r[1] for r in rows)}  "
          f"findings {sum(r[2] for r in rows)}  hard failures {total_fail}")

    if pin_path:
        with open(pin_path, "w") as f:
            json.dump({"note": "pinned clip names + durations per body; re-pin after an "
                               "intended animation change", "bodies": pins}, f,
                      indent=1, sort_keys=True)
        print(f"PINNED {sum(len(v) for v in pins.values())} clips in {len(pins)} bodies "
              f"-> {pin_path}")
    if base_path and os.path.exists(base_path):
        ref = json.load(open(base_path))["bodies"]
        drift = []
        for body, now in pins.items():
            if body in ref:
                drift += compare_pins(body, now, ref[body])
        for line in drift[:10]:
            print(f"  FAIL {line}")
        print(f"  baseline {os.path.basename(base_path)}: {len(drift)} clip changes")
        total_fail += len(drift)

    if "--selftest" in argv:
        print("\nNEGATIVE CONTROLS (planted defects must be caught)")
        for name, expected, ok in selftest(paths[0]):
            print(f"  {'ok  ' if ok else 'FAIL'} {name:26s} expect {expected}")
            total_fail += 0 if ok else 1
    sys.exit(1 if total_fail else 0)


if __name__ == "__main__":
    main(sys.argv[1:])
