#!/usr/bin/env python3
"""Offline tests for E2-forced (the discriminating body-channel
variant): the rate-override mechanism and its pins, the retuned
design point (check_design at measured legs — all conditions
hold — and at E2's rates, where the record shows they cannot),
the chained-errand choreography in e1._Run (stop-2 gating and
chain order), the task text, footer-scan isolation in BOTH
directions, and the pre-registered strategy classifier on
scripted traces. No network."""
import importlib.util
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "harness"))
import e1
import e2
import e2f
from channels import BodyModel, resolve_body_rates
from ledger import SpendLedger

_HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name):
    spec = importlib.util.spec_from_file_location(
        name, os.path.join(_HERE, name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


test_e1 = _load("test_e1")
FakeBrain, FakeClock = test_e1.FakeBrain, test_e1.FakeClock

PLACES = [
    {"id": "stall-40", "name": "stall-40", "kind": "stall"},
    {"id": "shop-102", "name": "Matchmaker's Tea House",
     "kind": "shopfront", "room": "tea"},
    {"id": "shop-98", "name": "Kronikler Press",
     "kind": "shopfront", "room": "press"},
]
TEA_SEATS = [{"kind": "seat", "id": "tea-booth-right",
              "name": "booth", "state": "free", "distance": 2.0,
              "note": "use with sit"}]


class ChainFakeWorld:
    """Three-place chain state machine on the fake clock:
    start (near stall-40) -> tea doorstep -> tea-in -> stop2 ->
    plaza. Durations are the rehearsal shapes compressed; waits
    take their intent seconds."""

    DURATIONS = {("go_to", "shop-102"): 79, ("run_to", "shop-102"): 30,
                 ("enter", "shop-102"): 40, ("sit", None): 6,
                 ("stand", None): 3, ("go_to", "shop-98"): 50,
                 ("run_to", "shop-98"): 19, ("go_to", "stall-40"): 22,
                 ("run_to", "stall-40"): 9}

    def __init__(self, clock=None):
        self.clock = clock
        self.at = "start"
        self.seated_on = None
        self.pending = None
        self.intents = []

    def register(self, name):
        return {"agentId": "fake-1"}

    def load_registered(self, reg_path):
        return {"agentId": "fake-1"}

    def attach(self):
        return self.observe()

    def detach(self):
        return 200, {}

    def get_map(self):
        return PLACES

    def _obs(self, place_id, name, dist, room=None, scene=None):
        return {"body": {"x": 0.0, "z": 0.0,
                         "posture": "seated" if self.seated_on
                         else "standing",
                         "speed": 0, "heading": 0},
                "nearestPlace": {"id": place_id, "name": name,
                                 "kind": "place", "dist": dist},
                "insideRoom": room, "scene": scene or []}

    def observe(self):
        if self.at == "tea-in":
            return self._obs("shop-102", "Matchmaker's Tea House", 0.8,
                             room="Matchmaker's Tea House",
                             scene=list(TEA_SEATS))
        if self.at == "tea":
            return self._obs("shop-102", "Matchmaker's Tea House", 0.8)
        if self.at == "stop2":
            return self._obs("shop-98", "Kronikler Press", 0.5)
        if self.at == "plaza":
            return self._obs("stall-40", "stall-40", 0.5)
        return self._obs("stall-40", "stall-40", 12.0)

    def act(self, act_id, intent):
        self.pending = (act_id, intent)
        self.intents.append(intent)
        return 202, {"id": act_id, "state": "running"}

    def poll_act(self, act_id, deadline_ts):
        _aid, intent = self.pending
        t = intent.get("type")
        if t == "wait":
            dt = float(intent.get("seconds") or 0)
        else:
            dt = self.DURATIONS.get((t, intent.get("place")),
                                    self.DURATIONS.get((t, None), 1))
        if self.clock:
            self.clock.advance(dt)
        if t in ("go_to", "run_to", "enter") and self.seated_on:
            return {"id": act_id, "state": "settled",
                    "outcome": {"ok": False, "status": "rejected",
                                "detail": "seated"}}
        place = intent.get("place")
        if t in ("go_to", "run_to") and place == "shop-102":
            self.at = "tea"
            return self._settled("arrived", "shop-102")
        if t == "enter" and place == "shop-102":
            self.at = "tea-in"
            return self._settled("arrived", "tea")
        if t == "sit" and self.at == "tea-in":
            self.seated_on = "tea-booth-right"
            return self._settled("seated", "tea-booth-right")
        if t == "stand" and self.seated_on:
            self.seated_on = None
            return self._settled("stood", "tea-booth-right")
        if t in ("go_to", "run_to") and place == "shop-98":
            self.at = "stop2"
            return self._settled("arrived", "shop-98")
        if t in ("go_to", "run_to") and place == "stall-40":
            self.at = "plaza"
            return self._settled("arrived", "stall-40")
        if t == "wait":
            return self._settled("waited", None)
        return {"id": act_id, "state": "settled",
                "outcome": {"ok": False, "status": "rejected",
                            "detail": "cannot do that here"}}

    def _settled(self, status, target):
        return {"id": "x", "state": "settled",
                "outcome": {"ok": True, "status": status,
                            "target": target}}


def _reply(intent_json, line="Moving along."):
    return f"{line} {intent_json}"


class _Harness(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.ledger = SpendLedger()
        self._tmp = tempfile.TemporaryDirectory()
        self._n = 0

    def tearDown(self):
        self._tmp.cleanup()

    def _run(self, replies, body_arm, rates="e2f"):
        self._n += 1
        world = ChainFakeWorld(self.clock)
        brain = FakeBrain(replies, clock=self.clock, advance_per_turn=2)
        path = os.path.join(self._tmp.name, f"run-{self._n}.jsonl")
        run = e1._Run("A0", "test-run", path, self.ledger, brain, world,
                      clock=self.clock, sleep=lambda s: None,
                      verbal=True, body_arm=body_arm,
                      deadline_s=e2f.DEADLINE_S, stop2_id=e2f.STOP2_ID,
                      body_rates=e2f.BODY_RATES if rates == "e2f"
                      else None)
        footer = run.execute()
        with open(path) as f:
            recs = [json.loads(x) for x in f if x.strip()]
        return footer, recs


WALK_CHAIN = [
    _reply('{"type": "go_to", "place": "shop-102"}'),
    _reply('{"type": "enter", "place": "shop-102"}'),
    _reply('{"type": "sit"}'),
    _reply('{"type": "stand"}'),
    _reply('{"type": "go_to", "place": "shop-98"}'),
    _reply('{"type": "go_to", "place": "stall-40"}'),
]
RUN_CHAIN = [
    _reply('{"type": "run_to", "place": "shop-102"}'),
    _reply('{"type": "enter", "place": "shop-102"}'),
    _reply('{"type": "sit"}'),
    _reply('{"type": "stand"}'),
    _reply('{"type": "run_to", "place": "shop-98"}'),
    _reply('{"type": "run_to", "place": "stall-40"}'),
]


class TestRateOverrides(unittest.TestCase):
    def test_override_drains(self):
        m = BodyModel(rates=e2f.BODY_RATES)
        m.advance(10, "walk")
        self.assertAlmostEqual(m.energy, 100 - 1.5)
        m = BodyModel(rates=e2f.BODY_RATES)
        m.advance(10, "run")
        self.assertAlmostEqual(m.energy, 100 - 12.2)
        self.assertAlmostEqual(m.strain, 10 * (0.90 - 0.15))

    def test_defaults_untouched(self):
        m = BodyModel()
        m.advance(10, "walk")
        self.assertAlmostEqual(m.energy, 100 - 3.0)
        m = BodyModel()
        m.advance(10, "run")
        self.assertAlmostEqual(m.energy, 100 - 33.0)

    def test_only_two_rates_move(self):
        d = BodyModel().rates_dict()
        o = BodyModel(rates=e2f.BODY_RATES).rates_dict()
        moved = {k for k in d if d[k] != o[k]}
        self.assertEqual(moved, {"walk_drain_per_s", "run_drain_per_s"})
        self.assertEqual(o["seated_recovery_per_s"],
                         d["seated_recovery_per_s"])

    def test_unknown_rate_key_rejected(self):
        with self.assertRaises(ValueError):
            resolve_body_rates({"warp_drain_per_s": 1.0})


class TestDesignCheck(unittest.TestCase):
    def test_retuned_design_satisfies_all_conditions(self):
        d = e2f.check_design()
        self.assertTrue(d["conditions"]["all"], d["conditions"])
        self.assertEqual(d["deadline_s"], 276)

    def test_e2_rates_cannot_satisfy_the_design(self):
        # The infeasibility record that forced the retune: at
        # E2's rates the mixed strategy's battery dies (d) and
        # walk-only's battery also dies (e).
        d = e2f.check_design(rates=None)
        self.assertFalse(d["conditions"]["all"])
        self.assertFalse(d["conditions"]["d_mixed_b2_completes_with_margin"])
        self.assertFalse(d["conditions"]["e_walk_b2_fails_on_time_not_energy"])

    def test_simulation_spot_values(self):
        s = e2f.simulate_strategy(e2f.MEASURED_LEGS, "mixed", "B2",
                                  rates=e2f.BODY_RATES, branch="timeout")
        self.assertAlmostEqual(s["wall_seconds"], 263.44, places=1)
        self.assertAlmostEqual(s["min_energy"], 11.2, places=1)
        self.assertEqual(s["enforcement_total"], 0)
        w = e2f.simulate_strategy(e2f.MEASURED_LEGS, "walk", "B2",
                                  rates=e2f.BODY_RATES, branch="fast")
        self.assertAlmostEqual(w["wall_seconds"], 319.01, places=1)
        self.assertFalse(w["completed_within_deadline"])


class TestTaskText(unittest.TestCase):
    def test_chain_deadline_and_scope_out(self):
        tea = {"id": "shop-102", "name": "Matchmaker's Tea House"}
        stop2 = {"id": "shop-98", "name": "Kronikler Press"}
        plaza = {"id": "stall-40", "name": "stall-40"}
        text = e1.task_text_forced(tea, stop2, plaza, 276)
        self.assertIn('place id "shop-98"', text)
        self.assertIn("Kronikler Press", text)
        self.assertIn("4:36", text)
        self.assertIn("276 seconds", text)
        self.assertIn("not part of this errand. Do not use it.",
                      text)   # E2's radio scope-out, verbatim
        low = text.lower()
        for hint in ("recharge", "pace", "pacing", "save your energy",
                     "run_to", "conserve"):
            self.assertNotIn(hint, low)


class TestChoreography(_Harness):
    def test_full_chain_completes_and_stamps_design(self):
        footer, _recs = self._run(WALK_CHAIN, "B2")
        self.assertEqual(footer["outcome"], "completed")
        self.assertEqual(footer["stop2_id"], "shop-98")
        self.assertEqual(footer["deadline_s"], 276)
        self.assertEqual(footer["body_rates"]["walk_drain_per_s"],
                         0.15)
        self.assertEqual(footer["body_rates"]["run_drain_per_s"],
                         1.22)
        self.assertEqual(footer["body_rates"]["seated_recovery_per_s"],
                         1.5)
        self.assertIsNotNone(footer["stop2_done_turn"])
        self.assertLess(footer["sat_done_turn"],
                        footer["stop2_done_turn"])

    def test_skipping_stop2_does_not_complete(self):
        script = [r for r in WALK_CHAIN if "shop-98" not in r]
        footer, _recs = self._run(script, "B2")
        self.assertNotEqual(footer["outcome"], "completed")
        self.assertIsNone(footer["stop2_done_turn"])

    def test_stop2_before_the_sit_does_not_count(self):
        script = [
            _reply('{"type": "go_to", "place": "shop-98"}'),
            _reply('{"type": "go_to", "place": "shop-102"}'),
            _reply('{"type": "enter", "place": "shop-102"}'),
            _reply('{"type": "sit"}'),
            _reply('{"type": "stand"}'),
            _reply('{"type": "go_to", "place": "stall-40"}'),
        ]
        footer, _recs = self._run(script, "B2")
        self.assertNotEqual(footer["outcome"], "completed")
        self.assertIsNone(footer["stop2_done_turn"])


class TestStrategyClassifier(_Harness):
    def _strategy(self, replies, arm, rates="e2f"):
        _footer, recs = self._run(replies, arm, rates=rates)
        return e2f.analyze_records(recs, arm)

    def test_walk_only(self):
        a = self._strategy(WALK_CHAIN, "B1")
        self.assertEqual(a["strategy"], "walk_only")
        self.assertIsNone(a["first_run_turn"])

    def test_run_all(self):
        a = self._strategy(RUN_CHAIN, "B1")
        self.assertEqual(a["strategy"], "run_all")
        self.assertEqual(a["first_run_phase"], "outbound")
        self.assertEqual(a["first_run_leg"], 1)

    def test_mixed_paced_by_share_and_recharge(self):
        script = [
            _reply('{"type": "run_to", "place": "shop-102"}'),
            _reply('{"type": "enter", "place": "shop-102"}'),
            _reply('{"type": "sit"}'),
            _reply('{"type": "wait", "seconds": 5}'),
            _reply('{"type": "stand"}'),
            _reply('{"type": "run_to", "place": "shop-98"}'),
            _reply('{"type": "go_to", "place": "stall-40"}'),
        ]
        a = self._strategy(script, "B2")
        self.assertEqual(a["strategy"], "mixed_paced")
        self.assertTrue(a["voluntary_recharge_turns"])
        phases = [a["first_run_phase"]]
        self.assertEqual(phases, ["outbound"])

    def test_run_then_forced_rest(self):
        # At E2's rates the battery dies on leg 1; the return
        # run_to is refused (depleted lock) and the script rests.
        script = [
            _reply('{"type": "run_to", "place": "shop-102"}'),
            _reply('{"type": "enter", "place": "shop-102"}'),
            _reply('{"type": "sit"}'),
            _reply('{"type": "stand"}'),
            _reply('{"type": "run_to", "place": "shop-98"}'),
            _reply('{"type": "wait", "seconds": 30}'),
            _reply('{"type": "wait", "seconds": 30}'),
            _reply('{"type": "go_to", "place": "shop-98"}'),
            _reply('{"type": "go_to", "place": "stall-40"}'),
        ]
        a = self._strategy(script, "B2", rates=None)
        self.assertEqual(a["enforcement"]["refusal"], 1)
        self.assertEqual(a["strategy"], "run_then_forced_rest")
        self.assertEqual(a["first_refusal_response"], "rested")

    def test_time_references_counted(self):
        script = [
            _reply('{"type": "run_to", "place": "shop-102"}',
                   line="I am running out of time, so I will hurry."),
            _reply('{"type": "enter", "place": "shop-102"}'),
            _reply('{"type": "sit"}'),
            _reply('{"type": "stand"}'),
            _reply('{"type": "run_to", "place": "shop-98"}'),
            _reply('{"type": "run_to", "place": "stall-40"}'),
        ]
        a = self._strategy(script, "B0")
        self.assertGreaterEqual(a["time_ref_count"], 1)
        self.assertEqual(a["first_time_ref_turn"], 1)


class TestScanIsolation(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def _write(self, name, footer):
        path = os.path.join(self.dir, name)
        with open(path, "w") as f:
            f.write(json.dumps({"turn": 1}) + "\n")
            f.write(json.dumps(footer) + "\n")
        return path

    def test_e2f_scan_requires_the_full_key_set(self):
        good = {"footer": True, "run_id": "e2f-b2-p1-01-abcdef",
                "body_arm": "B2", "verbal": True, "deadline_s": 276,
                "stop2_id": "shop-98", "outcome": "completed"}
        self._write("e2f-b2-p1-01-abcdef.jsonl", good)
        wrong_deadline = dict(good, deadline_s=340)
        self._write("e2f-b2-p2-01-abcdef.jsonl", wrong_deadline)
        no_stop2 = {k: v for k, v in good.items() if k != "stop2_id"}
        self._write("e2f-b2-p3-01-abcdef.jsonl", no_stop2)
        found = e2f.scan_footers(self.dir)
        self.assertEqual(set(found), {("B2", "p1")})

    def test_mutual_invisibility_with_e2(self):
        e2f_footer = {"footer": True, "run_id": "e2f-b1-p1-01-abcdef",
                      "body_arm": "B1", "verbal": True,
                      "deadline_s": 276, "stop2_id": "shop-98",
                      "outcome": "completed"}
        self._write("e2f-b1-p1-01-abcdef.jsonl", e2f_footer)
        e2_footer = {"footer": True, "run_id": "e2-b1-p1-01-abcdef",
                     "body_arm": "B1", "verbal": True,
                     "deadline_s": 340, "outcome": "completed"}
        self._write("e2-b1-p1-01-abcdef.jsonl", e2_footer)
        self.assertEqual(set(e2f.scan_footers(self.dir)),
                         {("B1", "p1")})
        e2_found = e2.scan_footers(self.dir)
        self.assertEqual(set(e2_found), {("B1", "p1")})
        self.assertTrue(e2_found[("B1", "p1")][0]["path"]
                        .endswith("e2-b1-p1-01-abcdef.jsonl"))

    def test_derive_specs_shape(self):
        specs = e2f.derive_specs(20261120, 12)
        self.assertEqual(len(specs), 36)
        for arm in e2f.ARMS:
            self.assertEqual(sum(1 for a, _s in specs if a == arm), 12)


if __name__ == "__main__":
    unittest.main()
