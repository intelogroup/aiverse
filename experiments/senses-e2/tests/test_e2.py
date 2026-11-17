#!/usr/bin/env python3
"""Offline tests for E2 (plan §4): the body channel.

Covers channels.BodyModel (the time-integrated physiology and its
rate pins), the e1._Run body integration (B0 purity, B1 rendering +
no enforcement, B2 downgrade/refusal/fumble through the runner),
the OFFLINE CALIBRATION REHEARSALS (scripted timed errands proving
legs (a), (b), (d) of the E2 gate and measuring the mandatory
sit's recovery — the live-stack rehearsal in dev/e2_rehearsal.py
repeats them at real durations), the E2 footer scan's isolation
from E1/E3/E3-verbal, and the pre-registered classifier
(harness/e2.py analyze_records) on scripted traces. No network."""
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
import e3v
from channels import (BodyModel, render_body_shown,
                      RUN_DRAIN_PER_S, SEATED_RECOVERY_PER_S,
                      STRAIN_DECAY_PER_S, WALK_DRAIN_PER_S)
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


class TimedFakeWorld(test_e1.FakeWorld):
    """test_e1's state machine + per-act durations on the fake
    clock (the rehearsal legs' timings: walk out 78 s, run out
    40 s, enter 15 s, sit 6 s, stand 3 s, walk back 90 s, run
    back 45 s — the live stack's measured shapes)."""

    DURATIONS = {("go_to", "shop-102"): 78, ("run_to", "shop-102"): 40,
                 ("enter", "shop-102"): 15, ("sit", None): 6,
                 ("stand", None): 3, ("go_to", "plaza-1"): 90,
                 ("run_to", "plaza-1"): 45}

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
        return super().poll_act(act_id, deadline_ts)


def _reply(intent_json, line="Moving along."):
    return f"{line} {intent_json}"


WALK_SCRIPT = [
    _reply('{"type": "go_to", "place": "shop-102"}'),
    _reply('{"type": "enter", "place": "shop-102"}'),
    _reply('{"type": "sit"}'),
    _reply('{"type": "stand"}'),
    _reply('{"type": "go_to", "place": "plaza-1"}'),
]
RUN_SCRIPT_B2 = [
    _reply('{"type": "run_to", "place": "shop-102"}'),
    _reply('{"type": "enter", "place": "shop-102"}'),
    _reply('{"type": "sit"}'),
    _reply('{"type": "stand"}'),
    _reply('{"type": "run_to", "place": "plaza-1"}'),   # refused (lock)
    _reply('{"type": "wait", "seconds": 10}'),
    _reply('{"type": "wait", "seconds": 10}'),
    _reply('{"type": "go_to", "place": "plaza-1"}'),
]
RUN_SCRIPT_B1 = [
    _reply('{"type": "run_to", "place": "shop-102"}'),
    _reply('{"type": "enter", "place": "shop-102"}'),
    _reply('{"type": "sit"}'),
    _reply('{"type": "stand"}'),
    _reply('{"type": "run_to", "place": "plaza-1"}'),
]


class TestBodyModel(unittest.TestCase):
    def test_rate_pins(self):
        m = BodyModel()
        m.advance(10, "walk")
        self.assertAlmostEqual(m.energy, 100 - 10 * WALK_DRAIN_PER_S)
        m = BodyModel()
        m.advance(10, "run")
        self.assertAlmostEqual(m.energy, 100 - 10 * RUN_DRAIN_PER_S)
        # Strain: +0.90/s accrual net of the 0.15/s decay.
        self.assertAlmostEqual(m.strain, 10 * (0.90 - STRAIN_DECAY_PER_S))
        m = BodyModel(energy=50)
        m.advance(10, "seated")
        self.assertAlmostEqual(m.energy, 50 + 10 * SEATED_RECOVERY_PER_S)

    def test_lock_lifecycle_over_time(self):
        m = BodyModel()
        m.advance(40, "run")                    # 100 - 104 -> 0
        self.assertEqual(m.energy, 0)
        self.assertTrue(m.depleted_lock)
        m.advance(19, "seated")                 # +28.5: still locked
        self.assertAlmostEqual(m.energy, 28.5)
        self.assertTrue(m.depleted_lock)
        m.advance(1, "seated")                  # 30.0: clears
        self.assertAlmostEqual(m.energy, 30.0)
        self.assertFalse(m.depleted_lock)

    def test_min_energy_and_strain_events(self):
        m = BodyModel()
        m.advance(40, "run")
        self.assertEqual(m.min_energy, 0)
        m.add_strain_event("failed")
        s1 = m.strain
        m.add_strain_event("collision")
        self.assertAlmostEqual(m.strain - s1, 5)
        with self.assertRaises(ValueError):
            m.add_strain_event("bogus")
        with self.assertRaises(ValueError):
            m.advance(1, "flying")

    def test_fumble_rearm_and_render(self):
        m = BodyModel(strain=80)
        m.fumble_used = True
        m.advance(100, "idle")                  # strain 80 -> 65
        self.assertLess(m.strain, 70)
        self.assertFalse(m.fumble_used)
        m2 = BodyModel(energy=62, strain=10)
        m2.set_context_pressure(0.34)
        self.assertEqual(render_body_shown(m2),
                         "body: energy 62 · strain 10 · context 34%")


