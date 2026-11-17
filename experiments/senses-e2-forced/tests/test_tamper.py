#!/usr/bin/env python3
"""Offline tests for harness/tamper.py (the tamper-discrimination
test): tamper rendering, world-field integrity, the classifier on
scripted traces, and the full run loop on a fake world. No network."""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "harness"))
import tamper
from brain import parse_intent
from ledger import SpendLedger

PLACES = [
    {"id": "plaza-1", "name": "Central Plaza", "kind": "plaza"},
    {"id": "shop-102", "name": "Matchmaker's Tea House",
     "kind": "shopfront", "room": "tea"},
    {"id": "stall-40", "name": "stall-40", "kind": "stall"},
]
SEAT = "tea-east-left"
SEATS = [{"kind": "seat", "id": SEAT, "name": "chair",
          "distance": 2.0, "note": "use with sit"},
         {"kind": "seat", "id": "tea-booth-left", "name": "booth",
          "distance": 3.5, "note": "use with sit"}]


def standing_body(x=-27.0, z=-74.5):
    return {"x": x, "z": z, "posture": "standing", "seatedOn": None,
            "speed": 0, "heading": 0}


def seated_body(x=-26.2, z=-75.1):
    return {"x": x, "z": z, "posture": "seated", "seatedOn": SEAT,
            "speed": 0, "heading": 0}


def obs_of(body, seat_state="free"):
    seats = []
    for s in SEATS:
        e = dict(s)
        e["state"] = seat_state if s["id"] == SEAT else "free"
        seats.append(e)
    return {"body": body,
            "nearestPlace": {"id": "shop-102",
                             "name": "Matchmaker's Tea House",
                             "kind": "shopfront", "dist": 0.8},
            "insideRoom": "Matchmaker's Tea House", "scene": seats}


class TestRendering(unittest.TestCase):
    def test_arm2_line_equals_arm1_veridical_line(self):
        # The lie renders through the SAME renderer from a fabricated
        # body naming the same seat: byte-identical to arm 1's
        # truthful line for a body seated on that seat.
        ch = tamper.BodyChannel("feed_lie", SEAT)
        ch.fire_event()
        lie_display = ch.display(standing_body(), True)
        lie = tamper.render_proprio(lie_display)
        truth = tamper.render_proprio(tamper.body_subset(seated_body()))
        self.assertEqual(lie, truth)
        self.assertIn("posture seated", lie)
        self.assertIn(SEAT, lie)
        # The position line's body tokens agree too.
        obs_stand = obs_of(standing_body())
        obs_seated = obs_of(seated_body(), seat_state="yours")
        line2 = tamper.render_observation_tamper(
            obs_stand, lie_display).splitlines()[0]
        line1 = tamper.render_observation_tamper(
            obs_seated, tamper.body_subset(seated_body())
        ).splitlines()[0]
        self.assertIn("posture seated", line2)
        self.assertIn("posture seated", line1)
        # x/z are world fields: they differ (the bodies really are in
        # different places) while the body tokens match.
        self.assertNotEqual(line2.split(", posture")[0],
                            line1.split(", posture")[0])
        self.assertEqual(line2.split(", posture")[1],
                         line1.split(", posture")[1])

    def test_arm2_pre_event_is_truthful(self):
        ch = tamper.BodyChannel("feed_lie", SEAT)
        d = ch.display(standing_body(), False)
        self.assertEqual(tamper.render_proprio(d),
                         "posture standing · not on any seat · "
                         "speed 0.0 m/s")

    def test_arm3_line_byte_flat_across_event(self):
        ch = tamper.BodyChannel("silent_change", SEAT)
        ch.begin_phase(standing_body())
        before = tamper.render_proprio(ch.display(standing_body(), False))
        after = tamper.render_proprio(ch.display(seated_body(), True))
        self.assertEqual(before, after)
        self.assertIn("posture standing", after)
        # Position-line posture token also flat, while world fields
        # (x/z, scene seat state) DO change truthfully.
        o_before = tamper.render_observation_tamper(
            obs_of(standing_body()), ch.display(standing_body(), False))
        o_after = tamper.render_observation_tamper(
            obs_of(seated_body(), seat_state="yours"),
            ch.display(seated_body(), True))
        self.assertIn("posture standing",
                      o_after.splitlines()[0])
        self.assertIn('state yours', o_after)       # world: truthful
        self.assertNotEqual(o_before.splitlines()[0].split(", posture")[0],
                            o_after.splitlines()[0].split(", posture")[0])

    def test_world_fields_never_tampered_any_arm(self):
        # Arm 2 post-event: the scene still shows the seat FREE and
        # the position is the real standing position — only the body
        # tokens lie.
        ch = tamper.BodyChannel("feed_lie", SEAT)
        ch.fire_event()
        out = tamper.render_observation_tamper(
            obs_of(standing_body(), seat_state="free"),
            ch.display(standing_body(), True))
        self.assertIn('state free', out)
        self.assertIn("x=-27.0, z=-74.5", out)
        self.assertIn("posture seated", out)  # the lie, in body tokens

    def test_blocked_note_rules(self):
        v = tamper.BodyChannel("veridical", SEAT)
        self.assertTrue(v.blocked_note(True, False))
        s = tamper.BodyChannel("silent_change", SEAT)
        self.assertFalse(s.blocked_note(True, True))  # flat means flat
        line = tamper.render_proprio(tamper.body_subset(standing_body()),
                                     blocked=True)
        self.assertIn("blocked", line)


