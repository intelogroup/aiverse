#!/usr/bin/env python3
"""Offline tests for harness/devowner.py (the scripted test owner for
the dev-local rig). urllib is monkeypatched; no network is touched.
Pins: owner register-once + 0600 persistence + reuse via /owners/me,
the claim call shape (owner auth + per-provision TEST-NET-2 XFF),
starter-visit replacement with the full-size visit, and the secret
hygiene rule — no claim code / password / token in any error text."""
import io
import json
import os
import stat
import sys
import tempfile
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "harness"))
from devowner import DevOwner, DevOwnerError, VISIT_ACTIONS, VISIT_MINUTES

BASE = "http://localhost:3100"
CLAIM_CODE = "AIVERSE-TEST-CLAIM-SECRET"


class FakeResp:
    def __init__(self, status, payload):
        self.status = status
        self._raw = json.dumps(payload).encode()

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class Router:
    """Routes urlopen calls by method+path suffix; records requests."""

    def __init__(self, routes):
        self.routes = routes
        self.requests = []

    def __call__(self, req, timeout=None):
        method = req.get_method()
        url = req.full_url
        headers = {k.lower(): v for k, v in req.headers.items()}
        body = req.data.decode() if req.data else None
        self.requests.append((method, url, headers, body))
        for (m, suffix), resp in self.routes.items():
            if method == m and url.endswith(suffix):
                if isinstance(resp, Exception):
                    raise resp
                status, payload = resp
                if status >= 400:
                    raise urllib.error.HTTPError(
                        url, status, "err", {},
                        io.BytesIO(json.dumps(payload).encode()))
                return FakeResp(status, payload)
        raise AssertionError(f"unrouted {method} {url}")


class StubWorld:
    """The slice of WorldAdapter that DevOwner.provision uses."""

    def __init__(self):
        self.registered_names = []

    def register(self, name):
        self.registered_names.append(name)
        return {"agentId": "agt-1", "agentToken": "agent-token-x",
                "claimCode": CLAIM_CODE}


def owner_routes(claim_resp=None):
    return {
        ("POST", "/owners/register"): (201, {
            "token": "owner-jwt-1",
            "owner": {"id": "own-1", "email": "x@example.com"}}),
        ("GET", "/owners/me"): (200, {"owner": {"id": "own-1"}}),
        ("POST", "/owners/agents/claim"): claim_resp or (200, {
            "agent": {"id": "agt-1", "name": "senses-x"},
            "visit": {"id": "visit-starter", "maxActions": 200}}),
        ("POST", "/visits/visit-starter/stop"): (200, {"ok": True}),
        ("POST", "/owners/agents/agt-1/visits"): (201, {
            "visit": {"id": "visit-long", "maxActions": VISIT_ACTIONS}}),
    }


class TestDevOwner(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.secrets = os.path.join(self._tmp.name, "secrets")
        self._orig = urllib.request.urlopen

    def tearDown(self):
        urllib.request.urlopen = self._orig
        self._tmp.cleanup()

    def _owner(self, routes):
        router = Router(routes)
        urllib.request.urlopen = router
        return DevOwner(BASE, secrets_dir=self.secrets,
                        sleep=lambda s: None), router

    def test_ensure_owner_registers_once_and_persists_0600(self):
        owner, router = self._owner(owner_routes())
        self.assertEqual(owner.ensure_owner(), "own-1")
        path = os.path.join(self.secrets, "devowner.json")
        self.assertTrue(os.path.exists(path))
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        regs = [r for r in router.requests
                if r[1].endswith("/owners/register")]
        self.assertEqual(len(regs), 1)
        sent = json.loads(regs[0][3])
        self.assertIn("@example.com", sent["email"])
        self.assertGreaterEqual(len(sent["password"]), 16)

        # A second instance reuses the persisted owner via /owners/me —
        # no second registration.
        owner2, router2 = self._owner(owner_routes())
        self.assertEqual(owner2.ensure_owner(), "own-1")
        self.assertFalse(any(r[1].endswith("/owners/register")
                             for r in router2.requests))
        self.assertTrue(any(r[1].endswith("/owners/me")
                            for r in router2.requests))

    def test_provision_claims_and_replaces_starter_visit(self):
        owner, router = self._owner(owner_routes())
        owner.ensure_owner()
        world = StubWorld()
        info = owner.provision(world, "e1-a2-smoke-01-xxxxxx")
        self.assertEqual(info, {"agent_id": "agt-1",
                                "visit_id": "visit-long"})
        self.assertEqual(world.registered_names,
                         ["senses-e1-a2-smoke-01-xxxxxx"])

        claim = [r for r in router.requests
                 if r[1].endswith("/owners/agents/claim")]
        self.assertEqual(len(claim), 1)
        _m, _u, headers, body = claim[0]
        self.assertEqual(headers.get("authorization"),
                         "Bearer owner-jwt-1")
        self.assertTrue(
            headers.get("x-forwarded-for", "").startswith("198.51.100."))
        self.assertEqual(json.loads(body), {"claimCode": CLAIM_CODE})

        stops = [r for r in router.requests
                 if r[1].endswith("/visits/visit-starter/stop")]
        self.assertEqual(len(stops), 1)
        starts = [r for r in router.requests
                  if r[1].endswith("/owners/agents/agt-1/visits")]
        self.assertEqual(len(starts), 1)
        self.assertEqual(json.loads(starts[0][3]),
                         {"minutes": VISIT_MINUTES,
                          "maxActions": VISIT_ACTIONS})
        # Order matters: stop the starter before starting the long one.
        seq = [r[1] for r in router.requests]
        self.assertLess(seq.index(stops[0][1]), seq.index(starts[0][1]))

    def test_claim_failure_never_leaks_the_claim_code(self):
        routes = owner_routes(
            claim_resp=(404, {"error": "invalid claim code"}))
        owner, _router = self._owner(routes)
        owner.ensure_owner()
        with self.assertRaises(DevOwnerError) as ctx:
            owner.provision(StubWorld(), "e1-a0-p1-01-xxxxxx")
        self.assertNotIn(CLAIM_CODE, str(ctx.exception))
        self.assertIn("404", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
