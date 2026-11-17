#!/usr/bin/env python3
"""Scripted TEST OWNER for the dev-local rig (Jim, 2026-11-14:
"Create a dev way that's not require human tap — for testing only").

The production claim + visit gates (PR #160, the Nov 13 human-tap
rule) stay exactly as they are. What changes for TESTING is who plays
the owner: this module plays the owner's role through the REAL
gateway APIs, the same calls the console makes:

    POST /owners/register                          -> owner JWT
    POST /owners/login                             -> owner JWT
    GET  /owners/me                                (ownerAuth probe)
    POST /owners/agents/claim        {claimCode}   (ownerAuth)
    POST /owners/agents/:id/visits/:visitId/stop   (ownerAuth)
    POST /owners/agents/:id/visits   {minutes, maxActions} (ownerAuth)

It is wired in ONLY by e1.py's --dev-local mode, whose gateway base
URL is a local stack (see dev/dev_up.sh). Nothing here can reach
production: the base URL comes from AIVERSE_GATEWAY_BASE / the
--dev-local default (localhost), never the production default.

Per provisioned run: register a fresh agent (via the world adapter),
claim it with its claim code, stop the claim-time starter visit
(120 min / 200 actions — too small for a run batch), and start the
full-size visit the policy allows (7 days / 100,000 actions,
policy/visits.ts MAX_VISIT_MINUTES / MAX_VISIT_ACTIONS).

Rate-limit shape (from the gateway code, verified 2026-11-14): the
claim route is bucketed per source IP at 5 per 15 min and the local
gateway derives the IP from the rightmost x-forwarded-for hop when
not on Render. Each provisioned agent is its own claimant session,
so each claim presents its own TEST-NET-2 source address
(198.51.100.0/24, RFC 5737) — the same pattern the gateway's own CI
suites use to keep per-IP buckets independent.

Secret hygiene: the owner's email/password/JWT live ONLY in
.secrets/devowner.json (file 0600, dir 0700). The generated password
never leaves that file. No token, password, or claim code is ever
printed, logged, or embedded in an error message — errors carry HTTP
statuses and gateway error bodies only (the gateway never echoes the
claim code, and neither does this module).
"""
import json
import os
import secrets as _secrets
import time
import urllib.error
import urllib.request

try:
    from world import SECRETS_DIR, WorldError
except ImportError:  # imported as part of the harness package
    from .world import SECRETS_DIR, WorldError

VISIT_MINUTES = 7 * 24 * 60      # policy/visits.ts MAX_VISIT_MINUTES
VISIT_ACTIONS = 100_000          # policy/visits.ts MAX_VISIT_ACTIONS
OWNER_FILE = "devowner.json"


class DevOwnerError(WorldError):
    """The scripted test-owner flow failed (HTTP status + gateway
    error body only — never a secret)."""


