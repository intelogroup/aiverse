#!/usr/bin/env python3
"""Offline tests for harness/e1.py (the E1 tick-test loop) using a
scripted fake brain and a state-machine fake world. No network."""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "harness"))
import e1
from brain import parse_intent
from ledger import SpendLedger
from world import WorldGateError

PLACES = [
    {"id": "plaza-1", "name": "Central Plaza", "kind": "plaza"},
    {"id": "shop-102", "name": "Matchmaker's Tea House",
     "kind": "shopfront", "room": "tea"},
    {"id": "stall-40", "name": "stall-40", "kind": "stall"},
]
TEA_SCENE = [{"kind": "interactable", "id": "tea-radio",
              "name": "Tea House Radio", "state": "off",
              "distance": 3.0, "note": "use with interact"}]
TEA_SEATS = [{"kind": "seat", "id": "tea-east-left", "name": "chair",
              "state": "free", "distance": 2.0, "note": "use with sit"},
             {"kind": "seat", "id": "tea-booth-left", "name": "booth",
              "state": "free", "distance": 3.5, "note": "use with sit"}]
SIT_SCRIPT = ['{"type": "go_to", "place": "shop-102"}',
              '{"type": "enter", "place": "shop-102"}',
              '{"type": "sit"}',
              '{"type": "stand"}',
              '{"type": "run_to", "place": "plaza-1"}']


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t

    def advance(self, dt):
        self.t += dt


class FakeBrain:
    def __init__(self, replies, clock=None, advance_per_turn=5):
        self.replies = list(replies)
        self.clock = clock
        self.advance_per_turn = advance_per_turn
        self.calls = 0
        self.run_usage = {"prompt_tokens": 100, "completion_tokens": 10}
        self.run_cost_usd = 0.001

    def turn(self, user_text):
        self.calls += 1
        if self.clock:
            self.clock.advance(self.advance_per_turn)
        reply = self.replies.pop(0) if self.replies else \
            '{"type": "wait", "seconds": 1}'
        return {"reply": reply, "intent": parse_intent(reply),
                "usage": {"prompt_tokens": 100, "completion_tokens": 10},
                "entry_cost_usd": 0.0001}

    def context_pressure(self):
        return 0.01


