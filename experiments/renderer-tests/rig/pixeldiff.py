#!/usr/bin/env python3
"""Rough parity stat between two PNGs: mean abs diff, % pixels differing
by >10/255 per channel, max channel diff. Usage: pixeldiff.py a.png b.png"""
import sys, json
import numpy as np
from PIL import Image

a = np.asarray(Image.open(sys.argv[1]).convert("RGB"), dtype=np.int16)
b = np.asarray(Image.open(sys.argv[2]).convert("RGB"), dtype=np.int16)
if a.shape != b.shape:
    print(json.dumps({"shapeMismatch": [a.shape, b.shape]})); sys.exit(0)
d = np.abs(a - b)
per_pixel = d.max(axis=2)
print(json.dumps({
    "size": list(a.shape),
    "meanAbsDiff": round(float(d.mean()), 3),
    "pctPixelsDiffGt10": round(float((per_pixel > 10).mean() * 100), 2),
    "pctPixelsDiffGt32": round(float((per_pixel > 32).mean() * 100), 2),
    "maxChannelDiff": int(d.max()),
}))
