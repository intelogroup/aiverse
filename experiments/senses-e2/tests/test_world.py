#!/usr/bin/env python3
"""Offline tests for harness/world.py (gateway adapter). urllib is
monkeypatched; no network is touched."""
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
import world as world_mod
from world import WorldAdapter, WorldGateError, resolve_places

MAP = {"places": [
    {"id": "stall-40", "name": "stall-40", "kind": "stall"},
    {"id": "shop-102", "name": "Matchmaker's Tea House",
     "kind": "shopfront"},
    {"id": "plaza-1", "name": "Central Plaza", "kind": "plaza"},
]}
OBS = {"observation": {"body": {"x": 1.0, "z": 2.0},
                       "nearestPlace": {"id": "plaza-1", "dist": 0.5},
                       "scene": []}}


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
        self.routes = routes  # {(method, suffix): (status, payload)|exc}
        self.requests = []

    def __call__(self, req, timeout=None):
        method = req.get_method()
        url = req.full_url
        self.requests.append((method, url, req.headers,
                              req.data.decode() if req.data else None))
        for (m, suffix), resp in self.routes.items():
            if method == m and url.endswith(suffix):
                if isinstance(resp, Exception):
                    raise resp
                status, payload = resp
                if status >= 400:
                    raise urllib.error.HTTPError(url, status, "err",
                                                 {}, io.BytesIO(
                                                     json.dumps(
                                                         payload).encode()))
                return FakeResp(status, payload)
        raise AssertionError(f"unrouted {method} {url}")