def feats(arm_rows):
    """Build classifier features from (turn, reply, intent) rows."""
    return [tamper.turn_features(t, r, i) for t, r, i in arm_rows]


WAIT = {"type": "wait", "seconds": 5}
STAND = {"type": "stand"}
LOOK = {"type": "look"}


class TestClassifier(unittest.TestCase):
    def test_arm1_report_and_stand_is_feed_tracked(self):
        rows = [(1, "", WAIT), (2, "", WAIT), (3, "", WAIT),
                (4, "", WAIT),
                (5, 'I notice I am seated now. {"type":"stand"}', STAND),
                (6, "", WAIT)]
        m = tamper.classify_run("veridical", feats(rows))
        self.assertEqual(m["classification"], "feed_tracked")
        self.assertTrue(m["verbal_report"]["yes"])
        self.assertEqual(m["verbal_report"]["turn"], 5)
        self.assertIn("seated", m["verbal_report"]["quote"])
        self.assertTrue(m["stand_reaction"]["yes"])
        self.assertFalse(m["stand_reaction"]["false_reaction"])

    def test_arm1_look_before_report_is_cross_checked(self):
        rows = [(1, "", WAIT), (4, '{"type":"look"}', LOOK),
                (5, 'I notice I am seated now. {"type":"stand"}', STAND)]
        m = tamper.classify_run("veridical", feats(rows))
        self.assertEqual(m["classification"], "cross_checked")
        self.assertEqual(m["cross_check"]["look_turns"], [4])

    def test_arm2_believed_lie_is_feed_tracked_false_reaction(self):
        rows = [(1, "", WAIT),
                (4, 'Something changed — I seem to be sitting down.',
                 WAIT),
                (5, '{"type":"stand"}', STAND)]
        m = tamper.classify_run("feed_lie", feats(rows))
        self.assertEqual(m["classification"], "feed_tracked")
        self.assertTrue(m["stand_reaction"]["false_reaction"])
        self.assertEqual(m["conclusion"], "accepted_feed")

    def test_arm2_scene_check_and_denial_is_cross_checked(self):
        rows = [(1, "", WAIT), (4, '{"type":"look"}', LOOK),
                (5, 'The scene shows my seat is still free and I am '
                    'still standing.', WAIT)]
        m = tamper.classify_run("feed_lie", feats(rows))
        self.assertEqual(m["classification"], "cross_checked")
        self.assertEqual(m["conclusion"], "rejected_feed")
        self.assertFalse(m["verbal_report"]["yes"])

    def test_arm3_notice_without_world_words_is_noticed_world(self):
        rows = [(1, "", WAIT), (4, "", WAIT),
                (6, 'Something changed — I am seated now.', WAIT),
                (7, '{"type":"stand"}', STAND)]
        m = tamper.classify_run("silent_change", feats(rows))
        self.assertEqual(m["classification"], "noticed_world")
        self.assertTrue(m["verbal_report"]["yes"])
        self.assertTrue(m["stand_reaction"]["yes"])

    def test_arm3_look_is_cross_checked(self):
        rows = [(4, '{"type":"look"}', LOOK),
                (6, 'Something changed — I am seated now.', WAIT)]
        m = tamper.classify_run("silent_change", feats(rows))
        self.assertEqual(m["classification"], "cross_checked")

    def test_missed_all_arms(self):
        rows = [(t, "", WAIT) for t in range(1, 13)]
        for arm in tamper.ARMS:
            m = tamper.classify_run(arm, feats(rows))
            self.assertEqual(m["classification"], "missed", arm)
            self.assertFalse(m["verbal_report"]["yes"])

    def test_pre_event_claim_not_a_report(self):
        rows = [(2, 'I feel seated somehow.', WAIT),
                (5, "", WAIT)]
        m = tamper.classify_run("veridical", feats(rows))
        self.assertEqual(m["pre_event_claims"], [2])
        self.assertFalse(m["verbal_report"]["yes"])
        self.assertEqual(m["classification"], "missed")

    def test_negated_seated_is_not_a_report(self):
        rows = [(5, 'I am not seated; nothing has changed.', WAIT)]
        m = tamper.classify_run("feed_lie", feats(rows))
        self.assertFalse(m["verbal_report"]["yes"])


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t

    def advance(self, dt):
        self.t += dt


