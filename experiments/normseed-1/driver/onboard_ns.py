#!/usr/bin/env python3
"""NormSeed-1 onboarding: fresh disposable owners + agents on production.
Adapted from social15/driver/onboard.py (proven flow), normseed cast.

Secrets live ONLY in ../secrets.json (mode 600). owners.json = metadata.
Email verification: the Gmail CLI redacts verify links to [credential:...]
handles, so register() leaves owners UNVERIFIED; verification completes
when the verify link is visited (parent-run browser flow, as social15),
then `sync` picks up server truth and `claim` proceeds. Claims are paced
(5-per-IP token bucket, ~60 s refill).

Commands:
  register <key>      owner + agent registration (no claim)
  register-all        all cast members
  sync                refresh verified flags from /owners/me
  claim <key>         claim a registered agent (owner must be verified)
  claim-all           claim all, paced in batches of 5
  visits <key>        list visits
  newvisit <key> <minutes> <maxActions>   stop active + create fresh visit
"""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import cast as C  # noqa: E402

# reuse the proven retrying client + gmail helpers from social15 onboard
sys.path.insert(0, os.path.expanduser(
    "~/workspace/.build-tmp/social15/driver"))
import onboard as sob  # noqa: E402

MEMBERS = C.all_members()
SECRETS = os.path.join(ROOT, "secrets.json")
META = os.path.join(ROOT, "owners.json")
sob.SECRETS = SECRETS
sob.META = META
call = sob.call


def email_of(key):
    return f"jimkalinov+normseed-{MEMBERS[key]['suffix']}@gmail.com"


def agent_name_candidates(key):
    n = MEMBERS[key]["name"]
    return [n, f"ns-{n.lower()}", f"ns1-{n.lower()}", key]


def load(path, default):
    return sob.load_json(path, default)


def register(key):
    m = MEMBERS[key]
    sec = load(SECRETS, {"owners": {}, "agents": {}})
    meta = load(META, {"owners": {}, "agents": {}})
    if key not in sec["owners"]:
        import secrets as pysecrets
        pw = "NS1-" + pysecrets.token_urlsafe(24) + "!aA1"
        s, d, ms, at = call("POST", "/owners/register",
                            body={"email": email_of(key), "password": pw,
                                  "displayName": m["name"]})
        print(key, "owner register", s, f"{ms}ms", sob.err_str(d))
        if s != 201:
            return False
        sec["owners"][key] = {"email": email_of(key), "password": pw,
                              "token": d["token"], "id": d["owner"]["id"],
                              "verified": bool(d["owner"].get("emailVerified"))}
        sob.save_secrets(sec)
    ow = sec["owners"][key]
    meta.setdefault("owners", {})[key] = {
        "email": email_of(key), "ownerId": ow["id"],
        "verified": ow.get("verified", False)}
    sob.save_meta(meta)
    if key not in sec.get("agents", {}):
        got = None
        for cand in agent_name_candidates(key):
            s, d, ms, at = call(
                "POST", "/agents/register",
                body={"name": cand,
                      "capabilities": ["explore", "socialize"],
                      "description": f"normseed-1 {m['role']} {m['name']}"})
            print(key, "agent register", cand, s, f"{ms}ms", sob.err_str(d))
            if s == 201:
                got = (cand, d)
                break
            if not (s == 409 and sob.err_str(d) == "name taken"):
                break
        if got is None:
            return False
        cand, d = got
        sec["agents"][key] = {"name": cand, "agentId": d["agentId"],
                              "agentToken": d["agentToken"],
                              "claimCode": d["claimCode"]}
        sob.save_secrets(sec)
    ag = sec["agents"][key]
    meta.setdefault("agents", {})[key] = {
        "name": ag["name"], "agentId": ag["agentId"],
        "bodyPick": m["body"], "role": m["role"],
        "claimed": meta.get("agents", {}).get(key, {}).get("claimed", False)}
    sob.save_meta(meta)
    print(key, "registered: owner", ow["id"][:8], "| agent", ag["name"],
          "| verified:", ow.get("verified"))
    return True


def sync():
    sec = load(SECRETS, {"owners": {}, "agents": {}})
    meta = load(META, {"owners": {}, "agents": {}})
    for key, ow in sec["owners"].items():
        s, d, ms, at = call("GET", "/owners/me", token=ow["token"])
        me = (d.get("owner") or d) if isinstance(d, dict) else {}
        v = bool(me.get("emailVerified"))
        ow["verified"] = v
        meta.setdefault("owners", {})[key] = {
            "email": ow["email"], "ownerId": ow["id"], "verified": v}
        print(key, "emailVerified:", v)
    sob.save_secrets(sec)
    sob.save_meta(meta)


