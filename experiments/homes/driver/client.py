#!/usr/bin/env python3
"""Minimal AgentClient — local rebuild of the lost behavior-50 client.

Rebuilt 2026-11-24 from driver/session.py's usage (the original lived in
~/workspace/.build-tmp/behavior-50/, gone with that folder; no copy exists
in any repo worktree). Semantics needed by the driver:
  AgentClient(token, slot, name, on_event)
  .act_seq (int counter the driver increments)
  .call(method, path, body=None, max_attempts=3, timeout=30) -> Resp
  .observe() .body() .places() .clips()
Resp: .status (int), .body (parsed JSON dict, {} on empty)
Base: $AIVERSE_LOCAL_GATEWAY (default http://localhost:3100) + /world
Retries: transport errors and 5xx, up to max_attempts, small backoff.
"""
import json
import os
import time
import urllib.error
import urllib.request

BASE = os.environ.get("AIVERSE_LOCAL_GATEWAY", "http://localhost:3100") + "/world"


class Resp:
    def __init__(self, status, body):
        self.status = status
        self.body = body if isinstance(body, dict) else {}


class AgentClient:
    def __init__(self, token, slot, name, on_event=None):
        self.token = token
        self.slot = slot
        self.name = name
        self.on_event = on_event or (lambda ev: None)
        self.act_seq = 0

    def call(self, method, path, body=None, max_attempts=3, timeout=30):
        last = Resp(0, {})
        for attempt in range(max(1, max_attempts)):
            req = urllib.request.Request(
                BASE + path, method=method,
                data=json.dumps(body).encode() if body is not None else None,
                headers={"content-type": "application/json",
                         "authorization": f"Bearer {self.token}"})
            try:
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    raw = r.read().decode()
                    status = r.status
            except urllib.error.HTTPError as e:
                try:
                    raw = e.read().decode()
                except Exception:
                    raw = ""
                status = e.code
            except Exception as e:
                last = Resp(0, {"transport_error": f"{type(e).__name__}: {e}"})
                if attempt < max_attempts - 1:
                    time.sleep(0.5 * (attempt + 1))
                continue
            try:
                data = json.loads(raw) if raw else {}
            except Exception:
                data = {"_raw": raw[:500]}
            last = Resp(status, data)
            if status < 500 or attempt >= max_attempts - 1:
                return last
            time.sleep(0.5 * (attempt + 1))
        return last

    def observe(self):
        return self.call("GET", "/observe")

    def body(self):
        return self.call("GET", "/body")

    def places(self):
        return self.call("GET", "/places")

    def clips(self):
        return self.call("GET", "/clips")
