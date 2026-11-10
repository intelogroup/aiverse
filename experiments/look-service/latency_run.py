#!/usr/bin/env python3
"""Warm-look latency distribution: N looks at a FIXED pose (no travel,
no facing — pure capture cost through POST /look). Records per-look
renderMs (in-service measure of the __scout.look() evaluate) and the
client end-to-end time. Output: latency.json + lines on stdout."""
import json, time, urllib.request
from pathlib import Path

HERE = Path(__file__).parent
N = 12
rows = []
for i in range(N):
    req = urllib.request.Request(
        "http://127.0.0.1:5317/look",
        data=json.dumps({"agentId": "latency"}).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=1500) as r:
            res = json.loads(r.read())
        e2e = round((time.time() - t0) * 1000)
        rows.append({"i": i, "ok": res["ok"], "renderMs": res["renderMs"],
                     "poseMs": res["poseMs"], "e2eMs": e2e})
        print(f"look {i}: renderMs={res['renderMs']} e2eMs={e2e}", flush=True)
    except Exception as e:
        rows.append({"i": i, "ok": False, "error": f"{type(e).__name__}: {e}"[:150]})
        print(f"look {i}: FAILED {e}", flush=True)
    (HERE / "latency.json").write_text(json.dumps(rows, indent=1))

ok = sorted(r["renderMs"] for r in rows if r.get("ok"))
if ok:
    med = ok[len(ok) // 2] if len(ok) % 2 else (ok[len(ok) // 2 - 1] + ok[len(ok) // 2]) // 2
    p95 = ok[min(len(ok) - 1, int(0.95 * len(ok)))]
    print(json.dumps({"n_ok": len(ok), "min": ok[0], "median": med,
                      "p95": p95, "max": ok[-1]}), flush=True)
print("LATENCY DONE", flush=True)