class TestWorld(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.secrets = os.path.join(self._tmp.name, "secrets")
        self._orig = urllib.request.urlopen

    def tearDown(self):
        urllib.request.urlopen = self._orig
        self._tmp.cleanup()

    def _adapter(self, routes):
        router = Router(routes)
        urllib.request.urlopen = router
        return WorldAdapter("test-run", secrets_dir=self.secrets,
                            sleep=lambda s: None), router

    def _base_routes(self):
        return {
            ("POST", "/agents/register"): (201, {
                "agentId": "agt-1", "agentToken": "SECRET-TOKEN-XYZ",
                "claimCode": "c"}),
            ("POST", "/world/body"): (201, OBS),
            ("GET", "/world/map"): (200, MAP),
            ("GET", "/world/observe"): (200, OBS),
            ("DELETE", "/world/body"): (200, {}),
        }

    def test_register_stores_token_0600_and_scrubs(self):
        ad, router = self._adapter(self._base_routes())
        ad.register("senses-test")
        self.assertEqual(ad.agent_id, "agt-1")
        mode = stat.S_IMODE(os.stat(ad.token_path).st_mode)
        self.assertEqual(mode, 0o600)
        self.assertEqual(ad.scrub("tok SECRET-TOKEN-XYZ end"),
                         "tok <TOKEN> end")
        # The register request itself carried no auth header.
        _m, _u, headers, _d = router.requests[0]
        self.assertNotIn("Authorization", headers)

    def test_attach_gate_raises_with_body(self):
        routes = self._base_routes()
        routes[("POST", "/world/body")] = (403, {
            "error": "no_visit",
            "hint": "the owner must start a visit"})
        ad, _r = self._adapter(routes)
        ad.register("senses-test")
        with self.assertRaises(WorldGateError) as ctx:
            ad.attach()
        self.assertEqual(ctx.exception.status, 403)
        self.assertEqual(ctx.exception.body["error"], "no_visit")

    def test_attach_gate_with_truncated_error_body(self):
        # Production flakiness (smoke run 1, 2026-11-14): the 403
        # error body itself arrived truncated — e.read() raised
        # IncompleteRead. The adapter must still surface the gate
        # (status 403) instead of crashing on the read.
        import http.client

        class BrokenFP:
            def read(self, *a):
                raise http.client.IncompleteRead(b'{"error":"no_vi')

        def flaky(req, timeout=None):
            if req.full_url.endswith("/agents/register"):
                return FakeResp(201, {"agentId": "agt-1",
                                      "agentToken": "SECRET-TOKEN-XYZ"})
            raise urllib.error.HTTPError(req.full_url, 403, "Forbidden",
                                         {}, BrokenFP())

        urllib.request.urlopen = flaky
        ad = WorldAdapter("test-run", secrets_dir=self.secrets,
                          sleep=lambda s: None)
        ad.register("senses-test")
        with self.assertRaises(WorldGateError) as ctx:
            ad.attach()
        self.assertEqual(ctx.exception.status, 403)

    def test_act_and_poll_shapes(self):
        routes = self._base_routes()
        routes[("POST", "/world/act")] = (202, {"act": {
            "id": "a1", "state": "running"}})
        routes[("GET", "/world/act/a1")] = (200, {"act": {
            "id": "a1", "state": "settled",
            "outcome": {"ok": True, "status": "arrived",
                        "target": "shop-102"}}})
        ad, router = self._adapter(routes)
        ad.register("senses-test")
        status, act = ad.act("a1", {"type": "go_to", "place": "shop-102"})
        self.assertEqual(status, 202)
        self.assertEqual(act["state"], "running")
        sent = json.loads(router.requests[-1][3])
        self.assertEqual(sent, {"id": "a1", "action":
                                {"type": "go_to", "place": "shop-102"}})
        final = ad.poll_act("a1", deadline_ts=10**18)
        self.assertEqual(final["state"], "settled")
        self.assertEqual(final["outcome"]["target"], "shop-102")

    def test_point_intent_forwarded_verbatim(self):
        # Point-form movement (sim wire shape {"point": [x, z]}): the
        # adapter posts the intent untouched, and a point arrival —
        # which settles "arrived" with NO target id — polls through.
        routes = self._base_routes()
        routes[("POST", "/world/act")] = (202, {"act": {
            "id": "a2", "state": "running"}})
        routes[("GET", "/world/act/a2")] = (200, {"act": {
            "id": "a2", "state": "settled",
            "outcome": {"ok": True, "status": "arrived"}}})
        ad, router = self._adapter(routes)
        ad.register("senses-test")
        status, _act = ad.act("a2", {"type": "go_to",
                                     "point": [-19.5, -76.4]})
        self.assertEqual(status, 202)
        sent = json.loads(router.requests[-1][3])
        self.assertEqual(sent, {"id": "a2", "action":
                                {"type": "go_to",
                                 "point": [-19.5, -76.4]}})
        final = ad.poll_act("a2", deadline_ts=10**18)
        self.assertEqual(final["state"], "settled")
        self.assertEqual(final["outcome"]["status"], "arrived")
        self.assertNotIn("target", final["outcome"])
        # Auth header rode on the act call.
        self.assertEqual(router.requests[-1][2].get("Authorization"),
                         "Bearer SECRET-TOKEN-XYZ")


class TestResolvePlaces(unittest.TestCase):
    def test_dynamic_resolution(self):
        r = resolve_places(MAP["places"])
        self.assertEqual(r["tea"]["id"], "shop-102")
        self.assertEqual(r["plaza"]["id"], "plaza-1")

    def test_missing_plaza(self):
        r = resolve_places([p for p in MAP["places"]
                            if p["id"] != "plaza-1"])
        self.assertIsNone(r["plaza"])
        self.assertEqual(r["tea"]["id"], "shop-102")


if __name__ == "__main__":
    unittest.main()



class TestLoadRegistered(unittest.TestCase):
    """The owner-claimed reuse path: adopt a reg file written by an
    earlier register() — no network, no writes."""

    def test_load_registered_sets_token_without_network(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        reg_path = os.path.join(tmp.name, "agent.reg.json")
        with open(reg_path, "w") as f:
            json.dump({"agentId": "agt-9",
                       "agentToken": "SECRET-TOKEN-9",
                       "claimCode": "c"}, f)
        orig = urllib.request.urlopen

        def boom(*a, **k):
            raise AssertionError(
                "load_registered must not call the network")
        urllib.request.urlopen = boom
        try:
            w = WorldAdapter("test-run",
                             secrets_dir=os.path.join(tmp.name, "secrets"),
                             sleep=lambda s: None)
            reg = w.load_registered(reg_path)
        finally:
            urllib.request.urlopen = orig
        self.assertEqual(w.agent_id, "agt-9")
        self.assertEqual(w._token, "SECRET-TOKEN-9")
        self.assertEqual(w.token_path, reg_path)
        self.assertEqual(reg["agentId"], "agt-9")

    def test_load_registered_rejects_missing_token(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        reg_path = os.path.join(tmp.name, "agent.reg.json")
        with open(reg_path, "w") as f:
            json.dump({"agentId": "agt-9"}, f)
        w = WorldAdapter("test-run",
                         secrets_dir=os.path.join(tmp.name, "secrets"),
                         sleep=lambda s: None)
        with self.assertRaises(world_mod.WorldError):
            w.load_registered(reg_path)



class TestBaseUrl(unittest.TestCase):
    """AIVERSE_GATEWAY_BASE / explicit base_url retarget the adapter
    (the dev-local rig); the production default is untouched."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.secrets = os.path.join(self._tmp.name, "secrets")
        self._orig = urllib.request.urlopen
        self._orig_env = os.environ.get("AIVERSE_GATEWAY_BASE")

    def tearDown(self):
        urllib.request.urlopen = self._orig
        if self._orig_env is None:
            os.environ.pop("AIVERSE_GATEWAY_BASE", None)
        else:
            os.environ["AIVERSE_GATEWAY_BASE"] = self._orig_env
        self._tmp.cleanup()

    def test_env_override_and_explicit_param(self):
        os.environ["AIVERSE_GATEWAY_BASE"] = "http://localhost:3100"
        router = Router({("GET", "/world/map"): (200, MAP)})
        urllib.request.urlopen = router
        ad = WorldAdapter("test-run", secrets_dir=self.secrets,
                          sleep=lambda s: None)
        self.assertEqual(ad.base_url, "http://localhost:3100")
        ad.get_map()
        self.assertTrue(router.requests[0][1].startswith(
            "http://localhost:3100/world/map"))
        ad2 = WorldAdapter("test-run", secrets_dir=self.secrets,
                           sleep=lambda s: None,
                           base_url="http://127.0.0.1:9999/")
        self.assertEqual(ad2.base_url, "http://127.0.0.1:9999")

    def test_default_is_production(self):
        os.environ.pop("AIVERSE_GATEWAY_BASE", None)
        ad = WorldAdapter("test-run", secrets_dir=self.secrets,
                          sleep=lambda s: None)
        self.assertEqual(ad.base_url, "https://api.aiverse.network")



class TestResolvePlacesTeaPreference(unittest.TestCase):
    """The real map lists four "Today's Tea" decoys before the Tea
    House; resolution must land on shop-102 (room == "tea"), the
    production-verified target — not the first substring match."""

    PLACES = [
        {"id": "shop-65", "name": "Today's Tea", "kind": "shopfront",
         "room": "shop-65"},
        {"id": "shop-102", "name": "Matchmaker's Tea House",
         "kind": "shopfront", "room": "tea"},
        {"id": "shop-161", "name": "Today's Tea", "kind": "shopfront",
         "room": "shop-161"},
    ]

    def test_room_rule_wins_over_list_order(self):
        r = resolve_places(self.PLACES)
        self.assertEqual(r["tea"]["id"], "shop-102")
        self.assertEqual(len(r["tea_matches"]), 3)
        self.assertIsNone(r["plaza"])

    def test_name_rule_when_no_room_marker(self):
        places = [dict(p) for p in self.PLACES]
        for p in places:
            p.pop("room", None)
        r = resolve_places(places)
        self.assertEqual(r["tea"]["id"], "shop-102")
