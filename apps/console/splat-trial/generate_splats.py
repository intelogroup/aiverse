#!/usr/bin/env python3
"""Procedurally generate 3DGS PLY splats shaped as a bazaar stall.

Zero-spend, reproducible (fixed seed). The byte layout matches the
verified Blender 5.3 probe file
(~/workspace/your_files/blender-5.3-probe/synthetic_splats.ply, whose
generator is blender53-verify/scripts/probe4a_splats.py):

  ply / format binary_little_endian 1.0 / element vertex N
  17 float properties: x y z nx ny nz f_dc_0 f_dc_1 f_dc_2 opacity
  scale_0 scale_1 scale_2 rot_0 rot_1 rot_2 rot_3

Conventions inherited from the probe: colors are stored as SH DC
coefficients f_dc = (rgb - 0.5) / SH_C0; opacity is the raw logit
(2.0 in the probe, sigmoid ~0.88); scales are stored as log(metres);
rot_0 is the quaternion w component.

Authored in three.js space (Y-up, ground y=0, stall front faces +Z),
stall centre at the local origin, footprint ~3.4 m x 2.6 m, ridge
height ~2.8 m. Parts: 4 posts, gabled striped canopy + fringe,
counter, back shelf, goods (fruit mounds, spice bowls, cloth bolts,
pottery), rug, side crates, hanging lantern.

Usage: python3 generate_splats.py [outdir]
Writes bazaar-stall-262k.ply (exactly 262,144 gaussians — Spark's
default budget in the write-up this trial follows) and
bazaar-stall-1m.ply (exactly 1,000,000).
"""
import math
import os
import struct
import sys

import numpy as np

SH_C0 = 0.28209479177387814
SEED = 20261115

rng = np.random.default_rng(SEED)


