#!/usr/bin/env python3
"""social15 onboarding: 15 owners x 1 agent on production.
Secrets (owner passwords/tokens, agent tokens, claim codes) live ONLY in
../secrets.json (mode 600). owners.json carries non-secret metadata only.
Phases: owner (register+verify via Gmail) -> agent (register+claim, paced).
"""
import base64
import json
import os
import re
import secrets as pysecrets
import subprocess
import sys
import time
import urllib.error
import urllib.request

BASE = "https://api.aiverse.network"
DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(DIR)
SECRETS = os.path.join(ROOT, "secrets.json")
META = os.path.join(ROOT, "owners.json")
GMAIL = "/opt/hatch/bin/hatch_gws_cli"

OWNERS = [
    # key, display name, body pick
    ("mara",    "Mara",    "summer"),
    ("deshawn", "Deshawn", "remy"),
    ("ingrid",  "Ingrid",  "barbarian"),
    ("tomas",   "Tomas",   "knight"),
    ("priya",   "Priya",   "eve"),
    ("kenji",   "Kenji",   "cipher"),
    ("fatima",  "Fatima",  "summer"),
    ("oleg",    "Oleg",    "barbarian"),
    ("lucia",   "Lucia",   "remy"),
    ("amara",   "Amara",   "eve"),
    ("henrik",  "Henrik",  "knight"),
    ("yuki",    "Yuki",    "cipher"),
    ("rafael",  "Rafael",  "remy"),
    ("ngozi",   "Ngozi",   "summer"),
    ("sam",     "Sam",     "barbarian"),
]
BY_KEY = {k: (n, b) for k, n, b in OWNERS}


def email_of(key):
    return f"jimkalinov+{key}@gmail.com"


def agent_name_of(key):
    return f"s15-{key}"


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
    if isinstance(d, dict):
        return str(d.get("error") or d.get("message") or "")[:200]
    return str(d)[:200]


