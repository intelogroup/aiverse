#!/usr/bin/env python3
"""World adapter (Phase 1): production AIVerse gateway calls in the
cold-probe idiom (urllib, bearer agent token, retry on transport
errors — the gateway intermittently truncates responses; fly4.py's
logs are the evidence and its retry pattern is the proven cure).

Per run: register a fresh agent, keep its token ONLY in a 0600 file
under agent-senses/.secrets/ (never printed, never in any log —
scrub() masks it from any text that could be logged), attach a body,
read the map once, observe per turn, POST /world/act for intents and
poll the act to its terminal state, detach at run end.

Place resolution is DYNAMIC: the tea-house target and the plaza drop
point are matched from the live /world/map response on name/kind/id
every run; the caller records the resolved ids in the run log.
"""
import json
import os
import time
import urllib.error
import urllib.request

BASE = "https://api.aiverse.network"


def default_base_url():
    """Gateway base URL: AIVERSE_GATEWAY_BASE env override (the
    dev-local rig points this at a local gateway), else production."""
    return os.environ.get("AIVERSE_GATEWAY_BASE") or BASE


SECRETS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".secrets")
TERMINAL_ACT_STATES = {"settled", "failed", "error", "done", "completed"}


class WorldError(RuntimeError):
    """Infrastructure failure talking to the gateway (after retries)."""


class WorldGateError(WorldError):
    """The gateway refused on policy grounds (e.g. 403 no_visit) —
    not retryable from the runner side. Carries the HTTP status and
    the gateway's own error body (token-free)."""

    def __init__(self, status, body):
        self.status = status
        self.body = body if isinstance(body, dict) else {}
        super().__init__(
            f"gateway gate: HTTP {status}: "
            f"{json.dumps(self.body)[:300]}")


def resolve_place(places, *needles):
    """First place whose id/name/kind contains any needle
    (case-insensitive). Returns the place dict or None."""
    for p in places:
        hay = " ".join(str(p.get(k, "")) for k in ("id", "name", "kind"))
        hay = hay.lower()
        if any(n.lower() in hay for n in needles):
            return p
    return None


def resolve_places(places):
    """Resolve the E1 task places from a live map response.
    Returns {tea: place|None, plaza: place|None, tea_matches: [...],
    plaza_matches: [...]}.

    Tea preference order matters: the real map carries four decoy
    "Today's Tea" shopfronts ahead of the Tea House in list order.
    The production-verified target (Nov 10 flight; the sim's own
    resolution of the query "tea") is shop-102, Matchmaker's Tea
    House — the one place whose room is "tea". Prefer (1) room ==
    "tea", (2) a name containing "tea house", (3) the first
    tea-substring match."""
    def matches(needles):
        out = []
        for p in places:
            hay = " ".join(str(p.get(k, "")) for k in ("id", "name", "kind"))
            if any(n in hay.lower() for n in needles):
                out.append(p)
        return out

    tea_matches = matches(["tea"])
    plaza_matches = matches(["plaza"])
    tea = None
    for p in tea_matches:
        if p.get("room") == "tea":
            tea = p
            break
    if tea is None:
        for p in tea_matches:
            if "tea house" in str(p.get("name", "")).lower():
                tea = p
                break
    if tea is None and tea_matches:
        tea = tea_matches[0]
    return {"tea": tea,
            "plaza": plaza_matches[0] if plaza_matches else None,
            "tea_matches": tea_matches,
            "plaza_matches": plaza_matches}