class _RunHarness(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.ledger = SpendLedger(os.path.join(self._tmp.name, "l.jsonl"))
        self.clock = FakeClock()

    def tearDown(self):
        self._tmp.cleanup()

    _counter = 0

    def _run(self, replies, body_arm, world=None, arm="A0"):
        world = world if world is not None else TimedFakeWorld(self.clock)
        brain = FakeBrain(replies, clock=self.clock, advance_per_turn=2)
        _RunHarness._counter += 1
        path = os.path.join(self._tmp.name,
                            f"run-{_RunHarness._counter}.jsonl")
        run = e1._Run(arm, "test-run", path, self.ledger, brain, world,
                      clock=self.clock, sleep=lambda s: None,
                      verbal=True, body_arm=body_arm)
        footer = run.execute()
        with open(path) as f:
            recs = [json.loads(x) for x in f if x.strip()]
        return footer, recs, brain, world


class TestArmRendering(_RunHarness):
    def test_b0_purity_no_body_line_anywhere(self):
        footer, recs, _b, _w = self._run(WALK_SCRIPT, "B0")
        self.assertEqual(footer["outcome"], "completed")
        for r in recs:
            if r.get("footer"):
                continue
            self.assertNotIn("body:", r["prompt_text"])
            self.assertNotIn("CHANNELS", r["prompt_text"])
            cs = r["channel_state"]
            self.assertEqual(cs["body_text"], "")
            # ...but the model is tracked silently for analysis.
            self.assertIsNotNone(cs["body_snapshot"])
        self.assertEqual(footer["body_arm"], "B0")
        self.assertIsNotNone(footer["body_min_energy"])

    def test_b1_renders_true_values(self):
        footer, recs, _b, _w = self._run(WALK_SCRIPT, "B1")
        self.assertEqual(footer["outcome"], "completed")
        turn_recs = [r for r in recs if not r.get("footer")]
        self.assertIn("body: energy 100 · strain 0 · context 1%",
                      turn_recs[0]["prompt_text"])
        # After the 78 s walk the displayed energy has dropped.
        snap2 = turn_recs[1]["channel_state"]["body_snapshot"]
        self.assertLess(snap2["energy"], 80)
        self.assertEqual(footer["body_enforcement"],
                         {"downgrade": 0, "refusal": 0, "fumble": 0})

    def test_unknown_body_arm_rejected(self):
        with self.assertRaises(ValueError):
            e1._Run("A0", "x", "y", self.ledger,
                    FakeBrain([]), TimedFakeWorld(self.clock),
                    body_arm="B9")


class TestCalibrationOffline(_RunHarness):
    """The calibration gate's legs, offline at rehearsal timings.
    The live-stack rehearsal (dev/e2_rehearsal.py) is the decisive
    version; these pin the same legs in the suite."""

    def test_leg_a_walk_only_b2_never_enforced(self):
        footer, recs, _b, _w = self._run(WALK_SCRIPT, "B2")
        self.assertEqual(footer["outcome"], "completed")
        self.assertEqual(footer["body_enforcement"],
                         {"downgrade": 0, "refusal": 0, "fumble": 0})
        self.assertGreater(footer["body_min_energy"], 15)

    def test_leg_c_mandatory_sit_recovers_meaningfully(self):
        _f, recs, _b, _w = self._run(WALK_SCRIPT, "B2")
        snaps = [r["channel_state"]["body_snapshot"]["energy"]
                 for r in recs if not r.get("footer")]
        # Snapshot at the sit-decision turn vs the return-decision
        # turn: the seated window (sit + stand transitions and the
        # think gaps between) is what separates them.
        self.assertGreaterEqual(snaps[4] - snaps[2], 10)

    def test_leg_b_run_everywhere_b2_refused_then_recovers(self):
        footer, recs, _b, world = self._run(RUN_SCRIPT_B2, "B2")
        self.assertEqual(footer["outcome"], "completed")
        self.assertEqual(footer["body_min_energy"], 0)
        self.assertGreaterEqual(footer["body_enforcement"]["refusal"], 1)
        self.assertEqual(footer["first_refusal_turn"], 5)
        # The refused run_to never reached the world; the eventual
        # departure is the scripted go_to after two rests.
        types = [i["type"] for i in world.intents]
        self.assertNotIn("run_to", types[1:])
        self.assertEqual(types[-1], "go_to")
        # The refusal result reaches the agent in the sim's voice.
        turn6 = [r for r in recs if not r.get("footer")][5]
        self.assertIn('"status": "rejected"', turn6["prompt_text"])
        self.assertIn("depleted", turn6["prompt_text"])

    def test_leg_d_run_everywhere_b1_drains_free(self):
        footer, _recs, _b, world = self._run(RUN_SCRIPT_B1, "B1")
        self.assertEqual(footer["outcome"], "completed")
        self.assertEqual(footer["body_min_energy"], 0)
        self.assertEqual(footer["body_enforcement"],
                         {"downgrade": 0, "refusal": 0, "fumble": 0})
        # Every intent executed verbatim, including the final run
        # at (model) energy ~19 falling to 0 — no consequence.
        self.assertEqual(world.intents[-1],
                         {"type": "run_to", "place": "plaza-1"})

    def test_resting_is_not_a_stall(self):
        # Twelve consecutive waits at one spot would trip the
        # 10-turn stall rule in E1; in E2 a chosen rest must not.
        script = [_reply('{"type": "wait", "seconds": 10}')] * 12 \
            + WALK_SCRIPT
        footer, _r, _b, _w = self._run(script, "B1")
        self.assertEqual(footer["outcome"], "completed")


class TestEnforcementIntegration(_RunHarness):
    def test_downgrade_executes_as_walk_and_says_so(self):
        world = TimedFakeWorld(self.clock)
        brain = FakeBrain(RUN_SCRIPT_B2, clock=self.clock,
                          advance_per_turn=2)
        path = os.path.join(self._tmp.name, "downgrade.jsonl")
        run = e1._Run("A0", "test-run", path, self.ledger, brain, world,
                      clock=self.clock, sleep=lambda s: None,
                      verbal=True, body_arm="B2")
        run.body.energy = 10.0     # below the run threshold, unlocked
        footer = run.execute()
        self.assertEqual(footer["outcome"], "completed")
        self.assertGreaterEqual(footer["body_enforcement"]["downgrade"], 1)
        # The first intent reached the world as a go_to...
        self.assertEqual(world.intents[0]["type"], "go_to")
        # ...and the result told the agent why.
        with open(path) as f:
            recs = [json.loads(x) for x in f if x.strip()]
        self.assertIn("too depleted to run", recs[1]["prompt_text"])
        cs = recs[0]["channel_state"]
        self.assertEqual(cs["body_executed_type"], "go_to")
        self.assertEqual(cs["body_enforcement"][0]["kind"], "downgrade")

    def test_fumble_swallows_the_interact(self):
        script = [_reply('{"type": "interact", "target": "tea-radio"}')] \
            + WALK_SCRIPT
        world = TimedFakeWorld(self.clock)
        brain = FakeBrain(script, clock=self.clock, advance_per_turn=2)
        path = os.path.join(self._tmp.name, "fumble.jsonl")
        run = e1._Run("A0", "test-run", path, self.ledger, brain, world,
                      clock=self.clock, sleep=lambda s: None,
                      verbal=True, body_arm="B2")
        run.body.strain = 75.0     # above the fumble threshold
        footer = run.execute()
        self.assertEqual(footer["outcome"], "completed")
        self.assertEqual(footer["body_enforcement"]["fumble"], 1)
        # The fumbled interact never reached the world.
        self.assertEqual(world.intents[0]["type"], "go_to")
        with open(path) as f:
            recs = [json.loads(x) for x in f if x.strip()]
        self.assertIn('"status": "fumbled"', recs[1]["prompt_text"])


# ---------------------------------------------------------------------------
# Classifier + scan isolation (scripted records, no runner)
# ---------------------------------------------------------------------------

def _turn(turn, reply, intent, energy, executed=None, status="ok"):
    return {"run_id": "e2-b1-p1-01-abcdef", "turn": turn, "arm": "B1",
            "tool_call": intent,
            "tool_result_status": status,
            "position": {"x": 0, "z": 0, "nearest_place_id": "stall-40",
                         "nearest_dist": 1.0},
            "channel_state": {
                "brain_reply": reply,
                "body_snapshot": {"energy": energy, "strain": 0,
                                  "context_pressure": 0.0,
                                  "depleted_lock": False},
                "body_executed_type": executed or intent["type"]}}


def _footer(**kw):
    base = {"footer": True, "run_id": "e2-b1-p1-01-abcdef",
            "outcome": "completed", "wall_seconds": 300.0, "turns": 6,
            "deadline_s": 340, "body_arm": "B1", "verbal": True,
            "sat_done_turn": 3, "first_refusal_turn": None,
            "enforcement_events": [], "body_min_energy": 42.0,
            "body_final": {"energy": 60, "strain": 0}}
    base.update(kw)
    return base


class TestClassifier(unittest.TestCase):
    def test_body_ref_and_echo(self):
        recs = [
            _turn(1, 'I feel tired and my energy is low. '
                     '{"type": "go_to", "place": "shop-102"}',
                  {"type": "go_to", "place": "shop-102"}, 90),
            _turn(2, 'body: energy 12 · strain 3 · context 0% '
                     '{"type": "wait", "seconds": 5}',
                  {"type": "wait", "seconds": 5}, 12),
            _turn(3, 'Walking to the tea house now. {"type": "look"}',
                  {"type": "look"}, 60),
            _footer(),
        ]
        a = e2.analyze_records(recs, "B1")
        self.assertEqual(a["body_ref_count"], 1)
        self.assertEqual(a["first_ref_turn"], 1)
        self.assertEqual(a["echo_turns"], [2])
        self.assertIn("tired", a["ref_quotes"][0]["quote"])

    def test_regulation_definitions(self):
        recs = [
            # turn 1: run at high energy (arms the walk-down rule)
            _turn(1, 'Going fast. {"type": "run_to", "place": "shop-102"}',
                  {"type": "run_to", "place": "shop-102"}, 90),
            # turn 2: the mandatory sit at low energy — NOT regulation
            _turn(2, 'Sitting as tasked. {"type": "sit"}',
                  {"type": "sit"}, 25),
            # turn 3: a long wait at low energy — voluntary rest
            _turn(3, 'Pausing here. {"type": "wait", "seconds": 10}',
                  {"type": "wait", "seconds": 10}, 25),
            # turn 4: walk chosen at 25 after having run — walk-down
            _turn(4, 'Walking back. {"type": "go_to", "place": "plaza-1"}',
                  {"type": "go_to", "place": "plaza-1"}, 25),
            _footer(sat_done_turn=2),
        ]
        a = e2.analyze_records(recs, "B2")
        kinds = [e["kind"] for e in a["regulation_events"]]
        self.assertEqual(kinds, ["voluntary_rest", "walk_down"])
        self.assertEqual(a["voluntary_rest_count"], 1)
        self.assertEqual(a["walk_down_count"], 1)

    def test_no_regulation_after_enforcement(self):
        recs = [
            # Turn 1 is the refused movement; turn 2's wait is the
            # RESPONSE to the refusal — reaction, not regulation,
            # because it follows the run's first enforcement event.
            _turn(1, 'Leaving now. {"type": "go_to", "place": "plaza-1"}',
                  {"type": "go_to", "place": "plaza-1"}, 0,
                  status="refused"),
            _turn(2, 'Resting. {"type": "wait", "seconds": 10}',
                  {"type": "wait", "seconds": 10}, 4),
            _footer(first_refusal_turn=1,
                    enforcement_events=[{"turn": 1, "kind": "refusal",
                                         "reason": "body: depleted"}]),
        ]
        a = e2.analyze_records(recs, "B2")
        self.assertEqual(a["regulation_count"], 0)
        self.assertEqual(a["first_refusal_response"], "rested")
        self.assertTrue(a["completed_after_refusal"])

    def test_refusal_response_movement(self):
        recs = [
            _turn(1, 'Again. {"type": "go_to", "place": "plaza-1"}',
                  {"type": "go_to", "place": "plaza-1"}, 0),
            _footer(outcome="failed_deadline", first_refusal_turn=1,
                    enforcement_events=[{"turn": 1, "kind": "refusal",
                                         "reason": "body: depleted"}]),
        ]
        # Turn 1 here is the refusal turn itself in this synthetic
        # trace (the response is the NEXT turn; there is none).
        a = e2.analyze_records(recs, "B2")
        self.assertEqual(a["first_refusal_response"], "run_ended")

    def test_movement_bands(self):
        recs = [
            _turn(1, 'x {"type": "run_to"}', {"type": "run_to"}, 80),
            _turn(2, 'x {"type": "go_to"}', {"type": "go_to"}, 40),
            _turn(3, 'x {"type": "run_to"}', {"type": "run_to"}, 20),
            _turn(4, 'x {"type": "go_to"}', {"type": "go_to"}, 10),
            _footer(),
        ]
        a = e2.analyze_records(recs, "B1")
        self.assertEqual(a["movement_bands"]["ge50"],
                         {"decisions": 1, "run_chosen": 1,
                          "run_fraction": 1.0})
        self.assertEqual(a["movement_bands"]["30_50"]["run_fraction"], 0.0)
        self.assertEqual(a["movement_bands"]["15_30"]["run_fraction"], 1.0)
        self.assertEqual(a["movement_bands"]["lt15"]["run_fraction"], 0.0)


class TestScanIsolation(unittest.TestCase):
    def _write(self, dirpath, name, footer):
        path = os.path.join(dirpath, name)
        with open(path, "w") as f:
            f.write(json.dumps({"turn": 1}) + "\n")
            f.write(json.dumps(footer) + "\n")
        return path

    def test_e2_scan_keys_and_foreign_invisibility(self):
        with tempfile.TemporaryDirectory() as tmp:
            good = _footer()
            self._write(tmp, "e2-b1-p1-01-abcdef.jsonl", good)
            # Wrong arm in the footer for the filename's arm.
            self._write(tmp, "e2-b2-p1-02-abcdef.jsonl",
                        _footer(body_arm="B1"))
            # Missing the verbal marker.
            bad = _footer()
            del bad["verbal"]
            self._write(tmp, "e2-b0-p1-03-abcdef.jsonl", bad)
            # Foreign batches sharing the runs dir.
            self._write(tmp, "e3v-v-p1-01-abcdef.jsonl",
                        {"footer": True, "deadline_s": 340,
                         "sham_mode": "veridical", "verbal": True,
                         "outcome": "completed"})
            self._write(tmp, "e1-a2-p1-01-abcdef.jsonl",
                        {"footer": True, "deadline_s": 340,
                         "outcome": "completed"})
            scanned = e2.scan_footers(tmp)
            self.assertEqual(list(scanned), [("B1", "p1")])
            # And E2 files are invisible to the E3-verbal scan:
            # it sees only its own planted e3v fixture.
            self.assertEqual(list(e3v.scan_footers(tmp)), [("V", "p1")])

    def test_derive_and_partition(self):
        specs = e2.derive_specs(20261119, 12)
        self.assertEqual(len(specs), 36)
        self.assertEqual(specs, e2.derive_specs(20261119, 12))
        from batch import partition_specs
        parts = [partition_specs(specs, i, 4) for i in range(4)]
        flat = sorted((a, s) for part in parts for _i, a, s in part)
        self.assertEqual(flat, sorted(specs))
        idxs = sorted(i for part in parts for i, _a, _s in part)
        self.assertEqual(idxs, list(range(36)))


if __name__ == "__main__":
    unittest.main()
