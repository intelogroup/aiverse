#!/usr/bin/env python3
"""Disposable /world/see probe (patched async flow) using ns-wren's
active gate visit. Attach body -> POST /see -> poll GET /see/<id> ->
verify PNG -> DELETE body. Mirrors the patched session_ns._do_see."""
import base64
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.expanduser("~/workspace/.build-tmp/behavior-50"))
from client import AgentClient  # noqa: E402

sec = json.load(open(os.path.join(HERE, "secrets.json")))
tok = sec["agents"]["res-wren"]["agentToken"]
c = AgentClient(tok, 99, "probe-see", lambda ev: None)

post = c.call("POST", "/body", {"body": "summer"})
print("attach:", post.status)
assert post.status in (200, 201), post.body
try:
    t0 = time.time()
    r = c.call("POST", "/see", {}, max_attempts=1, timeout=120)
    see = r.body.get("see") if isinstance(r.body, dict) else None
    print(f"POST /see -> {r.status} state={see and see.get('state')} "
          f"id={see and see.get('id')}")
    polls = 0
    while isinstance(see, dict) and not see.get("photoPng") \
            and see.get("id") and time.time() - t0 < 240:
        g = c.call("GET", f"/see/{see['id']}?waitMs=10000",
                   max_attempts=2, timeout=30)
        polls += 1
        s2 = g.body.get("see") if isinstance(g.body, dict) else None
        if isinstance(s2, dict):
            see = s2
            print(f"  poll {polls}: state={see.get('state')} "
                  f"t={time.time() - t0:.1f}s")
            if see.get("state") in ("done", "failed") \
                    or see.get("photoPng"):
                break
        time.sleep(2)
    ok = isinstance(see, dict) and bool(see.get("photoPng"))
    print(f"RESULT: ok={ok} state={see and see.get('state')} "
          f"total={time.time() - t0:.1f}s polls={polls}")
    if ok:
        raw = base64.b64decode(see["photoPng"])
        out = os.path.join(HERE, "probe-see.png")
        open(out, "wb").write(raw)
        print(f"PNG: {len(raw)} bytes header-ok="
              f"{raw[:4] == bytes([0x89, 0x50, 0x4e, 0x47])} "
              f"dims={see.get('width')}x{see.get('height')} "
              f"renderMs={see.get('renderMs')} "
              f"latencyMs={see.get('latencyMs')} -> {out}")
        print("depthSummary:", str(see.get("depthSummary"))[:200])
    else:
        print("final see:", json.dumps(see)[:400])
finally:
    d = c.call("DELETE", "/body")
    chk = c.body()
    print("cleanup: DELETE", d.status, "GET body after:", chk.status)