class WorldAdapter:
    def __init__(self, run_id, secrets_dir=SECRETS_DIR, timeout=30,
                 transport_retries=5, sleep=time.sleep, base_url=None):
        self.run_id = run_id
        self.secrets_dir = secrets_dir
        self.base_url = (base_url or default_base_url()).rstrip("/")
        self.timeout = timeout
        self.transport_retries = transport_retries
        self._sleep = sleep
        self._token = None
        self.agent_id = None
        self.token_path = None

    # -- token hygiene ---------------------------------------------------
    def scrub(self, text):
        if self._token and isinstance(text, str):
            return text.replace(self._token, "<TOKEN>")
        return text

    # -- transport ---------------------------------------------------------
    def _call(self, method, path, body=None, auth=True):
        url = self.base_url + path
        data = json.dumps(body).encode() if body is not None else None
        last_exc = None
        for attempt in range(self.transport_retries):
            req = urllib.request.Request(url, data=data, method=method)
            req.add_header("content-type", "application/json")
            req.add_header("connection", "close")
            if auth and self._token:
                req.add_header("authorization", f"Bearer {self._token}")
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    raw = r.read().decode("utf-8", "replace")
                    status = r.status
                break
            except urllib.error.HTTPError as e:
                # The gateway intermittently truncates chunked bodies
                # in transit — including error bodies. Guard the read:
                # the status alone is actionable (a 403 on attach is
                # the policy gate) even when the body arrives partial.
                try:
                    raw = e.read().decode("utf-8", "replace")
                except Exception as read_exc:
                    partial = getattr(read_exc, "partial", b"") or b""
                    if isinstance(partial, bytes):
                        raw = partial.decode("utf-8", "replace")
                    else:
                        raw = str(partial)
                status = e.code
                break
            except Exception as e:  # transport: retry like fly4.py
                last_exc = e
                if attempt < self.transport_retries - 1:
                    self._sleep(2)
        else:
            raise WorldError(
                f"transport error after {self.transport_retries} attempts "
                f"on {method} {path}: {type(last_exc).__name__}")
        try:
            parsed = json.loads(raw) if raw else {}
        except Exception:
            parsed = {"_raw": raw[:500]}
        return status, parsed

    # -- lifecycle ---------------------------------------------------------
    def register(self, name, description=""):
        status, reg = self._call("POST", "/agents/register", {
            "name": name,
            "capabilities": ["explore"],
            "description": description or
            "AIVerse agent-senses experiment agent (E1 pilot, 2026-11-14). "
            "Owner: Jim via Jett.",
        }, auth=False)
        if status not in (200, 201) or not reg.get("agentToken"):
            raise WorldError(
                f"registration failed: HTTP {status}: "
                f"{self.scrub(json.dumps(reg))[:300]}")
        self._token = reg["agentToken"]
        self.agent_id = reg.get("agentId")
        os.makedirs(self.secrets_dir, exist_ok=True)
        os.chmod(self.secrets_dir, 0o700)
        self.token_path = os.path.join(
            self.secrets_dir, f"{self.run_id}.reg.json")
        with open(self.token_path, "w") as f:
            json.dump(reg, f, indent=1)
        os.chmod(self.token_path, 0o600)
        return reg

    def load_registered(self, reg_path):
        """Adopt an already-registered agent (e.g. one the owner has
        claimed in the console) instead of registering a fresh one.
        Reads a reg file written by register(); makes NO network call
        and writes nothing — the file stays the single source."""
        with open(reg_path) as f:
            reg = json.load(f)
        if not reg.get("agentToken"):
            raise WorldError(
                f"reg file carries no agentToken: {reg_path}")
        self._token = reg["agentToken"]
        self.agent_id = reg.get("agentId")
        self.token_path = reg_path
        return reg

    def attach(self):
        status, body = self._call("POST", "/world/body", {})
        if status in (401, 403):
            raise WorldGateError(status, body)
        if status not in (200, 201):
            raise WorldError(
                f"attach failed: HTTP {status}: "
                f"{self.scrub(json.dumps(body))[:300]}")
        return body.get("observation", body)

    def detach(self):
        """Best effort: the gateway intermittently truncates this
        response in transit (run3-log.jsonl) — a transport error here
        is tolerated; the caller may confirm via observe."""
        try:
            status, body = self._call("DELETE", "/world/body")
            return status, body
        except WorldError:
            return 0, {}

    # -- reads ---------------------------------------------------------------
    def get_map(self):
        status, body = self._call("GET", "/world/map")
        if status != 200:
            raise WorldError(f"map failed: HTTP {status}")
        places = body.get("places", []) if isinstance(body, dict) else []
        return places

    def observe(self):
        status, body = self._call("GET", "/world/observe")
        if status in (401, 403):
            raise WorldGateError(status, body)
        if status != 200:
            raise WorldError(f"observe failed: HTTP {status}")
        return body.get("observation", body)

    # -- actions ---------------------------------------------------------------
    def act(self, act_id, intent):
        """POST one intent; returns the HTTP status and the act dict.
        A refused/invalid intent (4xx) is returned, not raised — it is
        a task-level failure, not infrastructure."""
        status, body = self._call(
            "POST", "/world/act", {"id": act_id, "action": intent})
        if status in (401, 403):
            raise WorldGateError(status, body)
        act = body.get("act", body) if isinstance(body, dict) else {}
        return status, act

    def poll_act(self, act_id, deadline_ts, poll_s=3.0):
        """Poll GET /world/act/{id} until a terminal state or the
        deadline. Transport errors are tolerated (fly4 pattern).
        Returns the final act dict (state may be non-terminal if the
        deadline cut the poll)."""
        last = {}
        while True:
            try:
                status, body = self._call("GET", f"/world/act/{act_id}")
                if status == 200:
                    last = body.get("act", body) if isinstance(body, dict) \
                        else {}
                    if last.get("state") in TERMINAL_ACT_STATES:
                        return last
            except WorldError:
                pass  # poll again until the deadline, like fly4 did
            if time.time() >= deadline_ts:
                return last
            self._sleep(min(poll_s, max(0.0, deadline_ts - time.time())))

    def look(self):
        """POST /world/look (one glance). Returns the raw LookView dict;
        summarising it for a text brain is the caller's job."""
        status, body = self._call("POST", "/world/look", {})
        if status in (401, 403):
            raise WorldGateError(status, body)
        if status not in (200, 201, 202):
            raise WorldError(f"look failed: HTTP {status}")
        return body
