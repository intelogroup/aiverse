#!/usr/bin/env python3
"""Live brain for the agent-senses program (Phase 1): OpenRouter chat
completions, brain = deepseek/deepseek-v4-flash (Jim's pick, plan §11.1).

Auth follows the OpenRouter connector doc exactly: the stored
`custom.openrouter` credential is attached via
dynamic_credentials.add_surrogate_to_request; only hsurr:* surrogate
values ever reach the wire, only to openrouter.ai. The raw key is never
read, printed, or logged here.

Spend discipline (plan §11): the model id is resolved against the LIVE
catalog at startup and startup FAILS CLOSED if the exact id is absent.
Before every call, ledger.check() runs (HaltError stops the batch).
After every successful call, the response's real `usage` object is
accounted in the ledger BEFORE the reply is handed to the caller.

Reply contract: the model must answer with exactly one intent JSON
object. parse_intent() returns the intent dict, or None for a malformed
reply — the caller logs a failed action; a bad reply never crashes a run.
"""
import json
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
import dynamic_credentials as dc

try:
    from ledger import HaltError, SpendLedger
except ImportError:  # imported as part of the harness package
    from .ledger import HaltError, SpendLedger

BASE = "https://openrouter.ai/api/v1"
CRED = "custom.openrouter"
HOSTS = ["openrouter.ai"]
MODEL_ID = "deepseek/deepseek-v4-flash"

INTENT_TYPES = {"go_to", "run_to", "enter", "interact", "look", "wait",
                "sit", "stand", "face", "play", "say", "stop", "rest"}

_RETRY_STATUSES = {429, 500, 502, 503, 504}
_RETRY_DELAYS = (2, 5, 10)  # seconds between attempts (3 retries)


class BrainError(RuntimeError):
    """A brain call failed on infrastructure (HTTP/transport after
    retries). The caller records the run infra_failed."""


def resolve_model(models, model_id=MODEL_ID):
    """Exact-id resolution from the live catalog. Returns the catalog
    entry for model_id, or None — startup fails closed on None."""
    for m in models:
        if m.get("id") == model_id:
            return m
    return None


def _estimate_usage(messages, reply_text):
    """Fallback usage when a response carries none (marked estimated).
    Rough 4-chars-per-token estimate; keeps the ledger honest rather
    than silently free."""
    pin = sum(len(m.get("content", "")) for m in messages) // 4
    pout = len(reply_text or "") // 4
    return {"prompt_tokens": pin, "completion_tokens": pout,
            "total_tokens": pin + pout, "estimated": True}


def _extract_json_object(text):
    """First balanced {...} object in the reply, or None."""
    if not text:
        return None
    start = text.find("{")
    while start != -1:
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(text)):
            ch = text[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
            elif ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start:i + 1])
                    except Exception:
                        break
        start = text.find("{", start + 1)
    return None


def parse_intent(reply_text):
    """Parse exactly one intent from a brain reply. Returns the intent
    dict (with a known `type`), or None if the reply is malformed."""
    obj = _extract_json_object(reply_text)
    if not isinstance(obj, dict):
        return None
    if obj.get("type") not in INTENT_TYPES:
        return None
    return obj