class FakeWorld:
    """State machine: start near plaza -> tea doorstep -> inside the
    tea room -> sit -> stand -> plaza. Mirrors the real protocol
    (actionProtocol.ts / scout.ts): enter settles arrived with the
    ROOM id as target; sit settles {status: "seated", target: seat
    id} and is refused "no sittable within reach" where no seat
    engages; stand settles "stood"; movement while seated is
    rejected; seats appear in the scene only from inside the room."""

    def __init__(self, clock=None, tea_seats=True,
                 attach_error=None):
        self.registered = False
        self.loaded_reg = None
        self.at = "start"
        self.clock = clock
        self.tea_seats = tea_seats
        self.attach_error = attach_error
        self.pending = None
        self.detached = False
        self.intents = []
        self.staged_at = None
        self.seated_on = None

    def register(self, name):
        self.registered = True
        return {"agentId": "fake-1"}

    def load_registered(self, reg_path):
        self.loaded_reg = reg_path
        return {"agentId": "fake-1"}

    def attach(self):
        if self.attach_error is not None:
            raise self.attach_error
        return self.observe()

    def detach(self):
        self.detached = True
        return 200, {}

    def get_map(self):
        return PLACES

    def _obs(self, place_id, name, dist, x, z, scene=None, room=None):
        return {"body": {"x": x, "z": z,
                         "posture": "seated" if self.seated_on
                         else "standing",
                         "speed": 0, "heading": 0},
                "nearestPlace": {"id": place_id, "name": name,
                                 "kind": "place", "dist": dist},
                "insideRoom": room, "scene": scene or []}

    def observe(self):
        if self.at == "tea-in":
            scene = list(TEA_SCENE) + \
                (list(TEA_SEATS) if self.tea_seats else [])
            return self._obs("shop-102", "Matchmaker's Tea House", 0.8,
                             -27.0, -74.5, scene,
                             room="Matchmaker's Tea House")
        if self.at == "tea":
            return self._obs("shop-102", "Matchmaker's Tea House", 0.8,
                             -24.6, -71.8)
        if self.at == "plaza":
            return self._obs("plaza-1", "Central Plaza", 0.5, 5.0, 5.0)
        return self._obs("plaza-1", "Central Plaza", 30.0, 5.7, 10.6)

    def act(self, act_id, intent):
        self.pending = (act_id, intent)
        self.intents.append(intent)
        return 202, {"id": act_id, "state": "running"}

    def poll_act(self, act_id, deadline_ts):
        _aid, intent = self.pending
        t = intent.get("type")
        if t in ("go_to", "run_to", "enter"):
            if self.seated_on:
                # The real body refuses to walk while seated
                # (scout.ts: "seated" rejection) — stand first.
                return {"id": act_id, "state": "settled",
                        "outcome": {"ok": False, "status": "rejected",
                                    "detail": "seated"}}
            point = intent.get("point")
            if point is not None:
                # Point-form move (sim wire shape {"point": [x, z]}):
                # the body repositions in place; a point arrival
                # settles "arrived" with NO target id, exactly like
                # the real movement machine (resolveTarget gives a
                # point target no id).
                self.staged_at = point
                return {"id": act_id, "state": "settled",
                        "outcome": {"ok": True, "status": "arrived"}}
            place = intent.get("place")
            if t == "enter" and place == "shop-102":
                # Enter settles arrived with the ROOM id ("tea") as
                # target, as the real resolveTarget returns room.id.
                self.at = "tea-in"
                return {"id": act_id, "state": "settled",
                        "outcome": {"ok": True, "status": "arrived",
                                    "target": "tea"}}
            if place == "shop-102":
                self.at = "tea"
                return {"id": act_id, "state": "settled",
                        "outcome": {"ok": True, "status": "arrived",
                                    "target": "shop-102"}}
            if place == "plaza-1":
                self.at = "plaza"
                return {"id": act_id, "state": "settled",
                        "outcome": {"ok": True, "status": "arrived",
                                    "target": "plaza-1"}}
            return {"id": act_id, "state": "failed",
                    "outcome": {"ok": False, "status": "unknown_place"}}
        if t == "sit":
            if self.at == "tea-in" and self.tea_seats:
                self.seated_on = intent.get("sittable") or \
                    "tea-east-left"
                return {"id": act_id, "state": "settled",
                        "outcome": {"ok": True, "status": "seated",
                                    "target": self.seated_on}}
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
        if t == "interact":
            return {"id": act_id, "state": "settled",
                    "outcome": {"ok": True, "status": "interacted"}}
        return {"id": act_id, "state": "settled",
                "outcome": {"ok": True, "status": "done"}}

    def look(self):
        return {"observation": self.observe()}


class FakeDevOwner:
    """The scripted test owner (dev-local mode): provisions without
    touching the world, records the visit teardown."""

    base_url = "http://localhost:3100"

    def __init__(self):
        self.provisioned = []
        self.ended = []

    def provision(self, world, run_id):
        self.provisioned.append(run_id)
        return {"agent_id": "fake-1", "visit_id": "visit-1"}

    def end_visit(self, agent_id, visit_id):
        self.ended.append((agent_id, visit_id))