def quat_from_unit_vectors(a, b):
    """Quaternion (w,x,y,z) rotating unit vector a onto unit vector b."""
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    d = float(np.dot(a, b))
    if d > 0.99999:
        return np.array([1.0, 0.0, 0.0, 0.0])
    if d < -0.99999:
        # 180 degrees: any orthogonal axis
        axis = np.array([1.0, 0.0, 0.0]) if abs(a[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
        axis = np.cross(a, axis)
        axis /= np.linalg.norm(axis)
        return np.array([0.0, *axis])
    axis = np.cross(a, b)
    q = np.array([1.0 + d, *axis])
    return q / np.linalg.norm(q)


def random_small_quats(n, max_deg=25.0):
    """Random near-identity quaternions (w,x,y,z), tilt <= max_deg."""
    axes = rng.normal(size=(n, 3))
    axes /= np.linalg.norm(axes, axis=1, keepdims=True)
    ang = np.radians(rng.uniform(0, max_deg, size=n)) / 2.0
    q = np.concatenate([np.cos(ang)[:, None], axes * np.sin(ang)[:, None]], axis=1)
    return q


class Cloud:
    """Accumulates gaussian attribute arrays part by part."""

    def __init__(self):
        self.pos = []
        self.nrm = []
        self.rgb = []
        self.opa = []
        self.scl = []
        self.rot = []

    def add(self, pos, nrm, rgb, opa, scl, rot):
        self.pos.append(np.asarray(pos, dtype=np.float64))
        self.nrm.append(np.asarray(nrm, dtype=np.float64))
        self.rgb.append(np.asarray(rgb, dtype=np.float64))
        self.opa.append(np.asarray(opa, dtype=np.float64))
        self.scl.append(np.asarray(scl, dtype=np.float64))
        self.rot.append(np.asarray(rot, dtype=np.float64))

    def total(self):
        return sum(len(p) for p in self.pos)

    def arrays(self):
        return {k: np.concatenate(v) for k, v in
                (("pos", self.pos), ("nrm", self.nrm), ("rgb", self.rgb),
                 ("opa", self.opa), ("scl", self.scl), ("rot", self.rot))}


def vary(color, amt, n):
    c = np.array(color)[None, :] + rng.uniform(-amt, amt, size=(n, 3))
    return np.clip(c, 0.02, 1.0)


def sample_box(n, lo, hi, rng):
    """Surface samples on an axis-aligned box (area-weighted faces)."""
    lo = np.array(lo, float)
    hi = np.array(hi, float)
    d = hi - lo
    areas = np.array([d[1] * d[2], d[1] * d[2], d[0] * d[2], d[0] * d[2],
                      d[0] * d[1], d[0] * d[1]])
    face = rng.choice(6, size=n, p=areas / areas.sum())
    pos = np.empty((n, 3))
    nrm = np.zeros((n, 3))
    uv = rng.uniform(size=(n, 2))
    for f in range(6):
        m = face == f
        if not m.any():
            continue
        ax = f // 2
        others = [i for i in range(3) if i != ax]
        pos[m, ax] = hi[ax] if f % 2 == 0 else lo[ax]
        nrm[m, ax] = 1.0 if f % 2 == 0 else -1.0
        pos[m, others[0]] = lo[others[0]] + uv[m, 0] * d[others[0]]
        pos[m, others[1]] = lo[others[1]] + uv[m, 1] * d[others[1]]
    return pos, nrm


def sample_sphere(n, center, r, rng, hemi=False):
    """Surface samples on a sphere (or upper hemisphere shell)."""
    u = rng.uniform(size=n)
    v = rng.uniform(size=n)
    if hemi:
        theta = np.arccos(1 - u * 0.92)  # bias away from the rim
    else:
        theta = np.arccos(2 * u - 1)
    phi = 2 * np.pi * v
    d = np.stack([np.sin(theta) * np.cos(phi), np.cos(theta),
                  np.sin(theta) * np.sin(phi)], axis=1)
    if np.isscalar(r):
        rr = np.full(n, r)
    else:
        rr = rng.uniform(r[0], r[1], size=n)
    return np.array(center)[None, :] + d * rr[:, None], d


def flat_quats(nrm):
    """Quaternions aligning local +Z to each normal (for disc splats)."""
    z = np.array([0.0, 0.0, 1.0])
    return np.stack([quat_from_unit_vectors(z, n) for n in nrm])


# ---------------------------------------------------------------------
# Stall parts. Each sampler takes an exact count n and adds to cloud.
# ---------------------------------------------------------------------

WOOD = (0.44, 0.29, 0.15)
WOOD_DARK = (0.34, 0.21, 0.11)
WOOD_LIGHT = (0.58, 0.40, 0.22)


def posts(c: Cloud, n):
    per = [n // 4] * 4
    per[-1] += n - sum(per)
    for k, (cx, cz) in enumerate([(-1.15, 0.85), (1.15, 0.85),
                                  (-1.15, -0.85), (1.15, -0.85)]):
        m = per[k]
        h = rng.uniform(0, 2.3, size=m)
        ang = rng.uniform(0, 2 * np.pi, size=m)
        rad = 0.055 * np.sqrt(rng.uniform(size=m))
        pos = np.stack([cx + rad * np.cos(ang), h, cz + rad * np.sin(ang)], axis=1)
        nrm = np.stack([np.cos(ang), np.zeros(m), np.sin(ang)], axis=1)
        c.add(pos, nrm, vary(WOOD, 0.05, m), np.full(m, 2.2),
              np.tile(np.log([0.045, 0.045, 0.045]), (m, 1)),
              random_small_quats(m))


def canopy(c: Cloud, n):
    # Two sloped panels: ridge along X at y=2.78, eaves at y=2.32.
    # Panel param: s in [0,1] from ridge to eave; width x in [-1.65, 1.65].
    fringe = max(64, n // 14)
    panels = n - fringe
    per = [panels // 2, panels - panels // 2]
    for side, m in enumerate(per):
        sgn = 1.0 if side == 0 else -1.0
        s = rng.uniform(size=m)
        x = rng.uniform(-1.65, 1.65, size=m)
        z = sgn * (0.12 + s * 1.18)
        y = 2.78 - s * 0.46
        pos = np.stack([x, y, z], axis=1)
        nrm = np.tile(np.array([0.0, 1.18, -sgn * 0.46]), (m, 1))
        nrm /= np.linalg.norm(nrm, axis=1, keepdims=True)
        stripe = ((x + 1.65) // 0.42) % 2
        base = np.where(stripe[:, None] == 0,
                        np.array([0.76, 0.30, 0.16]), np.array([0.92, 0.84, 0.68]))
        base = base + rng.uniform(-0.04, 0.04, size=(m, 3))
        c.add(pos, nrm, np.clip(base, 0.02, 1.0), np.full(m, 2.0),
              np.tile(np.log([0.062, 0.062, 0.014]), (m, 1)), flat_quats(nrm))
    # Fringe: dangling beads along both eaves.
    m = fringe
    for side_i, sgn in enumerate((1.0, -1.0)):
        k = m // 2 if side_i == 0 else m - m // 2
        x = np.linspace(-1.6, 1.6, k) + rng.uniform(-0.03, 0.03, size=k)
        pos = np.stack([x, 2.26 - rng.uniform(0, 0.05, size=k),
                        np.full(k, sgn * 1.32)], axis=1)
        col = np.where((np.arange(k) % 2)[:, None] == 0,
                       np.array([0.85, 0.55, 0.12]), np.array([0.70, 0.22, 0.14]))
        c.add(pos, np.tile([0.0, 0.0, sgn], (k, 1)), col, np.full(k, 2.2),
              np.tile(np.log([0.03, 0.045, 0.03]), (k, 1)), random_small_quats(k))


def counter(c: Cloud, n):
    body_n = int(n * 0.62)
    top_n = n - body_n
    pos, nrm = sample_box(body_n, (-1.3, 0.06, 0.38), (1.3, 0.98, 0.92), rng)
    c.add(pos, nrm, vary(WOOD_DARK, 0.05, body_n), np.full(body_n, 2.2),
          np.tile(np.log([0.045, 0.045, 0.045]), (body_n, 1)),
          random_small_quats(body_n))
    pos, nrm = sample_box(top_n, (-1.38, 0.98, 0.30), (1.38, 1.05, 1.0), rng)
    c.add(pos, nrm, vary(WOOD_LIGHT, 0.05, top_n), np.full(top_n, 2.2),
          np.tile(np.log([0.045, 0.045, 0.045]), (top_n, 1)),
          random_small_quats(top_n))


def back_shelf(c: Cloud, n):
    pos, nrm = sample_box(n, (-1.25, 0.05, -0.98), (1.25, 0.78, -0.58), rng)
    c.add(pos, nrm, vary(WOOD, 0.05, n), np.full(n, 2.2),
          np.tile(np.log([0.045, 0.045, 0.045]), (n, 1)),
          random_small_quats(n))


def mound(c: Cloud, n, center, r, color, splat=0.03):
    pos, nrm = sample_sphere(n, center, r, rng, hemi=True)
    # Squash the hemisphere into a pile and sink its base.
    pos[:, 1] = center[1] + (pos[:, 1] - center[1]) * 0.62
    c.add(pos, nrm, vary(color, 0.06, n), np.full(n, 2.4),
          np.tile(np.log([splat, splat, splat]), (n, 1)),
          random_small_quats(n))


def goods(c: Cloud, n):
    # Fruit mounds on the counter (counter top y ~1.05).
    mound(c, int(n * 0.30), (-0.78, 1.03, 0.62), 0.34, (0.95, 0.52, 0.10))
    mound(c, int(n * 0.24), (0.02, 1.03, 0.58), 0.30, (0.62, 0.72, 0.22))
    # Spice bowls: bowl shell + vivid fill disc.
    bowls = int(n * 0.16)
    per = [bowls // 3] * 3
    per[-1] += bowls - sum(per)
    for k, (bx, fill) in enumerate([(0.52, (0.92, 0.68, 0.10)),
                                    (0.80, (0.78, 0.16, 0.10)),
                                    (1.08, (0.25, 0.55, 0.20))]):
        m = per[k]
        shell = int(m * 0.45)
        pos, nrm = sample_sphere(shell, (bx, 1.13, 0.66), 0.15, rng, hemi=True)
        pos[:, 1] = 1.13 - (pos[:, 1] - 1.13)  # flip: bowl opens upward
        c.add(pos, nrm, vary((0.30, 0.20, 0.14), 0.04, shell),
              np.full(shell, 2.2), np.tile(np.log([0.032, 0.032, 0.032]), (shell, 1)),
              random_small_quats(shell))
        fm = m - shell
        ang = rng.uniform(0, 2 * np.pi, size=fm)
        rad = 0.115 * np.sqrt(rng.uniform(size=fm))
        pos = np.stack([bx + rad * np.cos(ang), np.full(fm, 1.145),
                        0.66 + rad * np.sin(ang)], axis=1)
        c.add(pos, np.tile([0.0, 1.0, 0.0], (fm, 1)), vary(fill, 0.05, fm),
              np.full(fm, 2.4), np.tile(np.log([0.030, 0.012, 0.030]), (fm, 1)),
              flat_quats(np.tile([0.0, 1.0, 0.0], (fm, 1))))
    # Cloth bolts stacked on the back shelf.
    bolts = int(n * 0.18)
    per = [bolts // 3] * 3
    per[-1] += bolts - sum(per)
    for k, col in enumerate([(0.10, 0.45, 0.52), (0.66, 0.16, 0.38),
                             (0.85, 0.62, 0.14)]):
        m = per[k]
        pos, nrm = sample_box(m, (0.42, 0.80 + k * 0.13, -0.92),
                              (1.02, 0.92 + k * 0.13, -0.64), rng)
        c.add(pos, nrm, vary(col, 0.05, m), np.full(m, 2.2),
              np.tile(np.log([0.038, 0.038, 0.038]), (m, 1)),
              random_small_quats(m))
    # Pottery cluster on the ground, right of the counter.
    pots = n - int(n * 0.30) - int(n * 0.24) - bowls - bolts
    spots = [(1.62, 0.0, 0.55, 0.15), (1.86, 0.0, 0.30, 0.11),
             (1.55, 0.0, 0.18, 0.09), (1.74, 0.0, 0.72, 0.08)]
    per = [pots // 4] * 4
    per[-1] += pots - sum(per)
    for k, (px, py, pz, pr) in enumerate(spots):
        m = per[k]
        pos, nrm = sample_sphere(m, (px, py + pr * 0.8, pz), pr, rng)
        pos[:, 1] = np.maximum(pos[:, 1], 0.012)
        c.add(pos, nrm, vary((0.60, 0.36, 0.24), 0.05, m), np.full(m, 2.3),
              np.tile(np.log([0.030, 0.030, 0.030]), (m, 1)),
              random_small_quats(m))


def rug(c: Cloud, n):
    x = rng.uniform(-1.55, 1.55, size=n)
    z = rng.uniform(-1.2, 1.2, size=n)
    pos = np.stack([x, np.full(n, 0.012), z], axis=1)
    border = (np.abs(x) > 1.38) | (np.abs(z) > 1.03)
    inner = (~border) & ((np.abs(x) > 1.1) | (np.abs(z) > 0.78))
    col = np.tile(np.array([0.42, 0.09, 0.11]), (n, 1))
    col[border] = np.array([0.78, 0.58, 0.20])
    col[inner] = np.array([0.16, 0.20, 0.38])
    col += rng.uniform(-0.03, 0.03, size=(n, 3))
    nrm = np.tile([0.0, 1.0, 0.0], (n, 1))
    c.add(pos, nrm, np.clip(col, 0.02, 1.0), np.full(n, 2.0),
          np.tile(np.log([0.065, 0.010, 0.065]), (n, 1)), flat_quats(nrm))


def crates(c: Cloud, n):
    loose = max(48, n // 16)
    boxes = n - loose
    per = [boxes // 2, boxes - boxes // 2]
    for k, m in enumerate(per):
        lo = (-2.15 + k * 0.52, 0.02, 0.15)
        hi = (-1.65 + k * 0.52, 0.50, 0.65)
        pos, nrm = sample_box(m, lo, hi, rng)
        c.add(pos, nrm, vary(WOOD_LIGHT, 0.06, m), np.full(m, 2.2),
              np.tile(np.log([0.042, 0.042, 0.042]), (m, 1)),
              random_small_quats(m))
    # A few loose oranges on the nearer crate.
    m = loose
    pos, nrm = sample_sphere(m, (-1.90, 0.56, 0.40), 0.16, rng, hemi=True)
    c.add(pos, nrm, vary((0.95, 0.52, 0.10), 0.05, m), np.full(m, 2.4),
          np.tile(np.log([0.028, 0.028, 0.028]), (m, 1)),
          random_small_quats(m))


def lantern(c: Cloud, n):
    pos, nrm = sample_sphere(n, (0.0, 2.02, 1.05), 0.085, rng)
    c.add(pos, nrm, vary((1.0, 0.78, 0.42), 0.03, n), np.full(n, 2.6),
          np.tile(np.log([0.026, 0.026, 0.026]), (n, 1)),
          random_small_quats(n))


PARTS = [
    ("rug", 0.10, rug),
    ("posts", 0.07, posts),
    ("counter", 0.16, counter),
    ("back_shelf", 0.08, back_shelf),
    ("canopy", 0.24, canopy),
    ("goods", 0.26, goods),
    ("crates", 0.07, crates),
    ("lantern", 0.02, lantern),
]


def build(total):
    global rng
    rng = np.random.default_rng(SEED)
    c = Cloud()
    counts = {}
    assigned = 0
    for i, (name, w, fn) in enumerate(PARTS):
        if i == len(PARTS) - 1:
            n = total - assigned
        else:
            n = int(round(w * total))
        counts[name] = n
        assigned += n
        fn(c, n)
    assert c.total() == total, (c.total(), total)
    return c.arrays(), counts


def write_ply(path, arr):
    n = len(arr["pos"])
    hdr = ["ply", "format binary_little_endian 1.0", f"element vertex {n}"]
    for p in ("x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1",
              "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2",
              "rot_0", "rot_1", "rot_2", "rot_3"):
        hdr.append(f"property float {p}")
    hdr.append("end_header")
    f_dc = (arr["rgb"] - 0.5) / SH_C0
    # NB: part samplers already store scales as log(metres).
    data = np.concatenate([
        arr["pos"], arr["nrm"], f_dc, arr["opa"][:, None],
        arr["scl"], arr["rot"],
    ], axis=1).astype("<f4")
    assert data.shape == (n, 17), data.shape
    with open(path, "wb") as f:
        f.write(("\n".join(hdr) + "\n").encode())
        f.write(data.tobytes())
    return os.path.getsize(path)


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(
        os.path.abspath(__file__))
    for total, name in ((262_144, "bazaar-stall-262k.ply"),
                        (1_000_000, "bazaar-stall-1m.ply")):
        arr, counts = build(total)
        path = os.path.join(outdir, name)
        size = write_ply(path, arr)
        print(f"{name}: {total} gaussians, {size} bytes, parts={counts}")


if __name__ == "__main__":
    main()