def claim(key):
    m = MEMBERS[key]
    sec = load(SECRETS, {"owners": {}, "agents": {}})
    meta = load(META, {"owners": {}, "agents": {}})
    ow = sec["owners"].get(key)
    ag = sec["agents"].get(key)
    if not ow or not ag:
        print(key, "register first")
        return False
    if meta.get("agents", {}).get(key, {}).get("claimed"):
        print(key, "already claimed")
        return True
    s, d, ms, at = call("POST", "/owners/agents/claim", token=ow["token"],
                        body={"claimCode": ag["claimCode"]}, retries=3)
    print(key, "claim", s, f"{ms}ms", sob.err_str(d))
    claimed = (s == 200)
    visit = d.get("visit") if isinstance(d, dict) else None
    if not claimed:
        s3, d3, _, _ = call("GET", "/owners/agents", token=ow["token"])
        owned = {a.get("id") for a in (d3.get("agents") or [])
                 if isinstance(a, dict)}
        if ag["agentId"] in owned:
            claimed = True
            print(key, "claim proven via owner agent list")
    if not claimed:
        return False
    if not visit:
        s2, d2, _, _ = call(
            "GET", f"/owners/agents/{ag['agentId']}/visits", token=ow["token"])
        if isinstance(d2, dict) and d2.get("visits"):
            visit = next((x for x in d2["visits"] if not x.get("endedAt")),
                         None) or d2["visits"][0]
    meta.setdefault("agents", {})[key] = {
        "name": ag["name"], "agentId": ag["agentId"], "bodyPick": m["body"],
        "role": m["role"], "claimed": True,
        "visit": ({"id": visit.get("id"), "endsAt": visit.get("endsAt"),
                   "maxActions": visit.get("maxActions")} if visit else None)}
    sob.save_meta(meta)
    print(key, "claimed OK; visit ends:", (visit or {}).get("endsAt"))
    return True


def visits(key):
    sec = load(SECRETS, {"owners": {}, "agents": {}})
    ow, ag = sec["owners"][key], sec["agents"][key]
    s, d, ms, at = call("GET", f"/owners/agents/{ag['agentId']}/visits",
                        token=ow["token"])
    vs = d.get("visits") if isinstance(d, dict) else []
    print(key, "visits:", len(vs or []))
    for v in (vs or [])[:4]:
        print("  ", v.get("id"), "ends:", v.get("endsAt"),
              "ended:", v.get("endedAt"), "reason:", v.get("endedReason"),
              "actions:", v.get("actionsUsed"), "/", v.get("maxActions"))
    return vs


def newvisit(key, minutes, max_actions):
    sec = load(SECRETS, {"owners": {}, "agents": {}})
    ow, ag = sec["owners"][key], sec["agents"][key]
    s, d, _, _ = call("GET", f"/owners/agents/{ag['agentId']}/visits",
                      token=ow["token"])
    vs = d.get("visits") if isinstance(d, dict) else []
    active = next((v for v in (vs or []) if not v.get("endedAt")), None)
    if active:
        s2, _, _, _ = call(
            "POST",
            f"/owners/agents/{ag['agentId']}/visits/{active['id']}/stop",
            token=ow["token"], body={})
        print(key, "stopped active visit ->", s2)
    s3, d3, ms3, _ = call("POST", f"/owners/agents/{ag['agentId']}/visits",
                          token=ow["token"],
                          body={"minutes": minutes,
                                "maxActions": max_actions})
    v = d3.get("visit") if isinstance(d3, dict) else None
    print(key, "POST visit", s3, (v or {}).get("id"),
          "ends:", (v or {}).get("endsAt"), sob.err_str(d3))
    return s3 == 201


def main():
    cmd = sys.argv[1]
    if cmd == "register":
        sys.exit(0 if register(sys.argv[2]) else 1)
    elif cmd == "register-all":
        for k in MEMBERS:
            if not register(k):
                print("STOPPING at", k)
                sys.exit(1)
            time.sleep(2)
    elif cmd == "sync":
        sync()
    elif cmd == "claim":
        sys.exit(0 if claim(sys.argv[2]) else 1)
    elif cmd == "claim-all":
        keys = list(MEMBERS)
        for i, k in enumerate(keys):
            if i and i % 5 == 0:
                print("... claim bucket pause 65 s")
                time.sleep(65)
            if not claim(k):
                print("STOPPING at", k)
                sys.exit(1)
            time.sleep(2)
    elif cmd == "visits":
        visits(sys.argv[2])
    elif cmd == "newvisit":
        ok = newvisit(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]))
        sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
