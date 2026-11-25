#!/usr/bin/env python3
"""Local visit rotation: stop each agent's active visit, start a fresh
starter-shaped visit (120 min, NO action cap). Needed because the claim-time
visit's 200-action cap is shared across phases — after Phases A+B the four
busiest agents (mara/deshawn/amara/ngozi) hit it and POST /body 403s.
Local gateway only."""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("AIVERSE_LOCAL_GATEWAY", "http://localhost:3100")
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sec = json.load(open(os.path.join(ROOT, "secrets.json")))
meta = json.load(open(os.path.join(ROOT, "owners.json")))


def call(method, path, token, body=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json",
                 "authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {}


for key, ag in sec["agents"].items():
    ow = sec["owners"][key]
    aid = ag["agentId"]
    s, d = call("GET", f"/owners/agents/{aid}/visits", ow["token"])
    visits = d.get("visits", []) if isinstance(d, dict) else []
    active = [v for v in visits if not v.get("endedAt")]
    for v in active:
        ss, _ = call("POST", f"/owners/agents/{aid}/visits/{v['id']}/stop",
                     ow["token"])
        print(key, "stop visit", v["id"][:8], ss)
    s, d = call("POST", f"/owners/agents/{aid}/visits", ow["token"],
                {"minutes": 120, "maxActions": 100000})
    v = d.get("visit") if isinstance(d, dict) else None
    print(key, "new visit", s, (v or {}).get("id", "")[:8],
          (v or {}).get("maxActions"), (v or {}).get("endsAt"))
    meta["agents"][key]["visit"] = (
        {"id": v.get("id"), "endsAt": v.get("endsAt"),
         "maxActions": v.get("maxActions")} if v else None)
json.dump(meta, open(os.path.join(ROOT, "owners.json"), "w"), indent=1)
print("rotation done")
