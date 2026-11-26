#!/usr/bin/env python3
"""Rebuild the bazaar stalls from the two downloaded variants.

    python3 tools/city3/bridge_stalls.py [--dry] [--glb PATH] [--out PATH]

Why a bridge, not a regeneration: the full city build needs gitignored source packs
this box does not have, so -- exactly like the other bridge_*.py here -- the same
intent is applied to the shipped GLB and proven by an accessor-level report.

What it changes, and why each part is needed (all measured, see stall_audit.py):
  1. Deletes the leftover procedural stall geometry. promote_stalls() only cleaned the
     positions it promoted on its own run, so 59 of 80 positions still carry ~66
     `palette` tris (four posts, rails, a counter) standing inside the model stall,
     plus a 2-triangle `awning` sheet at y=3.50 floating above the canopy.
  2. Replaces the single 600-tri `LIB_sk_med_stall` mesh (80 identical instances) with
     two downloaded CC-BY stalls, alternating per position: a cloth-canopy produce
     stall (2,599 tris) and a wooden counter stall (1,700 tris). Both carry goods, so
     no counter is bare; both measure under the shipped 3.12 x 1.64 m envelope so the
     aisle width is unchanged.
  3. Sets node scale to 1: the shipped nodes carried (1.4, 1.2, 1.4), which stretched
     the mesh non-uniformly; the new meshes are authored at world size.

The old mesh, its accessors and the palette textures stay in the file as dead weight
(600 tris), the same policy as replace_glb_detail.py: never re-pack what was not
asked to change.
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.expanduser("~/tmp-pip/pylibs"))
sys.path.insert(0, HERE)
from bridge_wave1 import Glb, load_glb, save_glb              # noqa: E402
from bridge_bazaar import rewrite_indices                     # noqa: E402
import stall_audit as audit_mod                               # noqa: E402

GLB = f"{HERE}/../../apps/console/public/assets/world-city3.glb"
SRC = f"{HERE}/out/stall-src"
KEYS = ("bufferViews", "accessors", "images", "samplers", "textures",
        "materials", "meshes", "nodes")
BOX = (2.4, 2.0, 0.1, 4.0)          # |dx|, |dz|, y_min, y_max around a stall centre


def append_mesh(doc, binary, path):
    """Append one detail GLB's data into the world and return its mesh indices.

    Same index-shifting contract as replace_glb_detail.append(): views move by the
    current BIN length, images are bufferViews, texture/material/mesh/accessor
    indices shift by their table lengths. Node tables are appended too but their
    roots are NOT added to the scene -- the stall nodes below own these meshes.
    """
    add, payload = load_glb(path)
    assert len(add["buffers"]) == 1 and not add.get("skins")
    off = {k: len(doc.get(k, [])) for k in KEYS}
    for view in add.get("bufferViews", []):
        assert not view.get("extensions"), "compressed detail not supported"
        view["buffer"] = 0
        view["byteOffset"] = view.get("byteOffset", 0) + len(binary)
    for acc in add.get("accessors", []):
        assert not acc.get("sparse")
        if "bufferView" in acc:
            acc["bufferView"] += off["bufferViews"]
    for img in add.get("images", []):
        assert "bufferView" in img and "uri" not in img
        img["bufferView"] += off["bufferViews"]
    for tex in add.get("textures", []):
        tex["source"] += off["images"]
        if "sampler" in tex:
            tex["sampler"] += off["samplers"]

    def shift(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key.endswith("Texture") and isinstance(child, dict) and "index" in child:
                    child["index"] += off["textures"]
                else:
                    shift(child)
        elif isinstance(value, list):
            for child in value:
                shift(child)

    for mat in add.get("materials", []):
        shift(mat)
    for mesh in add["meshes"]:
        for prim in mesh["primitives"]:
            assert not prim.get("targets")
            prim["attributes"] = {k: v + off["accessors"]
                                  for k, v in prim["attributes"].items()}
            if "indices" in prim:
                prim["indices"] += off["accessors"]
            if "material" in prim:
                prim["material"] += off["materials"]
    mesh_indices = [i + off["meshes"] for i in range(len(add["meshes"]))]
    for key in KEYS:
        doc.setdefault(key, []).extend(add.get(key, []))
    for key in ("extensionsUsed", "extensionsRequired"):
        for ext in add.get(key, []):
            if ext not in doc.setdefault(key, []):
                doc[key].append(ext)
    binary.extend(payload)
    return mesh_indices


def set_indices(glb, prim, values, vertex_count):
    """Write an index accessor back, whether or not its view is compressed.

    `rewrite_indices` from bridge_bazaar always emits an EXT_meshopt_compression
    block. The bazaar's `palette` and `awning` index accessors are 32-bit *plain*
    views (bufferViews 19690 / 19854 in the shipped file), so stamping that extension
    on them produced a GLB Blender refuses to open:
        KeyError: 'buffer'  (io/imp/gltf2_io_binary_meshopt.py:84)
    That is a file every loader would reject, so the branch below is load-bearing:
    plain views are overwritten in place (same count, same size, no extension).
    """
    acc = glb.gltf["accessors"][prim["indices"]]
    view = glb.gltf["bufferViews"][acc["bufferView"]]
    if (view.get("extensions") or {}).get("EXT_meshopt_compression"):
        rewrite_indices(glb, prim["indices"], values, vertex_count)
        return "meshopt"
    dt = {5121: "<u1", 5123: "<u2", 5125: "<u4"}[acc["componentType"]]
    raw = np.asarray(values, dtype=dt).tobytes()
    assert len(raw) == view["byteLength"], (len(raw), view["byteLength"])
    off = view.get("byteOffset", 0)
    glb.bin[off:off + len(raw)] = raw
    return "plain"


def clear_procedural(glb, centers, report):
    """Degenerate the leftover frame and awning-sheet triangles at every stall."""
    g = glb.gltf
    hx, hz, y0, y1 = BOX
    for mesh in g["meshes"]:
        name = mesh.get("name") or ""
        if name not in ("palette", "awning"):
            continue
        for prim in mesh["primitives"]:
            if "indices" not in prim:
                continue
            pos = glb.acc_raw(prim["attributes"]["POSITION"])
            tri = glb.indices_of(prim).astype(np.int64).reshape(-1, 3)
            if not len(tri):
                continue
            mid = pos[tri].mean(1)
            # Only live triangles count as "removed". The shipped file already carried
            # 3,720 degenerate `palette` + 118 degenerate `awning` triangles at these
            # boxes (bridge_bazaar.degenerate_inside killed the frames when it plugged
            # the model stalls); collapsing them again changes nothing on screen, so
            # reporting them as a fix would be a phantom finding -- the same trap as
            # the 872 "0-triangle" unindexed panels in this repo.
            area = 0.5 * np.linalg.norm(np.cross(pos[tri[:, 1]] - pos[tri[:, 0]],
                                                 pos[tri[:, 2]] - pos[tri[:, 0]]), axis=1)
            live = area > 1e-9
            kill = np.zeros(len(tri), dtype=bool)
            for x, z, _f in centers:
                kill |= ((np.abs(mid[:, 0] - x) < hx) & (np.abs(mid[:, 2] + z) < hz)
                         & (mid[:, 1] > y0) & (mid[:, 1] < y1))
            if not kill.any():
                continue
            report.setdefault("dead_at_boxes", {})[name] = (
                report.setdefault("dead_at_boxes", {}).get(name, 0)
                + int((kill & ~live).sum()))
            if not (kill & live).any():
                continue                      # nothing visible there: leave bytes alone
            tri = tri.copy()
            tri[kill & live, 1] = tri[kill & live, 0]
            tri[kill & live, 2] = tri[kill & live, 0]
            mode = set_indices(glb, prim, tri.ravel(), len(pos))
            report.setdefault("index_mode", {})[name] = mode
            report.setdefault("removed_tris", {})[name] = (
                report.setdefault("removed_tris", {}).get(name, 0)
                + int((kill & live).sum()))


def variant_for(x, z):
    """Alternate the two variants on a ~9 m grid so neighbours always differ."""
    return "a" if (int(abs(x) // 9) + int(abs(z) // 9)) % 2 == 0 else "b"


def apply(path, dry=False):
    glb = Glb(path)
    g = glb.gltf
    centers = audit_mod.stall_layout()
    report = {"glb": os.path.relpath(path, HERE), "positions": len(centers)}

    nodes = [n for n in g["nodes"] if (n.get("name") or "").startswith(audit_mod.STALL_PREFIX)]
    report["stall_nodes"] = len(nodes)

    files = {k: os.path.join(SRC, f"stall_{k}.glb") for k in ("a", "b")}
    for k, p in files.items():
        if not os.path.exists(p):
            sys.exit(f"missing {p} — run: blender -b --factory-startup --python "
                     f"tools/city3/stall_assets.py")
    if dry:
        print(json.dumps({**report, "src": {k: os.path.getsize(p) // 1024
                                            for k, p in files.items()}}, indent=1))
        return report

    clear_procedural(glb, centers, report)
    meshes = {}
    for k, p in files.items():
        idx = append_mesh(g, glb.bin, p)
        assert len(idx) == 1, f"{p} should carry exactly one mesh, got {idx}"
        meshes[k] = idx[0]
    report["mesh_index"] = meshes

    counts = {"a": 0, "b": 0}
    for n in nodes:
        t = n.get("translation", [0, 0, 0])
        k = variant_for(t[0], t[2])
        n["mesh"] = meshes[k]
        n["scale"] = [1.0, 1.0, 1.0]
        counts[k] += 1
    report["repointed"] = counts
    g.setdefault("extras", {})["bazaar_stall_replacement"] = {
        "variants": {k: os.path.basename(p) for k, p in files.items()},
        "credit": "Medieval Market Stall Asset 1/4 and 4/4, Ugur Yakisik, CC-BY 4.0",
    }
    return glb, report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--glb", default=GLB)
    ap.add_argument("--out", default=None, help="defaults to --glb, in place")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--report", default=f"{HERE}/out/stall-bridge.json")
    a = ap.parse_args()
    res = apply(a.glb, a.dry)
    if a.dry:
        return 0
    glb, report = res
    out = a.out or a.glb
    before = os.path.getsize(a.glb)
    save_glb(out, glb.gltf, glb.bin)
    report["bytes"] = {"before": before, "after": os.path.getsize(out)}
    json.dump(report, open(a.report, "w"), indent=1)
    print(json.dumps(report, indent=1))
    print(f"WROTE {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