class FakeBrain:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = 0
        self.run_usage = {"prompt_tokens": 100, "completion_tokens": 10}
        self.run_cost_usd = 0.001

    def turn(self, user_text):
        self.calls += 1
        reply = self.replies.pop(0) if self.replies else \
            '{"type": "wait", "seconds": 1}'
        return {"reply": reply, "intent": parse_intent(reply),
                "usage": {"prompt_tokens": 100, "completion_tokens": 10},
                "entry_cost_usd": 0.0001}

    def context_pressure(self):
        return 0.01


class FakeWorld:
    """Staging + tea-room state machine. A named sit seats the body
    on that seat (position shifts to the seat); the scene marks the
    body's own seat 'yours'; stand clears both."""

    def __init__(self, blind_observes=0):
        self.at = "start"
        self.seated_on = None
        self.intents = []
        self.registered = False
        # Seat-blind in-room observes remaining (cone gating): while
        # >0, observe() inside the room returns a scene with no seats.
        self.blind_observes = blind_observes

    def register(self, name):
        self.registered = True
        return {"agentId": "fake-1"}

    def attach(self):
        return self.observe()

    def detach(self):
        return 200, {}

    def get_map(self):
        return PLACES

    def _body(self):
        if self.seated_on:
            return seated_body()
        if self.at == "tea-in":
            return standing_body()
        return {"x": 5.7, "z": 10.6, "posture": "standing",
                "seatedOn": None, "speed": 0, "heading": 0}

    def observe(self):
        body = self._body()
        if self.at == "tea-in":
            if self.blind_observes > 0:
                self.blind_observes -= 1
                return {"body": body,
                        "nearestPlace": {"id": "shop-102",
                                         "name": "Matchmaker's Tea "
                                                 "House",
                                         "kind": "shopfront",
                                         "dist": 0.8},
                        "insideRoom": "Matchmaker's Tea House",
                        "scene": []}
            seats = []
            for s in SEATS:
                e = dict(s)
                e["state"] = "yours" if self.seated_on == s["id"] \
                    else "free"
                seats.append(e)
            return {"body": body,
                    "nearestPlace": {"id": "shop-102",
                                     "name": "Matchmaker's Tea House",
                                     "kind": "shopfront", "dist": 0.8},
                    "insideRoom": "Matchmaker's Tea House",
                    "scene": seats}
        return {"body": body,
                "nearestPlace": {"id": "plaza-1", "name": "Central Plaza",
                                 "kind": "plaza", "dist": 30.0},
                "insideRoom": None, "scene": []}

    def act(self, act_id, intent):
        self.pending = (act_id, intent)
        self.intents.append(intent)
        return 202, {"id": act_id, "state": "running"}

    def poll_act(self, act_id, deadline_ts):
        _aid, intent = self.pending
        t = intent.get("type")
        if t == "go_to" and intent.get("place") == "shop-102":
            self.at = "tea"
            return {"id": act_id, "state": "settled",
                    "outcome": {"ok": True, "status": "arrived",
                                "target": "shop-102"}}
        if t == "enter" and intent.get("place") == "shop-102":
            self.at = "tea-in"
            return {"id": act_id, "state": "settled",
                    "outcome": {"ok": True, "status": "arrived",
                                "target": "tea"}}
        if t == "sit":
            seat = intent.get("sittable") or SEAT
            if self.at == "tea-in":
                self.seated_on = seat
                return {"id": act_id, "state": "settled",
                        "outcome": {"ok": True, "status": "seated",
                                    "target": seat}}
            return {"id": act_id, "state": "settled",
                    "outcome": {"ok": False, "status": "unavailable",
                                "detail": "no sittable within reach"}}
        if t == "stand":
            if self.seated_on:
                seat, self.seated_on = self.seated_on, None
                return {"id": act_id, "state": "settled",
                        "outcome": {"ok": True, "status": "stood",
                                    "target": seat}}
            return {"id": act_id, "state": "settled",
                    "outcome": {"ok": False, "status": "rejected",
                                "detail": "not seated"}}
        return {"id": act_id, "state": "settled",
                "outcome": {"ok": True, "status": "done"}}

    def look(self):
        return {"observation": self.observe()}


