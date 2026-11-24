#!/usr/bin/env python3
"""E5 synthetic onboarding: 85 synthetic owners x 1 agent, LOCAL gateway
only (same flow as onboard_local.py: register -> DB email verify ->
agent register -> claim with local redis bucket clear). Writes
../secrets_synths.json + ../owners_synths.json. LOCAL ONLY — these
accounts exist solely in the aiverse_social_local scratch DB.
Usage: onboard_synths.py owners-all | agents-all"""
import json
import os
import secrets as pysecrets
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import onboard_local as ol  # call(), db_verify_owner(), load_json()

SECRETS = os.path.join(ROOT, "secrets_synths.json")
META = os.path.join(ROOT, "owners_synths.json")
SYNTHS = json.load(open(os.path.join(ROOT, "..", "synthetics.json")))
KEYS = sorted(SYNTHS)


def email_of(key):
    return f"s85-{key}@local.test"


def save(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=1)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def owner_phase(key):
    sec = ol.load_json(SECRETS, {"owners": {}, "agents": {}})
    meta = ol.load_json(META, {"owners": {}, "agents": {}})
    if key in sec["owners"] and sec["owners"][key].get("verified"):
        return True
    if key not in sec["owners"]:
        pw = "S85L-" + pysecrets.token_urlsafe(24) + "!aA1"
        s, d = ol.call("POST", "/owners/register",
                       body={"email": email_of(key), "password": pw,
                             "displayName": SYNTHS[key]["name"]})
        if s != 201:
            print(key, "REGISTER FAILED", s, json.dumps(d)[:200])
            return False
        sec["owners"][key] = {
            "email": email_of(key), "password": pw, "token": d["token"],
            "id": d["owner"]["id"],
            "verified": bool(d["owner"].get("emailVerified"))}
        save(SECRETS, sec)
    ow = sec["owners"][key]
    if not ow.get("verified"):
        ol.db_verify_owner(ow["email"])
        s2, d2 = ol.call("GET", "/owners/me", token=ow["token"])
        me = (d2.get("owner") or d2) if isinstance(d2, dict) else {}
        ow["verified"] = bool(me.get("emailVerified"))
        save(SECRETS, sec)
        if not ow["verified"]:
            print(key, "VERIFY FAILED")
            return False
    meta["owners"][key] = {"email": email_of(key), "ownerId": ow["id"],
                           "verified": True}
    save(META, meta)
    return True


def agent_phase(key):
    sec = ol.load_json(SECRETS, {"owners": {}, "agents": {}})
    meta = ol.load_json(META, {"owners": {}, "agents": {}})
    ow = sec["owners"].get(key)
    if not ow or not ow.get("verified"):
        print(key, "owner not verified")
        return False
    if key in sec.get("agents", {}) and \
            meta.get("agents", {}).get(key, {}).get("claimed"):
        return True
    if key not in sec["agents"]:
        got = None
        for suffix in ("", "b", "c"):
            cand = f"s85-{key}" + suffix
            s, d = ol.call(
                "POST", "/agents/register",
                body={"name": cand,
                      "capabilities": ["explore", "socialize"],
                      "description": f"E5 synthetic agent (local only)"})
            if s == 201:
                got = (cand, d)
                break
            if not (s == 409 and ol.err_str(d) == "name taken"):
                print(key, "AGENT REGISTER FAILED", s, ol.err_str(d))
                break
        if got is None:
            return False
        cand, d = got
        sec["agents"][key] = {"name": cand, "agentId": d["agentId"],
                              "agentToken": d["agentToken"],
                              "claimCode": d["claimCode"]}
        save(SECRETS, sec)
    ag = sec["agents"][key]
    try:
        env = dict(os.environ)
        env["LD_LIBRARY_PATH"] = os.path.expanduser(
            "~/workspace/.redis-local/root/usr/lib/x86_64-linux-gnu")
        subprocess.run([os.path.expanduser(
            "~/workspace/.redis-local/root/usr/bin/redis-cli"),
            "DEL", "claim:unknown", "claim:127.0.0.1"],
            capture_output=True, timeout=10, env=env)
    except Exception:
        pass
    s, d = ol.call("POST", "/owners/agents/claim", token=ow["token"],
                   body={"claimCode": ag["claimCode"]}, retries=3)
    if s != 200:
        print(key, "CLAIM FAILED", s, ol.err_str(d))
        return False
    meta.setdefault("agents", {})[key] = {
        "name": ag["name"], "agentId": ag["agentId"], "claimed": True}
    save(META, meta)
    return True


def main():
    mode = sys.argv[1]
    fn = owner_phase if mode == "owners-all" else agent_phase
    ok = 0
    for k in KEYS:
        if fn(k):
            ok += 1
        else:
            print("FAILED:", k)
    print(f"{mode}: {ok}/{len(KEYS)} ok")


if __name__ == "__main__":
    main()
