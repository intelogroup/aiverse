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

import numpy as np  # noqa: E402
from stall_goods_audit import footprint_half  # noqa: E402

quarter = (0.0, 0.7071068, 0.0, 0.7071068)      # 90 degrees of yaw swaps the extents
assert np.allclose(footprint_half((0.3, 0.2), quarter, np.eye(4)), (0.2, 0.3), atol=1e-4)
assert np.allclose(footprint_half((0.3, 0.2), (0, 0, 0, 1), np.eye(4)), (0.3, 0.2))
print("ok footprint")

from bridge_stall_goods import datum  # noqa: E402

# a 1 m counter: a 0.3 m wide piece hanging a third over the edge must not be placed there
st = dict(counter=np.full((50, 50), 1.0), origin=(0.0, 0.0, 0.02))
assert datum(st, 0.5, 0.5, (0.15, 0.15)) == 1.0
assert datum(st, 0.95, 0.5, (0.15, 0.15)) is None
print("ok edge")
