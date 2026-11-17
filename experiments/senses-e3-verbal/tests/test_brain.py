#!/usr/bin/env python3
"""Offline tests for harness/brain.py (OpenRouter brain, plan §11.1)."""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "harness"))
from brain import (MODEL_ID, BrainError, OpenRouterBrain, parse_intent,
                   resolve_model)
from ledger import HaltError, SpendLedger

MODELS = {"data": [
    {"id": "some/other-model", "context_length": 8192},
    {"id": MODEL_ID, "context_length": 1_048_576},
]}


def chat_body(reply, usage=None):
    body = {"choices": [{"message": {"content": reply}}]}
    if usage is not None:
        body["usage"] = usage
    return body


class FakeTransport:
    """request_fn stand-in: serves /models, then queued chat replies."""

    def __init__(self, chat_responses):
        self.chat_responses = list(chat_responses)
        self.calls = []

    def __call__(self, method, path, payload):
        self.calls.append((method, path, payload))
        if path == "/models":
            return 200, {}, MODELS
        item = self.chat_responses.pop(0)
        if isinstance(item, int):
            return item, {}, {"error": {"message": "boom"}}
        return 200, {}, item


class TestParseIntent(unittest.TestCase):
    def test_plain_json(self):
        self.assertEqual(parse_intent('{"type": "go_to", "place": "tea"}'),
                         {"type": "go_to", "place": "tea"})

    def test_prose_around_json(self):
        self.assertEqual(
            parse_intent('I will go now: {"type": "run_to", '
                         '"place": "plaza"} done'),
            {"type": "run_to", "place": "plaza"})

    def test_unknown_type_and_garbage(self):
        self.assertIsNone(parse_intent('{"type": "teleport"}'))
        self.assertIsNone(parse_intent('no json here'))
        self.assertIsNone(parse_intent(''))
        self.assertIsNone(parse_intent('[1, 2, 3]'))


class TestResolve(unittest.TestCase):
    def test_exact_id_found(self):
        entry = resolve_model(MODELS["data"])
        self.assertEqual(entry["id"], MODEL_ID)

    def test_absent_fails_closed(self):
        with tempfile.TemporaryDirectory() as d:
            led = SpendLedger(os.path.join(d, "l.jsonl"))
            b = OpenRouterBrain(
                ledger=led,
                request_fn=lambda m, p, pl: (200, {}, {"data": []}))
            with self.assertRaises(BrainError):
                b.resolve_startup()


class TestBrainTurn(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.ledger = SpendLedger(os.path.join(self._tmp.name, "l.jsonl"))
        self.sleeps = []

    def tearDown(self):
        self._tmp.cleanup()

    def _brain(self, responses):
        t = FakeTransport(responses)
        b = OpenRouterBrain(ledger=self.ledger, request_fn=t,
                            sleep=self.sleeps.append)
        b.resolve_startup()
        return b, t

    def test_turn_accounts_before_return_and_parses(self):
        usage = {"prompt_tokens": 1000, "completion_tokens": 50,
                 "total_tokens": 1050}
        b, _t = self._brain([chat_body('{"type": "interact", '
                                       '"target": "tea-radio"}', usage)])
        res = b.turn("OBSERVATION ...")
        self.assertEqual(res["intent"],
                         {"type": "interact", "target": "tea-radio"})
        self.assertEqual(res["usage"], usage)
        # $0.028/M in, $0.056/M out: 1000 in + 50 out.
        self.assertAlmostEqual(res["entry_cost_usd"],
                               1000 / 1e6 * 0.028 + 50 / 1e6 * 0.056)
        self.assertEqual(len(self.ledger.entries()), 1)
        self.assertEqual(b.run_usage["prompt_tokens"], 1000)
        self.assertAlmostEqual(b.context_pressure(),
                               1000 / 1_048_576, places=6)

    def test_malformed_reply_is_none_not_crash(self):
        b, _t = self._brain([chat_body("I think I will walk over there",
                                       {"prompt_tokens": 10,
                                        "completion_tokens": 5})])
        res = b.turn("turn")
        self.assertIsNone(res["intent"])
        self.assertEqual(len(self.ledger.entries()), 1)  # still accounted

    def test_missing_usage_is_estimated_and_accounted(self):
        b, _t = self._brain([chat_body('{"type": "wait", "seconds": 5}')])
        res = b.turn("turn")
        self.assertTrue(res["usage"].get("estimated"))
        self.assertEqual(len(self.ledger.entries()), 1)

    def test_retry_on_429_then_success(self):
        usage = {"prompt_tokens": 5, "completion_tokens": 5}
        b, t = self._brain([429, chat_body('{"type": "wait", '
                                           '"seconds": 1}', usage)])
        res = b.turn("turn")
        self.assertEqual(res["intent"]["type"], "wait")
        self.assertEqual(self.sleeps, [2])
        self.assertEqual(len(self.ledger.entries()), 1)

    def test_persistent_429_raises_brain_error(self):
        b, _t = self._brain([429, 429, 429, 429])
        with self.assertRaises(BrainError):
            b.turn("turn")
        self.assertEqual(self.sleeps, [2, 5, 10])
        self.assertEqual(len(self.ledger.entries()), 0)

    def test_halt_check_precedes_any_call(self):
        # Pre-fill the ledger to the cap: check() must fire BEFORE the
        # transport is touched.
        for _ in range(12):
            self.ledger.account("m", {"prompt_tokens": 1_000_000,
                                      "completion_tokens": 1_000_000})
        t = FakeTransport([chat_body('{"type": "wait", "seconds": 1}',
                                     {"prompt_tokens": 1,
                                      "completion_tokens": 1})])
        b = OpenRouterBrain(ledger=self.ledger, request_fn=t,
                            sleep=self.sleeps.append)
        with self.assertRaises(HaltError):
            b.turn("turn")
        self.assertEqual(t.calls, [])  # transport never touched


if __name__ == "__main__":
    unittest.main()
