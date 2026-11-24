#!/usr/bin/env python3
"""social15 LOCAL onboarding: 15 owners x 1 agent on the LOCAL gateway only.

Differences from the production onboard.py:
- BASE is http://localhost:3100 (env AIVERSE_LOCAL_GATEWAY). Refuses any
  non-localhost base.
- No Gmail: after register, the owner's email_verified flag is set directly
  in the LOCAL scratch DB (aiverse_social_local) via psql. Local only.
- Writes ../secrets.json (mode 600) + ../owners.json in the cohort work dir,
  same shapes session.py / onboard.py use.
Usage: onboard_local.py owners-all | agents-all | one <key>
"""
import json
import os
import secrets as pysecrets
import subprocess
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("AIVERSE_LOCAL_GATEWAY", "http://localhost:3100")
if "localhost" not in BASE and "127.0.0.1" not in BASE:
    print("REFUSING non-local base:", BASE)
    sys.exit(42)
DBURL = "postgresql://postgres@127.0.0.1:5433/aiverse_social_local"
PSQL = os.path.expanduser("~/workspace/bin/psql")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SECRETS = os.path.join(ROOT, "secrets.json")
META = os.path.join(ROOT, "owners.json")

sys.path.insert(0, HERE)
import onboard as ob  # BY_KEY / OWNERS / email_of / agent_name_of only

BY_KEY = ob.BY_KEY
OWNERS = ob.OWNERS


def call(method, path, token=None, body=None, retries=4):
    last = (0, {})
    for attempt in range(retries):
        headers = {"content-type": "application/json"}
        if token:
            headers["authorization"] = f"Bearer {token}"
        req = urllib.request.Request(
            BASE + path, method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw, status = r.read().decode(), r.status
        except urllib.error.HTTPError as e:
            try:
                raw = e.read().decode()
            except Exception:
                raw = ""
            status = e.code
        except Exception as e:
            last = (0, {"transport_error": f"{type(e).__name__}: {e}"})
            time.sleep(1 + attempt)
            continue
        try:
            data = json.loads(raw) if raw else {}
        except Exception:
            data = {"_raw": raw[:300]}
        last = (status, data)
        if status < 500:
            return last
        time.sleep(1 + attempt)
    return last


def load_json(path, default):
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return default


def save_secrets(s):
    tmp = SECRETS + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f, indent=1)
    os.chmod(tmp, 0o600)
    os.replace(tmp, SECRETS)


def save_meta(m):
    with open(META, "w") as f:
        json.dump(m, f, indent=1)


def err_str(d):
    return str(d.get("error") or d.get("message") or "")[:200] if isinstance(d, dict) else str(d)[:200]


def db_verify_owner(email):
    """Set email_verified=true in the LOCAL scratch DB only."""
    p = subprocess.run([PSQL, DBURL, "-tAc",
                        "UPDATE owners SET email_verified=true "
                        f"WHERE email='{email}' RETURNING email_verified"],
                       capture_output=True, text=True, timeout=30)
    return "t" in (p.stdout or "")


def owner_phase(key):
    name, _pick = BY_KEY[key]
    sec = load_json(SECRETS, {"owners": {}, "agents": {}})
    meta = load_json(META, {"owners": {}})
    if key in sec["owners"] and sec["owners"][key].get("verified"):
        print(key, "owner already done")
        return True
    if key not in sec["owners"]:
        pw = "S15L-" + pysecrets.token_urlsafe(24) + "!aA1"
        s, d = call("POST", "/owners/register",
                    body={"email": ob.email_of(key), "password": pw,
                          "displayName": name})
        print(key, "register", s, err_str(d))
        if s != 201:
            print(key, "REGISTER FAILED", json.dumps(d)[:300])
            return False
        sec["owners"][key] = {"email": ob.email_of(key), "password": pw,
                              "token": d["token"], "id": d["owner"]["id"],
                              "verified": bool(d["owner"].get("emailVerified"))}
        save_secrets(sec)
    ow = sec["owners"][key]
    if not ow.get("verified"):
        ok = db_verify_owner(ow["email"])
        s2, d2 = call("GET", "/owners/me", token=ow["token"])
        me = (d2.get("owner") or d2) if isinstance(d2, dict) else {}
        ow["verified"] = bool(me.get("emailVerified"))
        print(key, "db_verify:", ok, "emailVerified per /owners/me:", ow["verified"])
        save_secrets(sec)
        if not ow["verified"]:
            return False
    meta["owners"][key] = {"email": ob.email_of(key), "ownerId": ow["id"],
                           "verified": True}
    save_meta(meta)
    return True


