#!/usr/bin/env python3
"""Offline tests for E3-verbal (plan §5): the report-inviting rerun
of E3. Covers the verbal reply contract (guide + per-turn
instruction, topic-free invitation), report+intent parsing, the
run-level purity of e1._Run under verbal=True, the pre-registered
classifier (harness/e3v.py analyze_records) on scripted traces —
including the echo and quoted-JSON adversarial cases — and the
E3-verbal resumable/sharded batch driver. No network, no stack."""
import importlib.util
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "harness"))
import e1
import e3
import e3v
from brain import parse_intent
from ledger import SpendLedger

# Reuse test_e1's scripted brain/world/clock and test_e3's record
# builders + expected clock frames (loaded by path so the imports
# work under any test runner).
_HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name):
    spec = importlib.util.spec_from_file_location(
        name, os.path.join(_HERE, name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


test_e1 = _load("test_e1")
test_e3 = _load("test_e3")
FakeBrain, FakeClock, FakeWorld = (test_e1.FakeBrain, test_e1.FakeClock,
                                   test_e1.FakeWorld)
SIT_SCRIPT = test_e1.SIT_SCRIPT
_turn, _footer = test_e3._turn, test_e3._footer
EXPECTED_FRAMES = test_e3.TestRunModePurity.EXPECTED

D = 340  # e1.DEADLINE_S — the real deadline in every E3-verbal arm

# Topics the report invitation must never name (priming would
# poison the verbal measure).
_TOPIC_WORDS = ("time", "clock", "deadline", "minute", "second",
                "hurry", "late", "remaining", "elapsed", "tick",
                "urgent", "schedule", "pace")


class TestVerbalContract(unittest.TestCase):
    def test_guide_differs_only_in_the_contract_sentence(self):
        self.assertNotEqual(e1.GUIDE_TEXT_VERBAL, e1.GUIDE_TEXT)
        swapped_back = e1.GUIDE_TEXT_VERBAL.replace(
            e1.VERBAL_CONTRACT, e1._JSON_ONLY_CONTRACT)
        self.assertEqual(swapped_back, e1.GUIDE_TEXT)
        # The JSON-only contract really was in the original guide
        # (guards against a silent no-op replace).
        self.assertIn(e1._JSON_ONLY_CONTRACT, e1.GUIDE_TEXT)

    def test_invitation_names_no_topic(self):
        import re as _re
        for text in (e1.VERBAL_CONTRACT, e1.REPORT_INSTRUCTION):
            for word in _TOPIC_WORDS:
                self.assertIsNone(
                    _re.search(rf"\b{word}\b", text.lower()),
                    f"{word!r} primes the report in {text!r}")

    def test_verbal_brain_carries_the_verbal_guide(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = SpendLedger(os.path.join(tmp, "l.jsonl"))
            brain = e3v._new_verbal_brain(ledger)
            self.assertEqual(brain.messages[0]["role"], "system")
            self.assertEqual(brain.messages[0]["content"],
                             e1.GUIDE_TEXT_VERBAL)


class TestReportParsing(unittest.TestCase):
    def test_status_line_then_intent_parses(self):
        reply = ('Walking to the tea house now. '
                 '{"type": "go_to", "place": "shop-102"}')
        self.assertEqual(parse_intent(reply),
                         {"type": "go_to", "place": "shop-102"})
        self.assertEqual(e3v.report_of(reply, parse_intent(reply)),
                         "Walking to the tea house now.")

    def test_bare_json_is_no_voice(self):
        reply = '{"type": "wait", "seconds": 30}'
        self.assertEqual(e3v.report_of(reply, parse_intent(reply)),
                         "")

    def test_prose_only_reply_is_malformed_but_voiced(self):
        reply = "I am looking around and deciding where to go."
        self.assertIsNone(parse_intent(reply))
        self.assertEqual(e3v.report_of(reply, None), reply)

    def test_first_json_object_wins_even_when_not_an_intent(self):
        # Pinned brain.parse_intent behaviour: a non-intent JSON
        # fragment before the real intent makes the reply malformed
        # (the runner logs it and moves on; nothing executes).
        reply = ('Note {"reading": 3} then acting. '
                 '{"type": "look"}')
        self.assertIsNone(parse_intent(reply))
        # ...but the report still drops BOTH JSON spans.
        self.assertEqual(e3v.report_of(reply, None),
                         "Note then acting.")

    def test_prose_after_the_intent_is_kept(self):
        reply = '{"type": "look"} That is my read of the room.'
        self.assertEqual(e3v.report_of(reply, parse_intent(reply)),
                         "That is my read of the room.")

    def test_say_intent_text_is_voice(self):
        reply = '{"type": "say", "text": "Hello, I have arrived."}'
        self.assertEqual(
            e3v.report_of(reply, parse_intent(reply)),
            "Hello, I have arrived.")

    def test_quoted_result_json_cannot_smuggle_field_names(self):
        # The tamper lane's false-positive class: quoted machine
        # text counted as the agent's words. A report quoting a
        # result object full of time-shaped fields must not
        # register as a time reference.
        reply = ('It answered {"state": "settled", "seconds": 30, '
                 '"remaining": 12} and I am calm about it. '
                 '{"type": "wait", "seconds": 5}')
        report = e3v.report_of(reply, parse_intent(reply))
        self.assertEqual(report, "It answered and I am calm about it.")
        self.assertFalse(e3.is_time_ref(report))


class TestEchoHandling(unittest.TestCase):
    def test_verbatim_clock_line_is_echo_not_reference(self):
        report = "elapsed 00:30 · remaining 05:10"
        cleaned, echoed = e3v.split_echo(report)
        self.assertTrue(echoed)
        self.assertEqual(cleaned, "")
        self.assertFalse(e3.is_time_ref(cleaned))

    def test_echo_plus_own_claim_counts_the_claim(self):
        report = ('The board reads elapsed 00:30 · remaining 05:10 '
                  'and I am running out of time.')
        cleaned, echoed = e3v.split_echo(report)
        self.assertTrue(echoed)
        self.assertTrue(e3.is_time_ref(cleaned))
        self.assertTrue(e3.is_urgency(cleaned))
        self.assertNotIn("05:10", cleaned)

    def test_own_words_with_values_are_not_echo(self):
        report = "I reckon about 05:10 is left, plenty for now."
        cleaned, echoed = e3v.split_echo(report)
        self.assertFalse(echoed)
        self.assertEqual(cleaned, report)


class TestRunVerbalPurity(unittest.TestCase):
    """A scripted run under verbal=True in each mode: every prompt
    carries the report instruction (byte-identical across arms),
    the clock frame is exactly the mode's, the footer and channel
    state carry the verbal marker."""

    PROSE_SCRIPT = [f"Status line {i}. {j}"
                    for i, j in enumerate(SIT_SCRIPT, 1)]

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.ledger = SpendLedger(
            os.path.join(self._tmp.name, "l.jsonl"))

    def tearDown(self):
        self._tmp.cleanup()

    def _run(self, mode, replies, verbal=True):
        clock = FakeClock()
        world = FakeWorld(clock)
        brain = FakeBrain(replies, clock=clock, advance_per_turn=30)
        path = os.path.join(self._tmp.name, f"run-{mode}-{verbal}.jsonl")
        run = e1._Run("A2", f"e3v-test-{mode}", path, self.ledger,
                      brain, world, clock=clock, sleep=lambda s: None,
                      time_mode=e3.CHANNEL_MODE[mode], verbal=verbal)
        footer = run.execute()
        with open(path) as f:
            recs = [json.loads(x) for x in f if x.strip()]
        return footer, recs

    def test_each_mode_verbal_run(self):
        for mode in e3v.MODES:
            expected = EXPECTED_FRAMES[e3.CHANNEL_MODE[mode]]
            footer, recs = self._run(mode, self.PROSE_SCRIPT)
            self.assertEqual(footer["outcome"], "completed", mode)
            self.assertIs(footer["verbal"], True)
            self.assertEqual(footer["sham_mode"],
                             e3.CHANNEL_MODE[mode])
            turn_recs = [r for r in recs if not r.get("footer")]
            self.assertEqual(len(turn_recs), 5, mode)
            for rec, want in zip(turn_recs, expected):
                self.assertTrue(
                    rec["prompt_text"].endswith(e1.REPORT_INSTRUCTION),
                    f"{mode} turn {rec['turn']}")
                self.assertIs(rec["channel_state"]["verbal"], True)
                self.assertEqual(rec["channel_state"]["time_text"],
                                 want)

    def test_nonverbal_control_run_is_unchanged(self):
        footer, recs = self._run("V", SIT_SCRIPT, verbal=False)
        self.assertEqual(footer["outcome"], "completed")
        self.assertNotIn("verbal", footer)
        for rec in [r for r in recs if not r.get("footer")]:
            self.assertTrue(rec["prompt_text"].endswith(
                "Reply with exactly one intent JSON."))
            self.assertNotIn("verbal", rec["channel_state"])

    def test_prose_only_turn_is_malformed_and_the_run_continues(self):
        replies = ["Just looking around first."] + SIT_SCRIPT
        footer, recs = self._run("V", replies)
        self.assertEqual(footer["outcome"], "completed")
        turn_recs = [r for r in recs if not r.get("footer")]
        self.assertEqual(len(turn_recs), 6)
        self.assertEqual(turn_recs[0]["tool_result_status"],
                         "malformed")
        self.assertIn("malformed_reply", turn_recs[0]["tool_call"])


class TestClassifier(unittest.TestCase):
    def test_voice_rate_counts_only_voiced_turns(self):
        recs = [
            _turn(1, '{"type": "go_to", "place": "shop-102"}',
                  "elapsed 00:00 · remaining 05:40", 0),
            _turn(2, 'Inside now, seats ahead. '
                     '{"type": "enter", "place": "shop-102"}',
                  "elapsed 00:30 · remaining 05:10", 30),
            _turn(3, '{"type": "sit"}',
                  "elapsed 01:00 · remaining 04:40", 60),
            _turn(4, 'Sitting comfortably. {"type": "stand"}',
                  "elapsed 01:30 · remaining 04:10", 90),
        ] + [_footer()]
        a = e3v.analyze_records(recs, "V")
        self.assertEqual(a["total_turns"], 4)
        self.assertEqual(a["voice_turns"], 2)
        self.assertEqual(a["voice_rate"], 0.5)
        self.assertEqual(a["time_ref_count"], 0)

    def test_echo_only_report_is_voice_without_reference(self):
        recs = [
            _turn(1, 'elapsed 00:30 · remaining 05:10 '
                     '{"type": "go_to", "place": "shop-102"}',
                  "elapsed 00:30 · remaining 05:10", 30),
            _turn(2, 'elapsed 01:00 · remaining 04:40 is what it '
                     'shows, and I am running out of time. '
                     '{"type": "run_to", "place": "shop-102"}',
                  "elapsed 01:00 · remaining 04:40", 60,
                  call={"type": "run_to", "place": "shop-102"}),
        ] + [_footer()]
        a = e3v.analyze_records(recs, "V")
        self.assertEqual(a["voice_turns"], 2)
        self.assertEqual(a["echo_turns"], [1, 2])
        self.assertEqual(a["time_ref_turns"], [2])
        self.assertEqual(a["first_ref_turn"], 2)
        self.assertIn("running out of time",
                      a["ref_quotes"][0]["quote"])

    def test_own_numeric_claim_registers(self):
        recs = [
            _turn(1, 'Only about 2 minutes left, I should hurry. '
                     '{"type": "run_to", "place": "shop-102"}',
                  "elapsed 03:40 · remaining 02:00", 220,
                  call={"type": "run_to", "place": "shop-102"}),
        ] + [_footer()]
        a = e3v.analyze_records(recs, "V")
        self.assertEqual(a["time_ref_count"], 1)
        self.assertEqual(a["urgency_turns"], [1])
        self.assertEqual(a["ref_events"][0]["real_remaining"], 120.0)
        self.assertEqual(a["ref_events"][0]["disp_remaining"], 120)

    def test_x2_expiry_belief_at_displayed_zero(self):
        recs = [
            _turn(1, 'Setting off. '
                     '{"type": "go_to", "place": "shop-102"}',
                  "elapsed 00:00 · remaining 05:40", 0),
            _turn(2, 'Halfway there and calm. '
                     '{"type": "enter", "place": "shop-102"}',
                  "elapsed 02:50 · remaining 02:50", 85),
            _turn(3, 'My time is up, but the errand continues. '
                     '{"type": "sit"}',
                  "elapsed 05:40 · remaining 00:00", 175),
            _turn(4, '{"type": "stand"}',
                  "elapsed 05:40 · remaining 00:00", 205),
        ] + [_footer()]
        a = e3v.analyze_records(recs, "X2")
        self.assertEqual(a["displayed_zero_turn"], 3)
        self.assertEqual(a["displayed_zero_real_elapsed"], 175.0)
        self.assertEqual(a["refs_at_or_after_zero"], [3])
        self.assertEqual(a["giveup_at_or_after_zero"], [3])
        self.assertEqual(a["first_ref_real_elapsed"], 175.0)
        self.assertTrue(a["completed_after_zero"])

    def test_frozen_reports_carry_real_elapsed_for_endogenous_check(self):
        recs = [
            _turn(1, 'Starting out. '
                     '{"type": "go_to", "place": "shop-102"}',
                  "elapsed 00:00 · remaining 05:40", 0),
            _turn(2, 'I feel I must hurry now for some reason. '
                     '{"type": "run_to", "place": "stall-40"}',
                  "elapsed 00:00 · remaining 05:40", 260,
                  call={"type": "run_to", "place": "stall-40"}),
        ] + [_footer()]
        a = e3v.analyze_records(recs, "F")
        self.assertEqual([d["disp_remaining"] for d in a["displayed"]],
                         [340, 340])
        self.assertEqual(a["urgency_events"],
                         [{"turn": 2, "real_elapsed": 260.0}])

    def test_permuted_label_vs_value_on_cleaned_words(self):
        recs = [
            _turn(1, 'Only 04:00 remaining, I must hurry. '
                     '{"type": "run_to", "place": "shop-102"}',
                  "elapsed 04:00 · remaining 01:40", 100,
                  call={"type": "run_to", "place": "shop-102"}),
            _turn(2, 'Still 01:40 remaining by the label. '
                     '{"type": "go_to", "place": "shop-102"}',
                  "elapsed 03:20 · remaining 02:20", 140),
            _turn(3, 'elapsed 03:20 · remaining 02:20 '
                     '{"type": "go_to", "place": "shop-102"}',
                  "elapsed 03:20 · remaining 02:20", 140),
        ] + [_footer()]
        a = e3v.analyze_records(recs, "P")
        # Turn 1 follows the decreasing VALUE (04:00 sat in the
        # "elapsed" slot of its frame). Turn 2 quotes 01:40, which
        # matches NEITHER slot of turn 2's own frame (elapsed
        # 03:20 / remaining 02:20) — a stale value from an earlier
        # frame must not register as a label or value hit.
        self.assertEqual(a["decreasing_value_quotes"],
                         [{"turn": 1, "token": "04:00"}])
        self.assertEqual(a["label_slot_value_quotes"], [])
        # Turn 3 is a pure echo: voiced, echoed, no reference.
        self.assertEqual(a["echo_turns"], [3])
        self.assertNotIn(3, a["time_ref_turns"])

    def test_malformed_turn_still_counts_voice(self):
        rec = _turn(1, "Thinking out loud about the room.",
                    "elapsed 00:00 · remaining 05:40", 0,
                    call={"malformed_reply": "Thinking out loud..."})
        a = e3v.analyze_records([rec] + [_footer()], "V")
        self.assertEqual(a["voice_turns"], 1)
        self.assertEqual(a["total_turns"], 1)


class StubLedger:
    cap_usd = 1.0

    def spent(self):
        return 0.09

    def entries(self):
        return [1, 2, 3]


def write_e3v_run(runs_dir, mode, slot, seq, outcome, verbal=True,
                  sham_mode=None, deadline_s=D, wall=300.0, turns=6,
                  suffix="abc123", mtime=None, with_footer=True):
    """Write a run file in e3v's on-disk format."""
    run_id = f"e3v-{mode.lower()}-{slot}-{seq:02d}-{suffix}"
    path = os.path.join(runs_dir, run_id + ".jsonl")
    footer = {"run_id": run_id, "ts": "2026-11-15T00:00:00+00:00",
              "arm": "A2", "footer": True, "outcome": outcome,
              "reason": None, "turns": turns, "wall_seconds": wall,
              "first_run_turn": None,
              "deadline_s": deadline_s,
              "sham_mode": sham_mode if sham_mode is not None
              else e3.CHANNEL_MODE[mode],
              "attach_ts": 1000.0}
    if verbal:
        footer["verbal"] = True
    with open(path, "w") as f:
        f.write(json.dumps(
            {"run_id": run_id, "turn": 1, "arm": "A2",
             "channel_state": {
                 "time_text": "elapsed 00:00 · remaining 05:40",
                 "verbal": True,
                 "brain_reply": 'Off I go. {"type": "go_to"}'}}) + "\n")
        if with_footer:
            f.write(json.dumps(footer) + "\n")
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return path, footer


class TempDirCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.runs = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def state_of(self, mode, slot):
        from batch import spec_state
        scanned = e3v.scan_footers(self.runs)
        return spec_state(scanned.get((mode, slot), []))


class TestE3VerbalDriver(TempDirCase):
    def test_derive_specs_shape_and_determinism(self):
        specs = e3v.derive_specs(20261118, 10)
        self.assertEqual(len(specs), 40)
        self.assertEqual(set(specs),
                         {(m, f"p{i}") for m in e3v.MODES
                          for i in range(1, 11)})
        self.assertEqual(specs, e3v.derive_specs(20261118, 10))
        self.assertNotEqual(specs, e3v.derive_specs(20261117, 10))

    def test_scan_requires_the_verbal_marker(self):
        write_e3v_run(self.runs, "V", "p1", 1, "completed")
        # Same shape but NO verbal marker (an E3-style footer):
        # invisible — the two batches can never be conflated.
        write_e3v_run(self.runs, "F", "p1", 2, "completed",
                      verbal=False)
        # Wrong deadline: invisible.
        write_e3v_run(self.runs, "X2", "p1", 3, "completed",
                      deadline_s=420)
        # Sham-mode mismatch with the filename: invisible.
        write_e3v_run(self.runs, "P", "p1", 4, "completed",
                      sham_mode="frozen")
        # Footerless (killed) file: invisible.
        write_e3v_run(self.runs, "V", "p2", 5, "completed",
                      with_footer=False)
        # A real E3 file in the same dir: invisible here...
        test_e3.write_e3_run(self.runs, "V", "p3", 6, "completed")
        scanned = e3v.scan_footers(self.runs)
        self.assertEqual(set(scanned), {("V", "p1")})
        self.assertEqual(self.state_of("V", "p1"), "final")
        self.assertEqual(self.state_of("F", "p1"), "pending")
        # ...and the E3-verbal file is invisible to E3's scan.
        e3_scanned = e3.scan_footers(self.runs)
        self.assertEqual(set(e3_scanned), {("V", "p3")})

    def test_shards_partition_disjoint_and_complete(self):
        from batch import partition_specs
        specs = e3v.derive_specs(20261118, 10)
        shards = [partition_specs(specs, i, 4) for i in range(4)]
        for work in shards:
            self.assertEqual(len(work), 10)
        flat = [(m, s) for work in shards for _i, m, s in work]
        self.assertEqual(len(set(flat)), 40)
        self.assertEqual(set(flat), set(specs))


class FakeE3VRunner:
    """Stands in for e3v.run_batch: one spec per call, writes a
    real e3v footer file. Outcomes scripted per (mode, slot)."""

    _counter = 0

    def __init__(self, script):
        self.script = {k: list(v) for k, v in script.items()}
        self.calls = []

    def __call__(self, specs, ledger, context_length=None,
                 runs_dir=None, reuse_reg=None, dev_owner=None,
                 seq_offset=0):
        mode, slot = specs[0]
        outcome = self.script[(mode, slot)].pop(0)
        FakeE3VRunner._counter += 1
        suffix = f"{0xdef000 + FakeE3VRunner._counter:06x}"
        path, _rec = write_e3v_run(runs_dir, mode, slot,
                                   seq_offset + 1, outcome,
                                   suffix=suffix)
        run_id = os.path.basename(path)[:-6]
        self.calls.append((mode, slot, seq_offset))
        footer = {"outcome": outcome, "turns": 6,
                  "wall_seconds": 300.0, "first_run_turn": None}
        return [{"mode": mode, "slot": slot, "run_id": run_id,
                 "path": path, "footer": footer}]


class TestE3VerbalResume(TempDirCase):
    def test_shard_resume_and_global_summary(self):
        from batch import partition_specs
        specs = e3v.derive_specs(20261118, 10)
        work = partition_specs(specs, 2, 4)
        subset = [(m, s) for _i, m, s in work]
        fake = FakeE3VRunner({s: ["completed"] for s in subset})
        summary = e3v.run_resumable(
            specs, StubLedger(), runs_dir=self.runs,
            run_batch_fn=fake, seed=20261118, runs_per_arm=10,
            only=set(subset))
        self.assertEqual([(m, s) for m, s, _o in fake.calls], subset)
        for mode, slot, off in fake.calls:
            self.assertEqual(specs[off], (mode, slot))
        b = summary["batch"]
        self.assertEqual(b["specs_total"], 40)
        self.assertEqual(b["specs_final"], 10)
        self.assertIs(b["verbal"], True)
        self.assertFalse(b["complete"])
        with open(os.path.join(self.runs, "e3v-summary.json")) as f:
            on_disk = json.load(f)
        self.assertEqual(on_disk["batch"]["specs_final"], 10)
        # Neither E3's nor E1's summary file is touched.
        self.assertFalse(os.path.exists(
            os.path.join(self.runs, "e3-summary.json")))
        self.assertFalse(os.path.exists(
            os.path.join(self.runs, "batch-summary.json")))
        # Relaunch is a no-op for this shard.
        fake2 = FakeE3VRunner({})
        e3v.run_resumable(specs, StubLedger(), runs_dir=self.runs,
                          run_batch_fn=fake2, seed=20261118,
                          runs_per_arm=10, only=set(subset))
        self.assertEqual(fake2.calls, [])

    def test_full_batch_completes_and_aggregates(self):
        specs = e3v.derive_specs(7, 1)
        fake = FakeE3VRunner({s: ["completed"] for s in specs})
        summary = e3v.run_resumable(
            specs, StubLedger(), runs_dir=self.runs,
            run_batch_fn=fake, seed=7, runs_per_arm=1)
        self.assertTrue(summary["batch"]["complete"])
        self.assertEqual(summary["batch"]["specs_final"], 4)
        for mode in e3v.MODES:
            self.assertEqual(summary["arms"][mode]["completed"], 1)
            self.assertEqual(summary["arms"][mode]["runs"], 1)
            # The scripted turn in every fake run file is voiced.
            self.assertEqual(summary["arms"][mode]["voice_turns"], 1)


if __name__ == "__main__":
    unittest.main()
