"""Far-shell builder for district streaming.

Reads the five per-district visual GLBs, decodes them (meshopt + filters),
and emits ONE small GLB (world-shell.glb) holding a box-massing stand-in per
district: every substantial mesh node becomes its world-space bounding box,
ground-like slabs become flat plates, small props are dropped (invisible at
shell distance anyway). One merged mesh per district under a node named
`shell_<district-id>` so the console can hide a district's shell the moment
its real geometry streams in. (Underscore, not a colon: GLTFLoader runs
node names through PropertyBinding.sanitizeNodeName, which strips `:`
— a `shell:<id>` node arrives in the scene as `shell<id>` and a prefix
match on the colon form silently never fires.) Island plates guarantee
no viewpoint ever sees a hole where an unloaded district sits.

Needs meshoptimizer + numpy (pip). Run from anywhere:
  python3 tools/city3/build_shell.py apps/console/public/assets apps/console/public/assets/world-shell.glb
"""
import json, struct, sys
import numpy as np
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from split_census import GLB, node_world_matrices, DISTRICTS

# Muted per-district tints (read as massing, not as the real materials).
TINTS = {
    "bazaar": (0.76, 0.62, 0.44), "glassq": (0.55, 0.65, 0.72),
    "foundry": (0.62, 0.50, 0.42), "terraces": (0.55, 0.66, 0.47),
    "halo": (0.78, 0.66, 0.47),
}
FILES = {"bazaar": "world-city3.glb", "glassq": "world-glassq.glb", "foundry": "world-foundry.glb",
         "terraces": "world-terraces.glb", "halo": "world-halo.glb"}

def box_tris(bmin, bmax):
    """12 triangles (positions only; normals computed flat later) for an AABB."""
    x0, y0, z0 = bmin; x1, y1, z1 = bmax
    faces = [
        # +y top, -y bottom
        [(x0, y1, z0), (x1, y1, z0), (x1, y1, z1)], [(x0, y1, z0), (x1, y1, z1), (x0, y1, z1)],
        [(x0, y0, z0), (x1, y0, z1), (x1, y0, z0)], [(x0, y0, z0), (x0, y0, z1), (x1, y0, z1)],
        # +x, -x
        [(x1, y0, z0), (x1, y1, z0), (x1, y1, z1)], [(x1, y0, z0), (x1, y1, z1), (x1, y0, z1)],
        [(x0, y0, z0), (x0, y1, z1), (x0, y1, z0)], [(x0, y0, z0), (x0, y0, z1), (x0, y1, z1)],
        # +z, -z
        [(x0, y0, z1), (x1, y1, z1), (x1, y0, z1)], [(x0, y0, z1), (x0, y1, z1), (x1, y1, z1)],
        [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0)], [(x0, y0, z0), (x1, y1, z0), (x0, y1, z0)],
    ]
    return [v for f in faces for v in f]