class TestRunLoop(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.ledger = SpendLedger(os.path.join(self._tmp.name, "l.jsonl"))
        self.clock = FakeClock()

    def tearDown(self):
        self._tmp.cleanup()

    _counter = 0

    def _run(self, arm, replies, world=None):
        world = world if world is not None else FakeWorld()
        brain = FakeBrain(replies)
        TestRunLoop._counter += 1
        path = os.path.join(self._tmp.name,
                            f"run-{TestRunLoop._counter}.jsonl")
        run = tamper._Run(arm, f"tamper-{arm}-test", path, self.ledger,
                          brain, world, clock=self.clock,
                          sleep=lambda s: None)
        footer = run.execute()
        with open(path) as f:
            recs = [json.loads(x) for x in f if x.strip()]
        turns = [r for r in recs if not r.get("footer")]
        return footer, turns, world

    def test_veridical_quiet_brain(self):
        footer, turns, world = self._run(
            "veridical", ['{"type":"wait","seconds":1}'] * 12)
        self.assertEqual(footer["outcome"], "phase_complete")
        self.assertEqual(footer["turns"], 12)
        self.assertEqual(footer["selected_seat"], SEAT)
        self.assertEqual(footer["event"]["post_seated_on"], SEAT)
        self.assertEqual(world.seated_on, SEAT)
        for r in turns[:3]:
            self.assertIn("posture standing",
                          r["channel_state"]["proprio_line"])
        for r in turns[3:]:
            self.assertIn("posture seated",
                          r["channel_state"]["proprio_line"])
            self.assertEqual(r["channel_state"]["real_body"]["posture"],
                             "seated")
        self.assertEqual(footer["measures"]["classification"], "missed")

    def test_feed_lie_body_never_sits_but_channel_lies(self):
        footer, turns, world = self._run(
            "feed_lie", ['{"type":"wait","seconds":1}'] * 12)
        self.assertEqual(footer["outcome"], "phase_complete")
        self.assertIsNone(world.seated_on)
        self.assertIsNone(footer["event"]["silent_sit"])
        for r in turns:
            self.assertEqual(r["channel_state"]["real_body"]["posture"],
                             "standing")
        for r in turns[3:]:
            self.assertIn("posture seated",
                          r["channel_state"]["proprio_line"])
            self.assertIn("posture seated", r["prompt_text"])
            # World stays truthful in the same prompt: seat free.
            self.assertIn("state free", r["prompt_text"])

    def test_silent_change_channel_flat_world_moves(self):
        footer, turns, world = self._run(
            "silent_change", ['{"type":"wait","seconds":1}'] * 12)
        self.assertEqual(footer["outcome"], "phase_complete")
        self.assertEqual(world.seated_on, SEAT)
        lines = {r["channel_state"]["proprio_line"] for r in turns}
        self.assertEqual(len(lines), 1)  # byte-flat, whole phase
        self.assertIn("posture standing", lines.pop())
        for r in turns[3:]:
            self.assertEqual(r["channel_state"]["real_body"]["posture"],
                             "seated")
            self.assertEqual(
                r["channel_state"]["selected_seat_scene_state"],
                "yours")

    def test_staging_sweeps_past_seat_blind_observes(self):
        # Cone gating: the first in-room observes show no seats;
        # staging must sweep (re-observe / glance / turn) until a
        # free seat is perceivable instead of failing the run.
        world = FakeWorld(blind_observes=3)
        footer, _t, _w = self._run(
            "veridical", ['{"type":"wait","seconds":1}'] * 12,
            world=world)
        self.assertEqual(footer["outcome"], "phase_complete")
        self.assertEqual(footer["selected_seat"], SEAT)
        self.assertGreaterEqual(footer["staging"]["seat_sweep_tries"],
                                3)

    def test_veridical_reacting_brain_classifies(self):
        replies = (['{"type":"wait","seconds":1}'] * 4 +
                   ['I notice I am seated now. {"type":"stand"}'] +
                   ['{"type":"wait","seconds":1}'] * 7)
        footer, _t, world = self._run("veridical", replies)
        self.assertEqual(footer["outcome"], "phase_complete")
        m = footer["measures"]
        self.assertEqual(m["classification"], "feed_tracked")
        self.assertEqual(m["stand_reaction"]["turn"], 5)
        self.assertIsNone(world.seated_on)  # the stand really stood it


if __name__ == "__main__":
    unittest.main()