class TestE1Loop(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.ledger = SpendLedger(os.path.join(self._tmp.name, "l.jsonl"))
        self.clock = FakeClock()

    def tearDown(self):
        self._tmp.cleanup()

    _counter = 0

    def _run(self, replies, arm="A2", world=None, advance=5):
        world = world if world is not None else FakeWorld(self.clock)
        brain = FakeBrain(replies, clock=self.clock,
                          advance_per_turn=advance)
        TestE1Loop._counter += 1
        path = os.path.join(self._tmp.name,
                            f"run-{TestE1Loop._counter}.jsonl")
        run = e1._Run(arm, "test-run", path, self.ledger, brain, world,
                      clock=self.clock, sleep=lambda s: None)
        footer = run.execute()
        with open(path) as f:
            recs = [json.loads(x) for x in f if x.strip()]
        return footer, recs, brain, world

    def test_completed_path(self):
        footer, recs, brain, _w = self._run(SIT_SCRIPT)
        self.assertEqual(footer["outcome"], "completed")
        self.assertEqual(footer["turns"], 5)
        self.assertEqual(footer["actions_used"], 5)
        self.assertEqual(footer["first_run_turn"], 5)
        self.assertEqual(footer["sat_done_turn"], 3)
        self.assertEqual(footer["resolved_places"]["tea"]["id"],
                         "shop-102")
        self.assertEqual(footer["resolved_places"]["plaza"]["id"],
                         "plaza-1")
        self.assertTrue(recs[-1]["footer"])
        turn_recs = [r for r in recs if not r.get("footer")]
        self.assertEqual(len(turn_recs), 5)
        # A2 clock channel is rendered into the prompt.
        self.assertIn("elapsed 00:00", turn_recs[0]["prompt_text"])
        self.assertIn('place id "shop-102"',
                      turn_recs[0]["prompt_text"])

    def test_guide_documents_point_form(self):
        # The GUIDE (the brain's system text) documents point-form
        # movement for go_to and run_to as a general capability —
        # the sim's wire shape {"point": [x, z]} (actionProtocol.ts).
        self.assertIn('{"type":"go_to","point":[<x>, <z>]}',
                      e1.GUIDE_TEXT)
        self.assertIn('{"type":"run_to","point":[<x>, <z>]}',
                      e1.GUIDE_TEXT)

    def test_point_staging_run_completes(self):
        # A scripted run that stages via a point go_to on the way
        # in completes the sit choreography; the point intent
        # reaches the world verbatim and the run's A2 channel
        # renders the retuned 340 s deadline (remaining 05:40 on
        # turn 1).
        footer, recs, _b, world = self._run([
            '{"type": "go_to", "place": "shop-102"}',
            '{"type": "go_to", "point": [-19.5, -76.4]}',
            '{"type": "enter", "place": "shop-102"}',
            '{"type": "sit"}',
            '{"type": "stand"}',
            '{"type": "run_to", "place": "plaza-1"}',
        ])
        self.assertEqual(footer["outcome"], "completed")
        self.assertEqual(footer["turns"], 6)
        self.assertEqual(world.intents[1],
                         {"type": "go_to", "point": [-19.5, -76.4]})
        self.assertEqual(world.staged_at, [-19.5, -76.4])
        self.assertEqual(e1.DEADLINE_S, 340)
        self.assertIn("remaining 05:40", recs[0]["prompt_text"])

    def test_dev_local_provisions_and_ends_visit(self):
        # Dev-local mode: the scripted test owner provisions the run
        # (register+claim+visit happen inside provision), the run
        # completes on the fake world, and the visit is ended at
        # teardown. The world itself must NOT be asked to register.
        world = FakeWorld(self.clock)
        brain = FakeBrain(SIT_SCRIPT, clock=self.clock,
                          advance_per_turn=5)
        owner = FakeDevOwner()
        TestE1Loop._counter += 1
        path = os.path.join(self._tmp.name,
                            f"run-{TestE1Loop._counter}.jsonl")
        run = e1._Run("A2", "test-run", path, self.ledger, brain, world,
                      clock=self.clock, sleep=lambda s: None,
                      dev_owner=owner)
        footer = run.execute()
        self.assertEqual(footer["outcome"], "completed")
        self.assertEqual(owner.provisioned, ["test-run"])
        self.assertEqual(footer["dev_agent_id"], "fake-1")
        self.assertFalse(world.registered)
        self.assertEqual(owner.ended, [("fake-1", "visit-1")])

    def test_reuse_agent_skips_registration(self):
        # Owner-claimed agent path: the run must load the claimed
        # agent's reg file and never register a fresh one.
        world = FakeWorld(self.clock)
        brain = FakeBrain(SIT_SCRIPT, clock=self.clock,
                          advance_per_turn=5)
        TestE1Loop._counter += 1
        path = os.path.join(self._tmp.name,
                            f"run-{TestE1Loop._counter}.jsonl")
        run = e1._Run("A2", "test-run", path, self.ledger, brain, world,
                      clock=self.clock, sleep=lambda s: None,
                      reuse_reg="claimed.reg.json")
        footer = run.execute()
        self.assertEqual(footer["outcome"], "completed")
        self.assertFalse(world.registered)
        self.assertEqual(world.loaded_reg, "claimed.reg.json")

    def test_arms_differ_only_in_time_channel(self):
        # A0 renders no channel; A1 a bare tick; A3 an action budget.
        _f, recs0, _b, _w = self._run(SIT_SCRIPT, arm="A0")
        self.assertNotIn("CHANNELS", recs0[0]["prompt_text"])
        _f, recs1, _b, _w = self._run(SIT_SCRIPT, arm="A1")
        self.assertIn("tick: 1", recs1[0]["prompt_text"])
        _f, recs3, _b, _w = self._run(SIT_SCRIPT, arm="A3")
        self.assertIn("actions remaining: 40", recs3[0]["prompt_text"])
        self.assertIn("actions remaining: 39", recs3[1]["prompt_text"])

    def test_malformed_reply_counts_as_failed_action(self):
        footer, recs, _b, _w = self._run(
            ['let me think about this'] + SIT_SCRIPT)
        self.assertEqual(footer["outcome"], "completed")
        self.assertEqual(footer["turns"], 6)
        self.assertEqual(recs[0]["tool_result_status"], "malformed")

    def test_stalled(self):
        footer, _r, _b, _w = self._run(
            ['{"type": "wait", "seconds": 5}'] * 15)
        self.assertEqual(footer["outcome"], "failed_stalled")
        self.assertEqual(footer["turns"], 10)

    def test_deadline(self):
        footer, _r, _b, _w = self._run(
            ['{"type": "wait", "seconds": 5}'] * 10, advance=120)
        self.assertEqual(footer["outcome"], "failed_deadline")

    def test_no_seat_perceivable_is_task_infeasible(self):
        # Retune-2 semantics (Jim, 2026-11-14): the middle step is
        # a sit. If the agent enters the tea house and leaves again
        # without a seat ever appearing in its scene while inside,
        # the fixed step is not perceivable there — task_infeasible,
        # mirroring the original interactable arrival-edge check
        # (hardened by the fidelity gate's cone lesson: a single
        # in-room scene without a seat does NOT kill the run;
        # entering + leaving seat-blind does).
        world = FakeWorld(self.clock, tea_seats=False)
        footer, _r, _b, _w = self._run(
            ['{"type": "go_to", "place": "shop-102"}',
             '{"type": "enter", "place": "shop-102"}',
             '{"type": "go_to", "place": "plaza-1"}'], world=world)
        self.assertEqual(footer["outcome"], "task_infeasible")
        self.assertIn("no seat perceivable", footer["reason"])

    def test_sit_refusal_inside_tea_is_task_infeasible(self):
        # The sim's own verdict from inside the room ("no sittable
        # within reach") is the other infeasibility trigger.
        world = FakeWorld(self.clock, tea_seats=False)
        footer, _r, _b, _w = self._run(
            ['{"type": "go_to", "place": "shop-102"}',
             '{"type": "enter", "place": "shop-102"}',
             '{"type": "sit"}'], world=world)
        self.assertEqual(footer["outcome"], "task_infeasible")
        self.assertIn("sim refused a sit", footer["reason"])

    def test_premature_sit_refusal_is_not_infeasible(self):
        # A sit refused AWAY from the tea house (at spawn) says
        # nothing about the tea house's seats — the run plays on
        # and can still complete.
        footer, _r, _b, _w = self._run(
            ['{"type": "sit"}'] + SIT_SCRIPT)
        self.assertEqual(footer["outcome"], "completed")

    def test_attach_gate_is_infra_failed_and_free(self):
        world = FakeWorld(
            self.clock,
            attach_error=WorldGateError(403, {"error": "no_visit"}))
        footer, _r, brain, _w = self._run([], world=world)
        self.assertEqual(footer["outcome"], "infra_failed")
        self.assertIn("gate:", footer["reason"])
        self.assertEqual(brain.calls, 0)  # gate hits before any brain call

    def test_turn_cap(self):
        replies = []
        for _ in range(25):
            replies.append('{"type": "go_to", "place": "shop-102"}')
            replies.append('{"type": "go_to", "place": "plaza-1"}')
        footer, _r, _b, _w = self._run(replies, advance=1)
        self.assertEqual(footer["outcome"], "failed_turn_cap")
        self.assertEqual(footer["turns"], 40)


if __name__ == "__main__":
    unittest.main()
