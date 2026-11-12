#!/usr/bin/env python3
"""Presence probe: spawn mara's body, observe every 20 s, log statuses.
Question: does a fresh visit + immediate constant agent calls survive
past the ~10.5 min presence_expired wall seen in round 2?"""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.expanduser("~/workspace/.build-tmp/behavior-50"))
from client import AgentClient  # noqa: E402

KEY = sys.argv[1] if len(sys.argv) > 1 else "mara"
PICK = sys.argv[2] if len(sys.argv) > 2 else "summer"
MINS = float(sys.argv[3]) if len(sys.argv) > 3 else 20
OUT = os.path.join(ROOT, "probe", f"{KEY}.jsonl")
os.makedirs(os.path.dirname(OUT), exist_ok=True)

sec = json.load(open(os.path.join(ROOT, "secrets.json")))
tok = sec["agents"][KEY]["agentToken"]
c = AgentClient(tok, 77, f"s15-{KEY}", lambda ev: None)
t0 = time.time()


def log(ev):
    ev = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
          "elapsed_s": round(time.time() - t0, 1), **ev}
    with open(OUT, "a") as f:
        f.write(json.dumps(ev) + "\n")
    print(ev, flush=True)


post = c.call("POST", "/body", {"body": PICK})
log({"kind": "spawn", "status": post.status})
b = c.body()
log({"kind": "body", "status": b.status})
deadline = t0 + MINS * 60
first_err = None
while time.time() < deadline:
    r = c.observe()
    body = r.body if isinstance(r.body, dict) else {}
    err = body.get("error") or body.get("reason")
    log({"kind": "observe", "status": r.status, "error": err})
    if r.status != 200 and first_err is None:
        first_err = time.time() - t0
        log({"kind": "FIRST_FAILURE", "after_s": round(first_err, 1)})
    time.sleep(20)
d = c.call("DELETE", "/body")
chk = c.body()
log({"kind": "cleanup", "delete_status": d.status, "body_after": chk.status,
     "first_failure_after_s": (round(first_err, 1) if first_err else None)})
