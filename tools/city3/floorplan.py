"""Print a walkable floor plan for a placed house, from its collision GLB.

    python3 tools/city3/floorplan.py <collision.glb> <originX> <originZ> [--cell 0.35]

Floor = triangles whose vertices all sit on the walk slab (y 0.40..0.56 by default); wall = a
triangle that spans y 1.0..1.6 at that spot. The house's live origin comes from districts.json
(`origin`) and the collision GLB is already rotated to the lot, so no extra yaw is applied here.
"""
import argparse, json, math, struct, sys


def read_glb(path):
    b = open(path, "rb").read()
    jl = struct.unpack("<I", b[12:16])[0]
    return json.loads(b[20:20 + jl]), b, 20 + jl + 8


def accessor(doc, bin0, data, index):
    a = doc["accessors"][index]
    view = doc["bufferViews"][a["bufferView"]]
    off = bin0 + view.get("byteOffset", 0) + a.get("byteOffset", 0)
    comp = {5126: "f", 5125: "I", 5123: "H", 5121: "B"}[a["componentType"]]
    width = {"SCALAR": 1, "VEC3": 3, "VEC2": 2, "VEC4": 4}[a["type"]]
    vals = struct.unpack_from("<" + comp * (a["count"] * width), data, off)
    return [vals[i * width:(i + 1) * width] for i in range(a["count"])]


def mul(A, B):
    return [[sum(A[i][k] * B[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def node_matrix(n):
    if "matrix" in n:
        m = n["matrix"]
        return [[m[c * 4 + r] for c in range(4)] for r in range(4)]
    t = n.get("translation", [0, 0, 0])
    x, y, z, w = n.get("rotation", [0, 0, 0, 1])
    s = n.get("scale", [1, 1, 1])
    R = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
         [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
         [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
    return [[R[i][j] * s[j] for j in range(3)] + [t[i]] for i in range(3)] + [[0, 0, 0, 1]]


def apply(M, p):
    return [M[i][0] * p[0] + M[i][1] * p[1] + M[i][2] * p[2] + M[i][3] for i in range(3)]


IDENT = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("glb")
    ap.add_argument("ox", type=float)
    ap.add_argument("oz", type=float)
    ap.add_argument("--cell", type=float, default=0.35)
    ap.add_argument("--floor", type=float, nargs=2, default=[0.40, 0.56])
    args = ap.parse_args()
    doc, data, bin0 = read_glb(args.glb)
    floor, walls = [], []

    def walk(ni, M):
        n = doc["nodes"][ni]
        M2 = mul(M, node_matrix(n))
        if "mesh" in n:
            for pr in doc["meshes"][n["mesh"]]["primitives"]:
                P = [apply(M2, p) for p in accessor(doc, bin0, data, pr["attributes"]["POSITION"])]
                I = [i[0] for i in accessor(doc, bin0, data, pr["indices"])] if "indices" in pr else list(range(len(P)))
                for k in range(0, len(I), 3):
                    T = [P[I[k]], P[I[k + 1]], P[I[k + 2]]]
                    lo, hi = min(t[1] for t in T), max(t[1] for t in T)
                    if all(args.floor[0] <= t[1] <= args.floor[1] for t in T):
                        floor.append(T)
                    elif hi > 1.0 and lo < 1.6:
                        walls.append(T)
        for c in n.get("children", []):
            walk(c, M2)

    for r in doc["scenes"][doc.get("scene", 0)]["nodes"]:
        walk(r, IDENT)
    if not floor:
        sys.exit("no floor triangles in that y band; widen --floor")
    xs = [p[0] + args.ox for T in floor for p in T]
    zs = [p[2] + args.oz for T in floor for p in T]
    x0, x1, z0, z1 = min(xs), max(xs), min(zs), max(zs)
    W = int((x1 - x0) / args.cell) + 2
    H = int((z1 - z0) / args.cell) + 2
    grid = [[" "] * W for _ in range(H)]

    def fill(T, ch):
        pts = [(p[0] + args.ox, p[2] + args.oz) for p in T]
        a, c = min(p[0] for p in pts), max(p[0] for p in pts)
        b, e = min(p[1] for p in pts), max(p[1] for p in pts)
        for i in range(int((a - x0) / args.cell), int((c - x0) / args.cell) + 1):
            for j in range(int((b - z0) / args.cell), int((e - z0) / args.cell) + 1):
                if 0 <= i < W and 0 <= j < H:
                    grid[j][i] = ch

    for T in floor:
        fill(T, ".")
    for T in walls:
        fill(T, "#")
    print(f"floor x {x0:.2f}..{x1:.2f}  z {z0:.2f}..{z1:.2f}  ({len(floor)} tris, {len(walls)} wall tris)")
    for j, row in enumerate(grid):
        print(f"{z0 + j * args.cell:7.2f} |" + "".join(row) + "|")
    print(f"        x {x0:.1f} .. {x1:.1f}   one cell = {args.cell} m")


main()