def agent_phase(key):
    name, pick = BY_KEY[key]
    sec = load_json(SECRETS, {"owners": {}, "agents": {}})
    meta = load_json(META, {"owners": {}, "agents": {}})
    ow = sec["owners"].get(key)
    if not ow or not ow.get("verified"):
        print(key, "owner not verified — owners first")
        return False
    if key in sec.get("agents", {}) and meta.get("agents", {}).get(key, {}).get("claimed"):
        print(key, "agent already done")
        return True
    if key not in sec["agents"]:
        got = None
        for suffix in ("", "b", "c"):
            cand = ob.agent_name_of(key) + suffix
            s, d = call("POST", "/agents/register",
                        body={"name": cand,
                              "capabilities": ["explore", "socialize"],
                              "description": f"social15 agent of {name}"})
            print(key, "agent register", cand, s, err_str(d))
            if s == 201:
                got = (cand, d)
                break
            if not (s == 409 and err_str(d) == "name taken"):
                break
        if got is None:
            return False
        cand, d = got
        sec["agents"][key] = {"name": cand, "agentId": d["agentId"],
                              "agentToken": d["agentToken"],
                              "claimCode": d["claimCode"]}
        save_secrets(sec)
    ag = sec["agents"][key]
    # LOCAL ONLY: the claim endpoint's per-IP token bucket (5 per 900 s)
    # exists to stop online claim-code guessing in production. All local
    # claims share one IP, so clear the bucket in OUR local redis first.
    subprocess.run(["/tmp/redis-7.2.5/src/redis-cli", "DEL", "claim:unknown",
                    "claim:127.0.0.1"], capture_output=True, timeout=10)
    s, d = call("POST", "/owners/agents/claim", token=ow["token"],
                body={"claimCode": ag["claimCode"]}, retries=3)
    print(key, "claim", s, err_str(d))
    claimed = (s == 200)
    visit = d.get("visit") if isinstance(d, dict) else None
    if not claimed:
        s3, d3 = call("GET", "/owners/agents", token=ow["token"])
        owned = {a.get("id") for a in (d3.get("agents", []) if isinstance(d3, dict) else []) if isinstance(a, dict)}
        if ag["agentId"] in owned:
            claimed = True
            print(key, "claim proven via owner agent list")
    if not claimed:
        print(key, "CLAIM FAILED", json.dumps(d)[:300])
        return False
    if not visit:
        s2, d2 = call("GET", f"/owners/agents/{ag['agentId']}/visits", token=ow["token"])
        if isinstance(d2, dict) and d2.get("visits"):
            visit = next((x for x in d2["visits"] if not x.get("endedAt")), None) or d2["visits"][0]
    meta.setdefault("agents", {})[key] = {
        "name": ag["name"], "agentId": ag["agentId"], "bodyPick": pick,
        "claimed": True,
        "visit": ({"id": visit.get("id"), "endsAt": visit.get("endsAt"),
                   "maxActions": visit.get("maxActions")} if visit else None)}
    save_meta(meta)
    print(key, "claimed OK, visit:", bool(visit),
          (visit or {}).get("endsAt"), "maxActions", (visit or {}).get("maxActions"))
    return True


def main():
    cmd = sys.argv[1]
    keys = [k for k, _, _ in OWNERS]
    if cmd == "owners-all":
        for k in keys:
            if not owner_phase(k):
                print("STOPPING at", k)
                return 1
            time.sleep(0.5)
    elif cmd == "agents-all":
        for k in keys:
            if not agent_phase(k):
                print("STOPPING at", k)
                return 1
            time.sleep(0.5)
    elif cmd == "one":
        return 0 if (owner_phase(sys.argv[2]) and agent_phase(sys.argv[2])) else 1
    else:
        print("usage: owners-all | agents-all | one <key>")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