def build(assets, out_path):
    all_pos, all_col, all_norm = [], [], []
    meshes_meta = []  # (name, vertex_start, vertex_count) per district group mesh
    report = {}
    for did, fname in FILES.items():
        cx, cz, half = DISTRICTS[did]
        g = GLB(f"{assets}/{fname}")
        mats = node_world_matrices(g.j)
        verts = []
        kept = skipped = 0
        frag_cells = {}
        for ni, n in enumerate(g.j.get("nodes", [])):
            if "mesh" not in n:
                continue
            mesh = g.j["meshes"][n["mesh"]]
            lname = (n.get("name", "") + " " + mesh.get("name", "")).lower()
            if "water" in lname or "sea" in lname:
                skipped += 1
                continue
            M = mats.get(ni, np.eye(4))
            bmin = np.array([np.inf] * 3); bmax = np.array([-np.inf] * 3)
            for prim in mesh["primitives"]:
                pos = g.accessor(prim["attributes"]["POSITION"])
                lo = pos.min(axis=0).astype(np.float64); hi = pos.max(axis=0).astype(np.float64)
                c = np.array([[x, y, z, 1.0] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
                w = c @ M.T
                bmin = np.minimum(bmin, w[:, :3].min(axis=0)); bmax = np.maximum(bmax, w[:, :3].max(axis=0))
            bmin[0] += cx; bmax[0] += cx; bmin[2] += cz; bmax[2] += cz
            dx, dy, dz = float(bmax[0] - bmin[0]), float(bmax[1] - bmin[1]), float(bmax[2] - bmin[2])
            ground_like = (dx >= 150 or dz >= 150) and dy <= 2.5
            building = dy >= 2.5 and (dx * dz >= 9 or dx * dy >= 12 or dz * dy >= 12)  # walls are thin: any two substantial dimensions
            if ground_like:
                top = float(bmax[1])
                verts += box_tris((bmin[0], top - 0.6, bmin[2]), (bmax[0], top, bmax[2]))
                kept += 1
            elif building:
                verts += box_tris(tuple(bmin), tuple(bmax))
                kept += 1
            elif dy >= 1.2:
                # Fragment (one wall/roof/prop of a larger structure): aggregate
                # into 12 m grid cells below so the massing reads as blocks.
                cen = (bmin + bmax) / 2
                key = (int(cen[0] // 12), int(cen[2] // 12))
                cell = frag_cells.setdefault(key, [bmin.copy(), bmax.copy()])
                cell[0] = np.minimum(cell[0], bmin); cell[1] = np.maximum(cell[1], bmax)
                skipped += 1
            else:
                skipped += 1
        for lo, hi in frag_cells.values():
            verts += box_tris(tuple(lo), tuple(hi))
            kept += 1
        # Island plate: guarantees the district reads as land from any range.
        verts += box_tris((cx - half, -2.5, cz - half), (cx + half, -0.05, cz + half))
        start = len(all_pos)
        base = np.array(TINTS[did])
        for v in verts:
            all_pos.append(v)
            h = min(max((v[1] / 60.0), 0.0), 0.55)  # taller = lighter
            tint = base * (0.82 + h)
            all_col.append(tuple(min(float(c), 1.0) for c in tint))
        # Flat normals per face (each consecutive triple is one triangle).
        for i in range(0, len(verts), 3):
            a, b, c = (np.array(verts[i + k], dtype=np.float64) for k in range(3))
            nrm = np.cross(b - a, c - a)
            L = np.linalg.norm(nrm)
            nrm = nrm / L if L > 0 else np.array([0.0, 1.0, 0.0])
            for _ in range(3):
                all_norm.append(tuple(nrm))
        meshes_meta.append((f"shell_{did}", start, len(verts)))
        report[did] = {"kept_boxes": kept + 1, "skipped_nodes": skipped, "verts": len(verts)}
    pos = np.array(all_pos, dtype=np.float32)
    col = np.array(all_col, dtype=np.float32)
    nrm = np.array(all_norm, dtype=np.float32)
    # BIN layout: positions, colors, normals, then one index buffer per
    # district (each district mesh draws only its own vertex range).
    binbuf = bytearray(); views = []
    for arr in (pos, col, nrm):
        views.append({"buffer": 0, "byteOffset": len(binbuf), "byteLength": arr.nbytes})
        binbuf += arr.tobytes()
    accessors = [
        {"bufferView": 0, "componentType": 5126, "count": len(pos), "type": "VEC3",
         "min": pos.min(axis=0).tolist(), "max": pos.max(axis=0).tolist()},
        {"bufferView": 1, "componentType": 5126, "count": len(col), "type": "VEC3"},
        {"bufferView": 2, "componentType": 5126, "count": len(nrm), "type": "VEC3"},
    ]
    meshes, nodes = [], []
    for name, start, count in meshes_meta:
        sub = np.arange(start, start + count, dtype=np.uint32)
        views.append({"buffer": 0, "byteOffset": len(binbuf), "byteLength": sub.nbytes})
        binbuf += sub.tobytes()
        accessors.append({"bufferView": len(views) - 1, "componentType": 5125, "count": count, "type": "SCALAR"})
        meshes.append({"name": name, "primitives": [{"attributes": {"POSITION": 0, "COLOR_0": 1, "NORMAL": 2},
                                                      "indices": len(accessors) - 1, "material": 0}]})
        nodes.append({"name": name, "mesh": len(meshes) - 1})
    views2, accessors2, binbuf2 = views, accessors, binbuf
    gltf = {
        "asset": {"version": "2.0", "generator": "aiverse build_shell.py (district far shell)"},
        "scene": 0, "scenes": [{"nodes": list(range(len(nodes)))}],
        "nodes": nodes, "meshes": meshes,
        "materials": [{"name": "shell", "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "roughnessFactor": 0.95, "metallicFactor": 0.0}}],
        "accessors": accessors2, "bufferViews": views2,
        "buffers": [{"byteLength": len(binbuf2)}],
    }
    js = json.dumps(gltf, separators=(",", ":")).encode()
    while len(js) % 4:
        js += b" "
    with open(out_path, "wb") as f:
        f.write(b"glTF" + struct.pack("<II", 2, 12 + 8 + len(js) + 8 + len(binbuf2)))
        f.write(struct.pack("<I", len(js)) + b"JSON" + js)
        f.write(struct.pack("<I", len(binbuf2)) + b"BIN\x00" + binbuf2)
    print(json.dumps({"out": out_path, "bytes": 12 + 8 + len(js) + 8 + len(binbuf2), "districts": report}, indent=1))

if __name__ == "__main__":
    build(sys.argv[1], sys.argv[2])