class DevOwner:
    def __init__(self, base_url, secrets_dir=SECRETS_DIR, timeout=30,
                 transport_retries=3, sleep=time.sleep):
        self.base_url = base_url.rstrip("/")
        self.secrets_dir = secrets_dir
        self.owner_path = os.path.join(secrets_dir, OWNER_FILE)
        self.timeout = timeout
        self.transport_retries = transport_retries
        self._sleep = sleep
        self._owner = None          # {email, password, token, owner_id}
        self._provision_seq = 0

    # -- transport -----------------------------------------------------
    def _call(self, method, path, body=None, auth=False, xff=None):
        url = self.base_url + path
        data = json.dumps(body).encode() if body is not None else None
        last_exc = None
        for attempt in range(self.transport_retries):
            req = urllib.request.Request(url, data=data, method=method)
            req.add_header("content-type", "application/json")
            req.add_header("connection", "close")
            if auth and self._owner and self._owner.get("token"):
                req.add_header("authorization",
                               f"Bearer {self._owner['token']}")
            if xff:
                req.add_header("x-forwarded-for", xff)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    raw = r.read().decode("utf-8", "replace")
                    status = r.status
                break
            except urllib.error.HTTPError as e:
                try:
                    raw = e.read().decode("utf-8", "replace")
                except Exception as read_exc:
                    partial = getattr(read_exc, "partial", b"") or b""
                    raw = partial.decode("utf-8", "replace") \
                        if isinstance(partial, bytes) else str(partial)
                status = e.code
                break
            except Exception as e:  # transport: retry like the adapter
                last_exc = e
                if attempt < self.transport_retries - 1:
                    self._sleep(1)
        else:
            raise DevOwnerError(
                f"transport error after {self.transport_retries} "
                f"attempts on {method} {path}: "
                f"{type(last_exc).__name__}")
        try:
            parsed = json.loads(raw) if raw else {}
        except Exception:
            parsed = {"_raw": raw[:500]}
        return status, parsed

    # -- owner persistence ----------------------------------------------
    def _save_owner(self):
        os.makedirs(self.secrets_dir, exist_ok=True)
        os.chmod(self.secrets_dir, 0o700)
        tmp = self.owner_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self._owner, f, indent=1)
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.owner_path)

    def _load_owner(self):
        if not os.path.exists(self.owner_path):
            return None
        with open(self.owner_path) as f:
            data = json.load(f)
        if not data.get("email") or not data.get("password"):
            return None
        return data

    # -- owner lifecycle ---------------------------------------------------
    def ensure_owner(self):
        """Register the test owner once (or reuse the persisted one).
        Returns owner_id. The JWT is kept in memory + the 0600 file;
        a stale token is refreshed via login, and a dead login falls
        back to a fresh registration."""
        saved = self._load_owner()
        if saved:
            self._owner = saved
            status, _me = self._call("GET", "/owners/me", auth=True)
            if status == 200:
                return self._owner.get("owner_id")
            if self._login():
                return self._owner.get("owner_id")
            self._owner = None  # persisted credentials are dead; replace
        email = f"senses-dev-{_secrets.token_hex(4)}@example.com"
        password = _secrets.token_urlsafe(24)
        status, body = self._call("POST", "/owners/register",
                                  {"email": email, "password": password,
                                   "displayName": "Agent Senses Dev Owner"})
        if status not in (200, 201) or not body.get("token"):
            raise DevOwnerError(
                f"owner register failed: HTTP {status}: "
                f"{json.dumps(body)[:300]}")
        self._owner = {"email": email, "password": password,
                       "token": body["token"],
                       "owner_id": (body.get("owner") or {}).get("id")}
        self._save_owner()
        return self._owner["owner_id"]

    def _login(self):
        status, body = self._call(
            "POST", "/owners/login",
            {"email": self._owner["email"],
             "password": self._owner["password"]})
        if status in (200, 201) and body.get("token"):
            self._owner["token"] = body["token"]
            if (body.get("owner") or {}).get("id"):
                self._owner["owner_id"] = body["owner"]["id"]
            self._save_owner()
            return True
        return False

    # -- claim + visits ------------------------------------------------------
    def claim(self, claim_code, xff):
        status, body = self._call("POST", "/owners/agents/claim",
                                  {"claimCode": claim_code},
                                  auth=True, xff=xff)
        if status != 200:
            raise DevOwnerError(
                f"claim failed: HTTP {status}: {json.dumps(body)[:300]}")
        return body

    def stop_visit(self, agent_id, visit_id):
        status, body = self._call(
            "POST", f"/owners/agents/{agent_id}/visits/{visit_id}/stop",
            {}, auth=True)
        return status, body

    def start_visit(self, agent_id, minutes=VISIT_MINUTES,
                    max_actions=VISIT_ACTIONS):
        status, body = self._call(
            "POST", f"/owners/agents/{agent_id}/visits",
            {"minutes": minutes, "maxActions": max_actions}, auth=True)
        if status not in (200, 201) or not (body.get("visit") or {}).get("id"):
            raise DevOwnerError(
                f"visit start failed: HTTP {status}: "
                f"{json.dumps(body)[:300]}")
        return body["visit"]

    # -- per-run provisioning --------------------------------------------------
    def provision(self, world, run_id):
        """Register a fresh agent through the world adapter, claim it,
        replace the starter visit with a full-size one. Returns
        {agent_id, visit_id}. The claim code moves in memory only
        (the adapter's 0600 reg file is its only persisted copy)."""
        if not self._owner:
            self.ensure_owner()
        self._provision_seq += 1
        xff = f"198.51.100.{10 + (self._provision_seq % 200)}"
        reg = world.register(f"senses-{run_id}")
        agent_id = reg["agentId"]
        claimed = self.claim(reg["claimCode"], xff)
        starter = claimed.get("visit")
        if starter and starter.get("id"):
            # A second active visit would 409; the starter (120 min /
            # 200 actions) is replaced by the full-size visit below.
            self.stop_visit(agent_id, starter["id"])
        visit = self.start_visit(agent_id)
        return {"agent_id": agent_id, "visit_id": visit["id"]}

    def end_visit(self, agent_id, visit_id):
        """Best-effort teardown: stop the run's visit."""
        try:
            self.stop_visit(agent_id, visit_id)
        except Exception:
            pass