def call(method, path, token=None, body=None, retries=5, retry_429=False):
    """Retrying HTTP client (loadtest pattern). Returns (status, data, ms, attempts)."""
    last_exc = None
    t0 = time.time()
    attempts = 0
    while attempts < retries:
        attempts += 1
        headers = {"content-type": "application/json"}
        if token:
            headers["authorization"] = f"Bearer {token}"
        req = urllib.request.Request(
            BASE + path, method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read().decode()
                status = r.status
                ra = r.headers.get("retry-after")
        except urllib.error.HTTPError as e:
            try:
                raw = e.read().decode()
            except Exception as read_err:
                last_exc = read_err
                if attempts < retries:
                    time.sleep(min(2 ** attempts, 8))
                    continue
                return 0, {"transport_error": "error-body read failed"}, int((time.time() - t0) * 1000), attempts
            status = e.code
            ra = e.headers.get("retry-after") if e.headers else None
        except Exception as e:
            last_exc = e
            if attempts < retries:
                time.sleep(min(2 ** attempts, 8))
                continue
            return 0, {"transport_error": f"{type(e).__name__}: {e}"}, int((time.time() - t0) * 1000), attempts
        try:
            data = json.loads(raw) if raw else {}
        except Exception:
            if attempts < retries:
                time.sleep(min(2 ** attempts, 8))
                continue
            data = {"_raw": raw[:500]}
        if status == 429 and retry_429 and attempts < retries:
            time.sleep(float(ra) if ra else 2)
            continue
        return status, data, int((time.time() - t0) * 1000), attempts
    return 0, {"transport_error": str(last_exc)}, int((time.time() - t0) * 1000), attempts


# ---------------------------------------------------------------- gmail
def gmail_json(args):
    p = subprocess.run([GMAIL, "gmail"] + args, capture_output=True, text=True,
                       timeout=120)
    out = (p.stdout or "").strip()
    if not out:
        return None
    try:
        return json.loads(out)
    except Exception:
        # NDJSON pages: take the first line
        for line in out.splitlines():
            try:
                return json.loads(line)
            except Exception:
                continue
    return None


def decode_part(part):
    body = part.get("body") or {}
    data = body.get("data")
    if data:
        try:
            return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode("utf-8", "replace")
        except Exception:
            return ""
    text = ""
    for sub in part.get("parts") or []:
        text += decode_part(sub)
    return text


def find_verify_token(key, timeout_s=240):
    """Poll Gmail for the verification email to this alias; extract the token."""
    alias = email_of(key)
    deadline = time.time() + timeout_s
    tried = set()
    while time.time() < deadline:
        res = gmail_json(["users", "messages", "list", "--params",
                          json.dumps({"userId": "me",
                                      "q": f"to:{alias} newer_than:1d",
                                      "maxResults": 10})])
        msgs = (res or {}).get("messages") or []
        for m in msgs:
            mid = m.get("id")
            if not mid or mid in tried:
                continue
            tried.add(mid)
            full = gmail_json(["users", "messages", "get", "--params",
                               json.dumps({"userId": "me", "id": mid,
                                           "format": "full"})])
            if not full:
                continue
            payload = full.get("payload") or {}
            text = decode_part(payload)
            headers = {h.get("name", "").lower(): h.get("value", "")
                       for h in payload.get("headers") or []}
            subj = headers.get("subject", "")
            if "verif" not in (subj + text).lower() and "aiverse" not in (subj + text).lower():
                continue
            # token patterns, longest first
            cands = []
            for pat in (r"verify[^\s\"']*?[?&]token=([A-Za-z0-9._\-]+)",
                        r"[?&]token=([A-Za-z0-9._\-]{20,})",
                        r"\btoken[:\s]+([A-Za-z0-9._\-]{20,})",
                        r"\b([A-Za-z0-9]{64,})\b"):
                for mm in re.finditer(pat, text):
                    cands.append(mm.group(1))
            if cands:
                tok = max(cands, key=len)
                return tok, {"subject": subj, "token_len": len(tok),
                             "msg_id": mid}
        time.sleep(10)
    return None, None


# ---------------------------------------------------------------- phases
def owner_phase(key):
    name, _pick = BY_KEY[key]
    sec = load_json(SECRETS, {"owners": {}, "agents": {}})
    meta = load_json(META, {"owners": {}})
    if key in sec["owners"] and sec["owners"][key].get("verified"):
        print(key, "owner already registered+verified")
        return True
    if key not in sec["owners"]:
        pw = "S15-" + pysecrets.token_urlsafe(24) + "!aA1"
        s, d, ms, at = call("POST", "/owners/register",
                            body={"email": email_of(key), "password": pw,
                                  "displayName": name})
        print(key, "register", s, f"{ms}ms", err_str(d))
        if s != 201:
            print(key, "REGISTER FAILED", json.dumps(d)[:300])
            return False
        sec["owners"][key] = {"email": email_of(key), "password": pw,
                              "token": d["token"], "id": d["owner"]["id"],
                              "verified": bool(d["owner"].get("emailVerified"))}
        save_secrets(sec)
    ow = sec["owners"][key]
    if not ow.get("verified"):
        tok, info = find_verify_token(key)
        if not tok:
            print(key, "NO VERIFY EMAIL FOUND")
            return False
        print(key, "verify email found:", info)
        s, d, ms, at = call("POST", "/owners/verify-email", body={"token": tok})
        print(key, "verify-email POST", s, f"{ms}ms", err_str(d),
              json.dumps(d)[:160] if isinstance(d, dict) else "")
        # confirm via /owners/me regardless (single-use token semantics)
        s2, d2, _, _ = call("GET", "/owners/me", token=ow["token"])
        me = (d2.get("owner") or d2) if isinstance(d2, dict) else {}
        ow["verified"] = bool(me.get("emailVerified"))
        print(key, "emailVerified per /owners/me:", ow["verified"])
        save_secrets(sec)
        if not ow["verified"]:
            return False
    meta["owners"][key] = {"email": email_of(key), "ownerId": ow["id"],
                           "verified": True}
    save_meta(meta)
    return True


def agent_phase(key):
    name, pick = BY_KEY[key]
    sec = load_json(SECRETS, {"owners": {}, "agents": {}})
    meta = load_json(META, {"owners": {}, "agents": {}})
    ow = sec["owners"].get(key)
    if not ow or not ow.get("verified"):
        print(key, "owner not verified — run owner phase first")
        return False
    if key in sec.get("agents", {}) and meta.get("agents", {}).get(key, {}).get("claimed"):
        print(key, "agent already registered+claimed")
        return True
    if key not in sec["agents"]:
        got = None
        for suffix in ("", "b", "c"):
            cand = agent_name_of(key) + suffix
            s, d, ms, at = call("POST", "/agents/register",
                                body={"name": cand,
                                      "capabilities": ["explore", "socialize"],
                                      "description": f"social15 agent of {name}"})
            print(key, "agent register", cand, s, f"{ms}ms", err_str(d))
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
    s, d, ms, at = call("POST", "/owners/agents/claim", token=ow["token"],
                        body={"claimCode": ag["claimCode"]}, retries=3)
    print(key, "claim", s, f"{ms}ms", err_str(d))
    claimed = (s == 200)
    visit = d.get("visit") if isinstance(d, dict) else None
    if s == 404 or (isinstance(d, dict) and d.get("alreadyClaimed")):
        claimed = claimed or bool(isinstance(d, dict) and d.get("alreadyClaimed"))
        s3, d3, _, _ = call("GET", "/owners/agents", token=ow["token"])
        owned = set()
        if isinstance(d3, dict):
            for a in d3.get("agents", []):
                if isinstance(a, dict) and a.get("id"):
                    owned.add(a["id"])
        if ag["agentId"] in owned:
            claimed = True
            print(key, "claim proven via owner agent list")
            s4, d4, _, _ = call("GET", f"/owners/agents/{ag['agentId']}/visits",
                                token=ow["token"])
            if isinstance(d4, dict) and d4.get("visits"):
                v = next((x for x in d4["visits"] if not x.get("endedAt")), None) or d4["visits"][0]
                visit = v
    if not claimed:
        print(key, "CLAIM FAILED", json.dumps(d)[:300])
        return False
    if not visit:
        s2, d2, _, _ = call("GET", f"/owners/agents/{ag['agentId']}/visits",
                            token=ow["token"])
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
    if cmd == "owner":
        ok = owner_phase(sys.argv[2])
        sys.exit(0 if ok else 1)
    elif cmd == "agent":
        ok = agent_phase(sys.argv[2])
        sys.exit(0 if ok else 1)
    elif cmd == "owners-all":
        keys = [k for k, _, _ in OWNERS]
        for k in keys:
            if not owner_phase(k):
                print("STOPPING at", k)
                sys.exit(1)
            time.sleep(2)
    elif cmd == "agents-batch":
        # agents-batch <start_idx> <count> — claims are the paced resource
        start, count = int(sys.argv[2]), int(sys.argv[3])
        keys = [k for k, _, _ in OWNERS][start:start + count]
        for k in keys:
            if not agent_phase(k):
                print("STOPPING at", k)
                sys.exit(1)
            time.sleep(2)


if __name__ == "__main__":
    main()
