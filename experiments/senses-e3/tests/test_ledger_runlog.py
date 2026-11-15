#!/usr/bin/env python3
"""Offline tests for harness/ledger.py (plan §11 cap) and runlog.py (§2)."""
import hashlib
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "harness"))
from ledger import (INPUT_USD_PER_M, OUTPUT_USD_PER_M, SPEND_CAP_USD,
                    HaltError, SpendLedger, cost_for_usage)
from runlog import TurnLogger


class TestLedgerMath(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self._tmp.name, "ledger.jsonl")

    def tearDown(self):
        self._tmp.cleanup()

    def test_constants_are_jims_rule(self):
        # Brain pick (plan §11.1): DeepSeek V4 Flash actual prices, $1 cap.
        self.assertEqual((INPUT_USD_PER_M, OUTPUT_USD_PER_M, SPEND_CAP_USD),
                         (0.028, 0.056, 1.00))

    def test_cost_at_list_prices(self):
        self.assertAlmostEqual(
            cost_for_usage({"prompt_tokens": 1_000_000,
                            "completion_tokens": 1_000_000}), 0.084)
        # Plan §11's per-run estimate at DeepSeek prices: 120K in + 7.5K out.
        self.assertAlmostEqual(
            cost_for_usage({"prompt_tokens": 120_000,
                            "completion_tokens": 7_500}), 0.00378)

    def test_account_appends_and_cumulates(self):
        led = SpendLedger(self.path)
        e1 = led.account("m", {"prompt_tokens": 1_000_000,
                               "completion_tokens": 0})
        self.assertAlmostEqual(e1["cost_usd"], 0.028)
        self.assertAlmostEqual(e1["cumulative_usd"], 0.028)
        e2 = led.account("m", {"prompt_tokens": 0,
                               "completion_tokens": 1_000_000})
        self.assertAlmostEqual(e2["cumulative_usd"], 0.084)
        with open(self.path) as f:
            lines = [json.loads(x) for x in f if x.strip()]
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[1]["model"], "m")

    def test_spent_persists_across_reload(self):
        led = SpendLedger(self.path)
        led.account("m", {"prompt_tokens": 2_000_000,
                          "completion_tokens": 0})
        self.assertAlmostEqual(SpendLedger(self.path).spent(), 0.056)

    def test_check_ok_below_cap(self):
        led = SpendLedger(self.path)
        led.account("m", {"prompt_tokens": 1_000_000,
                          "completion_tokens": 1_000_000})
        self.assertAlmostEqual(led.check(), 0.084)  # no raise

    def test_halt_at_cap(self):
        led = SpendLedger(self.path)
        for _ in range(12):  # 12 x $0.084 = $1.008 >= $1.00 cap
            led.account("m", {"prompt_tokens": 1_000_000,
                              "completion_tokens": 1_000_000})
        self.assertAlmostEqual(led.spent(), 1.008)
        with self.assertRaises(HaltError):
            led.check()
        with self.assertRaises(HaltError):  # account also refuses past cap
            led.account("m", {"prompt_tokens": 1, "completion_tokens": 1})
        # The refused account appended nothing.
        self.assertEqual(len(led.entries()), 12)


class TestRunLog(unittest.TestCase):
    def test_record_shape_and_hash(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "run.jsonl")
            prompt = "TASK ... turn one prompt"
            with TurnLogger(path, run_id="r-1", arm="A2+B2") as log:
                log.log_turn(1, prompt, {"type": "go_to", "place": "tea"},
                             "ok", {"place": "plaza", "x": 0, "z": 0},
                             {"body_state": {"energy": 100}})
                log.log_turn(2, prompt + " v2", {"type": "rest"},
                             "ok", {"place": "tea", "x": 12, "z": 4}, {})
            with open(path) as f:
                recs = [json.loads(x) for x in f if x.strip()]
            self.assertEqual(len(recs), 2)
            r = recs[0]
            self.assertEqual(set(r), {"run_id", "ts", "turn", "arm",
                                      "prompt_sha256", "prompt_text",
                                      "tool_call", "tool_result_status",
                                      "position", "channel_state"})
            self.assertEqual(r["run_id"], "r-1")
            self.assertEqual(r["arm"], "A2+B2")
            self.assertEqual(r["turn"], 1)
            self.assertEqual(r["prompt_text"], prompt)
            self.assertEqual(
                r["prompt_sha256"],
                hashlib.sha256(prompt.encode("utf-8")).hexdigest())
            self.assertEqual(r["tool_call"], {"type": "go_to", "place": "tea"})
            self.assertEqual(r["tool_result_status"], "ok")

    def test_footer_record(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "run.jsonl")
            with TurnLogger(path, run_id="r-9", arm="A2") as log:
                log.log_turn(1, "p", {"type": "wait"}, "ok",
                             {"x": 0, "z": 0}, {})
                log.log_footer({"outcome": "completed", "turns": 1,
                                "wall_seconds": 42.5})
            with open(path) as f:
                recs = [json.loads(x) for x in f if x.strip()]
            self.assertEqual(len(recs), 2)
            foot = recs[1]
            self.assertTrue(foot["footer"])
            self.assertEqual(foot["run_id"], "r-9")
            self.assertEqual(foot["arm"], "A2")
            self.assertEqual(foot["outcome"], "completed")
            self.assertEqual(foot["wall_seconds"], 42.5)


if __name__ == "__main__":
    unittest.main()