class OpenRouterBrain:
    """Stateful per-run brain: owns the transcript for one agent run.

    request_fn is injectable for offline tests:
        request_fn(method, path, payload) -> (status, headers, body_dict)
    """

    def __init__(self, ledger=None, model_id=MODEL_ID, system_text="",
                 request_fn=None, sleep=time.sleep, timeout=120,
                 context_length=None):
        self.ledger = ledger if ledger is not None else SpendLedger()
        self.model_id = model_id
        # Set by resolve_startup(), or injected by a batch that already
        # resolved the catalog once at ITS startup.
        self.context_length = context_length
        self.messages = []
        if system_text:
            self.messages.append({"role": "system", "content": system_text})
        self._request_fn = request_fn or self._live_request
        self._sleep = sleep
        self.timeout = timeout
        self.last_prompt_tokens = 0
        self.run_usage = {"prompt_tokens": 0, "completion_tokens": 0}
        self.run_cost_usd = 0.0
        self.calls = 0

    # -- transport ------------------------------------------------------
    def _live_request(self, method, path, payload=None):
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(BASE + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        req.add_header("HTTP-Referer", "https://aiverse.network")
        req.add_header("X-Title", "AIVerse agent-senses experiment")
        dc.add_surrogate_to_request(req, CRED, allowed_hosts=HOSTS)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return resp.status, resp.headers, dc.read_json_response(resp)
        except urllib.error.HTTPError as e:
            raw = ""
            try:
                raw = e.read().decode("utf-8", "replace")
                body = json.loads(raw)
            except Exception:
                body = {"_error_body": raw[:500]}
            return e.code, e.headers, body
        except Exception as e:
            raise BrainError(f"transport error: {type(e).__name__}: {e}")

    # -- startup --------------------------------------------------------
    def resolve_startup(self):
        """Resolve the model id against the live catalog; fail closed."""
        status, _h, body = self._request_fn("GET", "/models", None)
        if status != 200:
            raise BrainError(f"GET /models failed: HTTP {status}")
        models = body.get("data", []) if isinstance(body, dict) else []
        entry = resolve_model(models, self.model_id)
        if entry is None:
            raise BrainError(
                f"model {self.model_id} absent from the live OpenRouter "
                f"catalog ({len(models)} models) — failing closed")
        self.context_length = entry.get("context_length")
        return entry

    # -- one deliberation ------------------------------------------------
    def turn(self, user_text):
        """Append one user turn, call the model, account, parse.

        Returns {reply, intent (dict|None), usage, entry_cost_usd}.
        Raises HaltError when the spend cap is reached (before the
        call), BrainError on infrastructure failure after retries."""
        self.ledger.check()  # tripwire BEFORE the call (plan §11)
        outgoing = self.messages + [{"role": "user", "content": user_text}]
        payload = {"model": self.model_id, "messages": outgoing,
                   "usage": {"include": True}}
        status = None
        body = None
        last_exc = None
        for attempt in range(len(_RETRY_DELAYS) + 1):
            try:
                status, _h, body = self._request_fn(
                    "POST", "/chat/completions", payload)
            except BrainError as e:
                last_exc = e
                status, body = None, None
            if status == 200:
                break
            if status is not None and status not in _RETRY_STATUSES:
                raise BrainError(
                    f"chat completion failed: HTTP {status}: "
                    f"{json.dumps(body)[:300]}")
            if attempt < len(_RETRY_DELAYS):
                self._sleep(_RETRY_DELAYS[attempt])
        if status != 200:
            if last_exc is not None and status is None:
                raise last_exc
            raise BrainError(
                f"chat completion failed after retries: HTTP {status}")
        reply = ""
        try:
            reply = body["choices"][0]["message"]["content"] or ""
        except Exception:
            reply = ""
        usage = body.get("usage") or _estimate_usage(outgoing, reply)
        # Account BEFORE the reply is used (plan §11): the entry is
        # written now; if it crosses the cap, the NEXT turn's check()
        # (and any later account()) halts the batch.
        entry = self.ledger.account(self.model_id, usage)
        self.calls += 1
        self.last_prompt_tokens = usage.get("prompt_tokens", 0) or 0
        self.run_usage["prompt_tokens"] += usage.get("prompt_tokens", 0) or 0
        self.run_usage["completion_tokens"] += \
            usage.get("completion_tokens", 0) or 0
        self.run_cost_usd += entry["cost_usd"]
        self.messages = outgoing + [{"role": "assistant", "content": reply}]
        return {"reply": reply, "intent": parse_intent(reply),
                "usage": usage, "entry_cost_usd": entry["cost_usd"]}

    def context_pressure(self):
        """prompt_tokens of the last call as a fraction of the model's
        context length (plan §4's measured self-variable)."""
        if not self.context_length:
            return 0.0
        return min(1.0, self.last_prompt_tokens / self.context_length)
