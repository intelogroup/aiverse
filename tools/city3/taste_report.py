#!/usr/bin/env python3
"""Numeric read on a taste-lab render: exposure, per-tile contrast/edges, warmth, blankness.

    python3 tools/city3/taste_report.py <render.png> [tiles WxH]

Every defect the taste lab tracks has a measurable signature: rug busyness is tile
luma/edge stats, the skyline is edge density in the glazing band, palette warmth is
mean R-B, the lamp is a warm-pixel cluster, blank art is a flat tile. Dense numbers
are how renders get judged here - eyeballs do the tie-breaks, not the pass/fail.
"""
import sys

import numpy as np
from PIL import Image


def luma(a):
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]


def grad_density(l, t=8.0):
    """Fraction of pixels with a luma gradient above t (hard edges: skyline, seams)."""
    g = np.zeros(l.shape)
    g[:, :-1] += np.abs(np.diff(l, axis=1))
    g[:-1, :] += np.abs(np.diff(l, axis=0))
    return float((g > t).mean())


def main():
    path = sys.argv[1]
    tx, ty = 8, 5
    if len(sys.argv) > 2 and sys.argv[2].count("x") == 1 and sys.argv[2][0].isdigit():
        tx, ty = (int(v) for v in sys.argv[2].split("x"))
    im = np.asarray(Image.open(path).convert("RGB"), dtype=float)
    H, W, _ = im.shape
    l = luma(im)
    print(f"{path}  {W}x{H}  tiles {tx}x{ty}")
    pr = np.percentile(l, [1, 50, 99])
    print(f"exposure luma p1/p50/p99: {pr[0]:.1f} / {pr[1]:.1f} / {pr[2]:.1f}")
    print(f"global warmth (mean R-B): {im[..., 0].mean() - im[..., 2].mean():+.2f}")
    print("tile grid: luma/edge%  (edge% = pixels with gradient > 8, hard edges)")
    for j in range(ty):
        row = []
        for i in range(tx):
            t = l[j * H // ty:(j + 1) * H // ty, i * W // tx:(i + 1) * W // tx]
            row.append(f"{t.mean():5.1f}/{grad_density(t) * 100:4.1f}")
        print(f"  row{j}: " + "  ".join(row))
    # the practicals: where do the warmest pixels cluster (lamp, sun raking in)
    warmth = im[..., 0] - im[..., 2]
    m = warmth > np.percentile(warmth, 99)
    ys, xs = np.nonzero(m)
    if len(xs):
        print(f"warmest 1% pixels: mean R-B {warmth[m].mean():.1f}, centred at "
              f"({xs.mean() / W * 100:.0f}%, {ys.mean() / H * 100:.0f}%) of frame, n={m.sum()}")
    # blank surfaces read as tiles with luma std < 2 (blank art, void walls)
    flat = [f"({i},{j})" for j in range(ty) for i in range(tx)
            if float(l[j * H // ty:(j + 1) * H // ty, i * W // tx:(i + 1) * W // tx].std()) < 2.0]
    print("flat tiles (std<2, candidate blank art):", " ".join(flat) if flat else "none")


if __name__ == "__main__":
    main()
