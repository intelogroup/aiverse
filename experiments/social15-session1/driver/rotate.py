#!/usr/bin/env python3
"""social15 visit rotator — beats the ~10.5 min presence wall.

Waits DELAY seconds (arg1, default 620), then creates a fresh 30-min visit
for every key in arg2 (comma list). Each agent's old visit is dead or dying
by then; its driver auto-recovers (re-attaches the persisted body on the
new visit). Retries per key until success or a hard deadline. Evidence ->
<root>/rotate.jsonl (+ stdout)."""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import syncvisits as sv  # noqa: E402

DELAY = float(sys.argv[1]) if len(sys.argv) > 1 else 620
KEYS = (sys.argv[2].split(",") if len(sys.argv) > 2 else
        ["mara", "deshawn", "ingrid", "tomas", "priya", "kenji", "fatima",
         "oleg", "lucia", "amara", "henrik", "yuki", "rafael", "ngozi", "sam"])
HARD_DEADLINE = time.time() + DELAY + 210


def ev(key, d):
    d = dict(d, key=key, t=round(time.time(), 1))
    with open(os.path.join(ROOT, "rotate.jsonl"), "a") as f:
        f.write(json.dumps(d) + "\n")
    print("[rotate]", key, d, flush=True)


print(f"[rotate] sleeping {DELAY}s, keys={len(KEYS)}", flush=True)
time.sleep(DELAY)
pending = list(KEYS)
while pending and time.time() < HARD_DEADLINE:
    for key in list(pending):
        try:
            r = sv.new_visit(key, 30, 200)
            ok = r.status == 201
            ev(key, {"kind": "rotate_visit", "status": r.status, "ok": ok})
            if ok:
                pending.remove(key)
        except Exception as e:
            ev(key, {"kind": "rotate_error", "error": f"{type(e).__name__}: {e}"})
    if pending:
        time.sleep(20)
for key in pending:
    ev(key, {"kind": "rotate_gave_up"})
print(f"[rotate] done; pending={pending}", flush=True)
