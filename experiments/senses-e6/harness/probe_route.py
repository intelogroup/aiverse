#!/usr/bin/env python3
"""OpenRouter route probe for the agent-senses program (plan §11).

Resolves the Agnes 2.5 Flash model id from the LIVE OpenRouter catalog
(ids are never hardcoded — connector rule), then makes exactly ONE
minimal chat completion and records it in the spend ledger as entry #1.

Auth follows the connector doc exactly: the stored `custom.openrouter`
credential is attached via dynamic_credentials.add_surrogate_to_request;
only hsurr:* surrogate values ever reach the wire, only to
openrouter.ai. The raw key is never read, printed, or logged here.

Exit codes: 0 = probe completed and ledger entry written.
            2 = PREMISE FAILURE: no Agnes 2.5 Flash in the live catalog.
                No chat call is made and nothing is written to the
                ledger. Do NOT substitute another model or route.
"""
import json
import sys
import urllib.error
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
import dynamic_credentials as dc

sys.path.insert(0, ".")
try:
    from ledger import SpendLedger
except ImportError:
    from .ledger import SpendLedger

BASE = "https://openrouter.ai/api/v1"
CRED = "custom.openrouter"
HOSTS = ["openrouter.ai"]
PROBE_PROMPT = "Reply with exactly: PROBE_OK"


def _request(method, path, payload=None, timeout=60):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    req.add_header("HTTP-Referer", "https://clixen.app")
    req.add_header("X-Title", "Clixen")
    dc.add_surrogate_to_request(req, CRED, allowed_hosts=HOSTS)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.headers, dc.read_json_response(resp)
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", "replace")
        except Exception:
            body = "<unreadable body>"
        return e.code, e.headers, {"_error_body": body[:2000]}


def find_agnes_25_flash(models):
    """Exact-id resolution from the live catalog. Returns the model
    entry whose id or name identifies Agnes 2.5 Flash, else None."""
    for m in models:
        ident = (str(m.get("id", "")) + " " + str(m.get("name", ""))).lower()
        if "agnes" in ident and "2.5" in ident and "flash" in ident:
            return m
    return None


def main():
    status, _h, body = _request("GET", "/models")
    if status != 200:
        print(f"GET /models failed: HTTP {status}", file=sys.stderr)
        return 1
    models = body.get("data", []) if isinstance(body, dict) else []
    entry = find_agnes_25_flash(models)
    if entry is None:
        print(json.dumps({
            "premise_failure": True,
            "reason": "no Agnes 2.5 Flash model in the live OpenRouter catalog",
            "models_listed": len(models),
            "chat_calls_made": 0,
            "ledger_entries_written": 0,
        }, indent=1))
        return 2

    model_id = entry["id"]
    status, headers, resp = _request("POST", "/chat/completions", {
        "model": model_id,
        "messages": [{"role": "user", "content": PROBE_PROMPT}],
        "max_tokens": 16,
    })
    if status != 200:
        print(f"chat completion failed: HTTP {status}: "
              f"{json.dumps(resp)[:500]}", file=sys.stderr)
        return 1
    usage = resp.get("usage", {})
    ledger_entry = SpendLedger().account(model_id, usage)
    ratelimit = {k: v for k, v in headers.items()
                 if k.lower().startswith("x-ratelimit")}
    print(json.dumps({
        "premise_failure": False,
        "model_id": model_id,
        "pricing_as_returned": entry.get("pricing"),
        "reply": resp["choices"][0]["message"]["content"],
        "usage": usage,
        "ratelimit_headers": ratelimit,
        "ledger_entry": ledger_entry,
    }, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
