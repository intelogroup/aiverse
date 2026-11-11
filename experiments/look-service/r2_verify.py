import sys, hashlib
sys.path.insert(0, ".")
from look_service import r2_get_sha, R2_BASE  # reuse the service's proven route
key = "snapshots/test-agent-1/test-agent-1-20261110T150009Z-001.png"
n, sha = r2_get_sha(key)
print(f"GET {R2_BASE}/{key}")
print(f"bytes_back={n} sha256_back={sha}")
print("match_local:", n == 145619 and sha == "407b1cb0ab19d725dae920ac5e3d505e877a7da6025b8a92de05d97874614e13")
