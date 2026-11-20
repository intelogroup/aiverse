#!/usr/bin/env python3
"""Fix-lane onboarding for the arms: the 10 non-gate cast members hold
agents whose claim codes EXPIRED (gateway TTL 15 min) before claiming.
For each: drop the stale agent record from secrets.json, re-register
(fresh claim code; name falls back to ns-<name>), claim IMMEDIATELY in
the same motion. Paced for the 5-per-IP claim bucket (65 s pause per
5 claims). Gate pair (res-wren, b-ruth) already claimed — skipped.
Usage: rereg_claim.py [key ...]   (default: all unclaimed keys)"""
import json
import os
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import cast as C  # noqa: E402
import onboard_ns as ob  # noqa: E402

MEMBERS = C.all_members()
KEYS = sys.argv[1:] or [k for k in MEMBERS
                        if k not in ("res-wren", "b-ruth")]

sec_path = os.path.join(ROOT, "secrets.json")
bak = sec_path + ".pre-arm-rereg.bak"
if not os.path.exists(bak):
    shutil.copy2(sec_path, bak)
    os.chmod(bak, 0o600)
    print("backup ->", bak)

sec = ob.load(sec_path, {"owners": {}, "agents": {}})
for k in KEYS:
    if k in sec.get("agents", {}):
        print(k, "dropping stale agent record",
              sec["agents"][k].get("name"))
        del sec["agents"][k]
ob.sob.save_secrets(sec)

done = 0
for i, k in enumerate(KEYS):
    if done and done % 5 == 0:
        print("... claim bucket pause 65 s")
        time.sleep(65)
    if not ob.register(k):
        print("REGISTER FAILED", k)
        sys.exit(1)
    if not ob.claim(k):
        print("CLAIM FAILED", k)
        sys.exit(1)
    done += 1
    time.sleep(2)
print("rereg+claim complete:", done, "agents")
