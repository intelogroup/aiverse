"""python3 tools/city3/test_stall_goods_support.py"""
import numpy as np
from stall_goods_audit import support

hmap = np.full((155, 85), np.nan)
hmap[:, 8:72] = 0.83                     # counter does not reach the map's z edges
origin = (-1.55, -0.85, 0.02)
assert support(hmap, origin, 0.0, 0.0, (0.1, 0.1)) == 0.83
assert support(hmap, origin, 0.0, -0.96, (0.1, 0.1)) is None, "off the map behind the counter"
assert support(hmap, origin, -1.8, 0.0, (0.1, 0.1)) is None, "off the map past the end"
print("ok")
