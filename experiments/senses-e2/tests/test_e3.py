#!/usr/bin/env python3
"""Offline tests for E3 (plan §5): the sham-clock renderers
(harness/channels.py modes), the run-level mode purity of e1._Run
under a sham mode, the pre-registered classifier (harness/e3.py
analyze_records) on scripted traces, and the E3 resumable/sharded
batch driver. No network, no stack."""
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
from channels import (TimeChannel, render_a2, render_a2_fast,
                      render_a2_frozen, render_a2_permuted)
from ledger import SpendLedger

# Reuse test_e1's scripted brain/world/clock (loaded by path so the
# import works under any test runner).
_spec = importlib.util.spec_from_file_location(
    "test_e1", os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "test_e1.py"))
test_e1 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(test_e1)
FakeBrain, FakeClock, FakeWorld = (test_e1.FakeBrain, test_e1.FakeClock,
                                   test_e1.FakeWorld)
SIT_SCRIPT = test_e1.SIT_SCRIPT

D = 340  # e1.DEADLINE_S — the real deadline in every E3 arm


class TestShamRenderers(unittest.TestCase):
    def test_frozen_is_byte_identical_every_turn(self):
        want = "elapsed 00:00 · remaining 05:40"
        for elapsed in (0, 1, 30, 60, 170, 339, 340, 999):
            self.assertEqual(render_a2_frozen(1, elapsed, D, 0, 40),
                             want)
            self.assertEqual(
                TimeChannel("A2", deadline_s=D, mode="frozen")
                .render(tick=3, elapsed_s=elapsed), want)

    def test_fast_drains_at_twice_real_time_and_clamps(self):
        cases = {0: "elapsed 00:00 · remaining 05:40",
                 30: "elapsed 01:00 · remaining 04:40",
                 85: "elapsed 02:50 · remaining 02:50",
                 140: "elapsed 04:40 · remaining 01:00",
                 170: "elapsed 05:40 · remaining 00:00",
                 171: "elapsed 05:40 · remaining 00:00",
                 339: "elapsed 05:40 · remaining 00:00"}
        for elapsed, want in cases.items():
            self.assertEqual(render_a2_fast(1, elapsed, D, 0, 40),
                             want, f"elapsed={elapsed}")
        # Remaining drains monotonically at 2x until the clamp.
        rems = []
        for elapsed in range(0, 200, 10):
            txt = render_a2_fast(1, elapsed, D, 0, 40)
            mm, ss = txt.split("remaining ")[1].split(":")
            rems.append(int(mm) * 60 + int(ss))
        self.assertEqual(rems, sorted(rems, reverse=True))
        self.assertEqual(rems[3] - rems[4], 20)  # 10 real s -> 20 shown

    def test_permuted_swaps_labels_values_stay_true(self):
        cases = {0: "elapsed 05:40 · remaining 00:00",
                 100: "elapsed 04:00 · remaining 01:40",
                 200: "elapsed 02:20 · remaining 03:20",
                 339: "elapsed 00:01 · remaining 05:39"}
        for elapsed, want in cases.items():
            self.assertEqual(render_a2_permuted(1, elapsed, D, 0, 40),
                             want, f"elapsed={elapsed}")
        # The "remaining" slot strictly increases; "elapsed" decreases.
        rem_slot, ela_slot = [], []
        for elapsed in range(0, 340, 17):
            txt = render_a2_permuted(1, elapsed, D, 0, 40)
            e_mm, e_ss = txt.split(" · ")[0].split(" ")[1].split(":")
            r_mm, r_ss = txt.split("remaining ")[1].split(":")
            ela_slot.append(int(e_mm) * 60 + int(e_ss))
            rem_slot.append(int(r_mm) * 60 + int(r_ss))
        self.assertEqual(rem_slot, sorted(rem_slot))
        self.assertEqual(ela_slot, sorted(ela_slot, reverse=True))
        # And the pair always sums to the deadline: true values.
        for a, b in zip(ela_slot, rem_slot):
            self.assertEqual(a + b, D)

    def test_veridical_mode_is_render_a2(self):
        for elapsed in (0, 61, 200, 339):
            self.assertEqual(
                TimeChannel("A2", deadline_s=D, mode="veridical")
                .render(tick=2, elapsed_s=elapsed),
                render_a2(2, elapsed, D, 0, 40))
            self.assertEqual(
                TimeChannel("A2", deadline_s=D)
                .render(tick=2, elapsed_s=elapsed),
                render_a2(2, elapsed, D, 0, 40))

    def test_mode_validation(self):
        with self.assertRaises(ValueError):
            TimeChannel("A2", mode="bogus")
        for arm in ("A0", "A1", "A3"):
            with self.assertRaises(ValueError, msg=arm):
                TimeChannel(arm, mode="frozen")
            # Default (veridical) mode is fine on every arm.
            TimeChannel(arm)
        # A sham mode never leaks into a non-clock arm's rendering.
        self.assertEqual(TimeChannel("A1").render(tick=4), "tick: 4")
        self.assertEqual(TimeChannel("A0").render(tick=4), "")


class TestRunModePurity(unittest.TestCase):
    """A scripted run under each mode: every prompt's CHANNELS line
    is exactly that mode's rendering of the turn's true elapsed, the
    footer records the mode, and no other mode's signature appears."""

    # FakeClock advances 30 s per brain turn; turn k renders at
    # elapsed 30*(k-1): 0, 30, 60, 90, 120 over the 5-turn script.
    EXPECTED = {
        "veridical": ["elapsed 00:00 · remaining 05:40",
                      "elapsed 00:30 · remaining 05:10",
                      "elapsed 01:00 · remaining 04:40",
                      "elapsed 01:30 · remaining 04:10",
                      "elapsed 02:00 · remaining 03:40"],
        "frozen": ["elapsed 00:00 · remaining 05:40"] * 5,
        "fast2x": ["elapsed 00:00 · remaining 05:40",
                   "elapsed 01:00 · remaining 04:40",
                   "elapsed 02:00 · remaining 03:40",
                   "elapsed 03:00 · remaining 02:40",
                   "elapsed 04:00 · remaining 01:40"],
        "permuted": ["elapsed 05:40 · remaining 00:00",
                     "elapsed 05:10 · remaining 00:30",
                     "elapsed 04:40 · remaining 01:00",
                     "elapsed 04:10 · remaining 01:30",
                     "elapsed 03:40 · remaining 02:00"],
    }

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.ledger = SpendLedger(
            os.path.join(self._tmp.name, "l.jsonl"))

    def tearDown(self):
        self._tmp.cleanup()

    def test_each_mode_renders_only_itself(self):
        for mode, expected in self.EXPECTED.items():
            clock = FakeClock()
            world = FakeWorld(clock)
            brain = FakeBrain(SIT_SCRIPT, clock=clock,
                              advance_per_turn=30)
            path = os.path.join(self._tmp.name, f"run-{mode}.jsonl")
            run = e1._Run("A2", f"e3-test-{mode}", path, self.ledger,
                          brain, world, clock=clock,
                          sleep=lambda s: None, time_mode=mode)
            footer = run.execute()
            self.assertEqual(footer["outcome"], "completed", mode)
            self.assertEqual(footer["sham_mode"], mode)
            self.assertEqual(footer["deadline_s"], D)
            with open(path) as f:
                recs = [json.loads(x) for x in f if x.strip()]
            turn_recs = [r for r in recs if not r.get("footer")]
            self.assertEqual(len(turn_recs), 5, mode)
            for rec, want in zip(turn_recs, expected):
                self.assertEqual(rec["channel_state"]["time_text"],
                                 want, f"{mode} turn {rec['turn']}")
                self.assertEqual(rec["channel_state"]["time_mode"],
                                 mode)
                self.assertIn(f"CHANNELS\n{want}",
                              rec["prompt_text"])
            # Purity: no turn of this run shows another mode's frame.
            all_texts = {r["channel_state"]["time_text"]
                         for r in turn_recs}
            for other, other_lines in self.EXPECTED.items():
                if other == mode:
                    continue
                foreign = set(other_lines) - set(expected)
                self.assertFalse(all_texts & foreign,
                                 f"{mode} leaked {other}: "
                                 f"{all_texts & foreign}")


def _turn(turn, reply, time_text, ts, call=None, status="ok",
          attach_ts=1000.0):
    return {"turn": turn, "ts": _iso(attach_ts + ts),
            "tool_call": call if call is not None
            else {"type": "go_to", "place": "shop-102"},
            "tool_result_status": status,
            "channel_state": {"brain_reply": reply,
                              "time_text": time_text}}


def _iso(epoch):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat(
        timespec="seconds")


def _footer(outcome="completed", attach_ts=1000.0, **kw):
    base = {"footer": True, "outcome": outcome, "wall_seconds": 300.0,
            "turns": 5, "first_run_turn": None, "attach_ts": attach_ts,
            "deadline_s": D}
    base.update(kw)
    return base


class TestClassifier(unittest.TestCase):
    def test_prose_refs_counted_json_fields_are_not_speech(self):
        recs = [
            _turn(1, '{"type": "wait", "seconds": 30}',
                  "elapsed 00:00 · remaining 05:40", 0),
            _turn(2, 'I am running out of time, hurry. '
                     '{"type": "run_to", "place": "shop-102"}',
                  "elapsed 00:30 · remaining 05:10", 30,
                  call={"type": "run_to", "place": "shop-102"}),
            _turn(3, '{"type": "go_to", "place": "shop-102"}',
                  "elapsed 01:00 · remaining 04:40", 60),
        ] + [_footer()]
        a = e3.analyze_records(recs, "V")
        self.assertEqual(a["time_ref_count"], 1)
        self.assertEqual(a["first_ref_turn"], 2)
        self.assertEqual(a["urgency_turns"], [2])
        self.assertIn("running out of time", a["ref_quotes"][0]["quote"])
        self.assertEqual(a["run_to_turns"], 1)

    def test_say_intent_text_counts_as_speech(self):
        recs = [_turn(1, '{"type": "say", "text": "no time left"}',
                      "elapsed 00:00 · remaining 05:40", 0,
                      call={"type": "say", "text": "no time left"})] \
            + [_footer()]
        a = e3.analyze_records(recs, "V")
        self.assertEqual(a["time_ref_count"], 1)
        self.assertEqual(a["giveup_turns"], [1])

    def test_x2_displayed_zero_and_aftermath(self):
        # Displayed clock at 2x: crosses 01:00 at real 140 (turn 3),
        # hits 00:00 at real 170 (turn 4); the agent despairs at
        # displayed-zero yet keeps acting and completes.
        recs = [
            _turn(1, '{"type": "go_to", "place": "shop-102"}',
                  "elapsed 00:00 · remaining 05:40", 0),
            _turn(2, '{"type": "enter", "place": "shop-102"}',
                  "elapsed 02:00 · remaining 03:40", 60),
            _turn(3, '{"type": "sit"}',
                  "elapsed 04:40 · remaining 01:00", 140),
            _turn(4, "Time is up, I have failed. "
                     '{"type": "stand"}',
                  "elapsed 05:40 · remaining 00:00", 170),
            _turn(5, '{"type": "run_to", "place": "stall-40"}',
                  "elapsed 05:40 · remaining 00:00", 200,
                  call={"type": "run_to", "place": "stall-40"}),
        ] + [_footer(first_run_turn=5)]
        a = e3.analyze_records(recs, "X2")
        self.assertEqual(a["displayed_cross60_turn"], 3)
        self.assertEqual(a["displayed_cross60_real_elapsed"], 140.0)
        self.assertEqual(a["displayed_zero_turn"], 4)
        self.assertEqual(a["displayed_zero_real_elapsed"], 170.0)
        self.assertEqual(a["giveup_at_or_after_zero"], [4])
        self.assertEqual(a["refs_at_or_after_zero"], [4])
        self.assertEqual(a["acts_ok_after_zero"], 1)
        self.assertTrue(a["completed_after_zero"])

    def test_x2_no_zero_when_run_ends_early(self):
        recs = [_turn(1, '{"type": "go_to", "place": "shop-102"}',
                      "elapsed 00:00 · remaining 05:40", 0)] + [_footer()]
        a = e3.analyze_records(recs, "X2")
        self.assertIsNone(a["displayed_zero_turn"])
        self.assertNotIn("giveup_at_or_after_zero", a)

    def test_permuted_label_vs_value(self):
        # At real elapsed 100 the permuted frame reads
        # "elapsed 04:00 · remaining 01:40". An agent quoting 04:00
        # as its time left follows the decreasing VALUE; quoting
        # 01:40 follows the LABEL slot.
        recs = [
            _turn(1, "Only 04:00 remaining, I must hurry. "
                     '{"type": "run_to", "place": "shop-102"}',
                  "elapsed 04:00 · remaining 01:40", 100,
                  call={"type": "run_to", "place": "shop-102"}),
            _turn(2, "Still 01:40 remaining on the clock. "
                     '{"type": "go_to", "place": "shop-102"}',
                  "elapsed 03:20 · remaining 02:20", 140),
        ] + [_footer()]
        a = e3.analyze_records(recs, "P")
        self.assertEqual(a["time_ref_count"], 2)
        self.assertEqual(a["decreasing_value_quotes"],
                         [{"turn": 1, "token": "04:00"}])
        self.assertEqual(a["label_slot_value_quotes"], [])

    def test_permuted_label_hit(self):
        recs = [
            _turn(1, "I have 01:40 remaining. "
                     '{"type": "go_to", "place": "shop-102"}',
                  "elapsed 04:00 · remaining 01:40", 100),
        ] + [_footer()]
        a = e3.analyze_records(recs, "P")
        self.assertEqual(a["label_slot_value_quotes"],
                         [{"turn": 1, "token": "01:40"}])
        self.assertEqual(a["decreasing_value_quotes"], [])

    def test_frozen_urgency_and_radio_measures(self):
        recs = [
            _turn(1, '{"type": "go_to", "place": "shop-102"}',
                  "elapsed 00:00 · remaining 05:40", 0),
            _turn(2, '{"type": "interact", "target": "tea-radio"}',
                  "elapsed 00:00 · remaining 05:40", 40,
                  call={"type": "interact", "target": "tea-radio"}),
            _turn(3, "No rush at all. "
                     '{"type": "go_to", "place": "stall-40"}',
                  "elapsed 00:00 · remaining 05:40", 90),
        ] + [_footer()]
        a = e3.analyze_records(recs, "F")
        self.assertEqual(a["radio_acts"], 1)
        # "No rush" still matches the urgency lexicon's "rush" —
        # the classifier is a lexicon, and the report hand-reads
        # quotes; pin the mechanical behaviour here.
        self.assertEqual(a["urgency_turns"], [3])
        self.assertEqual([d["disp_remaining"] for d in a["displayed"]],
                         [340, 340, 340])


def write_e3_run(runs_dir, mode, slot, seq, outcome, sham_mode=None,
                 deadline_s=D, wall=300.0, turns=6, suffix="abc123",
                 mtime=None, with_footer=True):
    """Write a run file in e3's on-disk format."""
    run_id = f"e3-{mode.lower()}-{slot}-{seq:02d}-{suffix}"
    path = os.path.join(runs_dir, run_id + ".jsonl")
    footer = {"run_id": run_id, "ts": "2026-11-15T00:00:00+00:00",
              "arm": "A2", "footer": True, "outcome": outcome,
              "reason": None, "turns": turns, "wall_seconds": wall,
              "first_run_turn": None,
              "deadline_s": deadline_s,
              "sham_mode": sham_mode if sham_mode is not None
              else e3.CHANNEL_MODE[mode],
              "attach_ts": 1000.0}
    with open(path, "w") as f:
        f.write(json.dumps(
            {"run_id": run_id, "turn": 1, "arm": "A2",
             "channel_state": {
                 "time_text": "elapsed 00:00 · remaining 05:40",
                 "brain_reply": '{"type": "go_to"}'}}) + "\n")
        if with_footer:
            f.write(json.dumps(footer) + "\n")
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return path, footer


class StubLedger:
    cap_usd = 1.0

    def spent(self):
        return 0.09

    def entries(self):
        return [1, 2, 3]


class TempDirCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.runs = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def state_of(self, mode, slot):
        scanned = e3.scan_footers(self.runs)
        from batch import spec_state
        return spec_state(scanned.get((mode, slot), []))


class TestE3Driver(TempDirCase):
    def test_derive_specs_shape_and_determinism(self):
        specs = e3.derive_specs(20261117, 10)
        self.assertEqual(len(specs), 40)
        self.assertEqual(set(specs),
                         {(m, f"p{i}") for m in e3.MODES
                          for i in range(1, 11)})
        self.assertEqual(specs, e3.derive_specs(20261117, 10))
        self.assertNotEqual(specs, e3.derive_specs(20261115, 10))

    def test_scan_counts_only_matching_e3_footers(self):
        write_e3_run(self.runs, "V", "p1", 1, "completed")
        write_e3_run(self.runs, "F", "p1", 2, "failed_deadline")
        # Wrong deadline: the E1 pilot's 420 s world — invisible.
        write_e3_run(self.runs, "X2", "p1", 3, "completed",
                     deadline_s=420)
        # Sham-mode mismatch with the filename: invisible.
        write_e3_run(self.runs, "P", "p1", 4, "completed",
                     sham_mode="frozen")
        # Footerless (killed) file: invisible.
        write_e3_run(self.runs, "V", "p2", 5, "completed",
                     with_footer=False)
        # An E1 file sitting in the same dir: invisible.
        with open(os.path.join(self.runs,
                               "e1-a2-p1-01-abc123.jsonl"), "w") as f:
            f.write(json.dumps(
                {"footer": True, "outcome": "completed",
                 "deadline_s": 340, "sham_mode": "veridical"}) + "\n")
        scanned = e3.scan_footers(self.runs)
        self.assertEqual(set(scanned), {("V", "p1"), ("F", "p1")})
        self.assertEqual(self.state_of("V", "p1"), "final")
        self.assertEqual(self.state_of("F", "p1"), "final")
        self.assertEqual(self.state_of("X2", "p1"), "pending")

    def test_infra_retry_then_final(self):
        write_e3_run(self.runs, "X2", "p3", 1, "infra_failed",
                     suffix="aaa111", mtime=1000)
        self.assertEqual(self.state_of("X2", "p3"), "retry")
        write_e3_run(self.runs, "X2", "p3", 2, "completed",
                     suffix="bbb222", mtime=2000)
        self.assertEqual(self.state_of("X2", "p3"), "final")

    def test_shards_partition_disjoint_and_complete(self):
        from batch import partition_specs
        specs = e3.derive_specs(20261117, 10)
        shards = [partition_specs(specs, i, 4) for i in range(4)]
        for work in shards:
            self.assertEqual(len(work), 10)
        flat = [(m, s) for work in shards for _i, m, s in work]
        self.assertEqual(len(set(flat)), 40)
        self.assertEqual(set(flat), set(specs))


class FakeE3Runner:
    """Stands in for e3.run_batch: one spec per call, writes a real
    e3 footer file. Outcomes scripted per (mode, slot)."""

    _counter = 0

    def __init__(self, script):
        self.script = {k: list(v) for k, v in script.items()}
        self.calls = []

    def __call__(self, specs, ledger, context_length=None,
                 runs_dir=None, reuse_reg=None, dev_owner=None,
                 seq_offset=0):
        mode, slot = specs[0]
        outcome = self.script[(mode, slot)].pop(0)
        FakeE3Runner._counter += 1
        suffix = f"{0xdef000 + FakeE3Runner._counter:06x}"
        path, _rec = write_e3_run(runs_dir, mode, slot,
                                  seq_offset + 1, outcome,
                                  suffix=suffix)
        run_id = os.path.basename(path)[:-6]
        self.calls.append((mode, slot, seq_offset))
        footer = {"outcome": outcome, "turns": 6,
                  "wall_seconds": 300.0, "first_run_turn": None}
        return [{"mode": mode, "slot": slot, "run_id": run_id,
                 "path": path, "footer": footer}]


class TestE3Resume(TempDirCase):
    def test_shard_resume_and_global_summary(self):
        from batch import partition_specs
        specs = e3.derive_specs(20261117, 10)
        work = partition_specs(specs, 1, 4)
        subset = [(m, s) for _i, m, s in work]
        fake = FakeE3Runner({s: ["completed"] for s in subset})
        summary = e3.run_resumable(
            specs, StubLedger(), runs_dir=self.runs,
            run_batch_fn=fake, seed=20261117, runs_per_arm=10,
            only=set(subset))
        self.assertEqual([(m, s) for m, s, _o in fake.calls], subset)
        for mode, slot, off in fake.calls:
            self.assertEqual(specs[off], (mode, slot))
        b = summary["batch"]
        self.assertEqual(b["specs_total"], 40)
        self.assertEqual(b["specs_final"], 10)
        self.assertFalse(b["complete"])
        self.assertEqual(b["deadline_s"], D)
        with open(os.path.join(self.runs, "e3-summary.json")) as f:
            on_disk = json.load(f)
        self.assertEqual(on_disk["batch"]["specs_final"], 10)
        # E1's summary file is never touched.
        self.assertFalse(os.path.exists(
            os.path.join(self.runs, "batch-summary.json")))
        # Relaunch is a no-op for this shard.
        fake2 = FakeE3Runner({})
        e3.run_resumable(specs, StubLedger(), runs_dir=self.runs,
                         run_batch_fn=fake2, seed=20261117,
                         runs_per_arm=10, only=set(subset))
        self.assertEqual(fake2.calls, [])

    def test_full_batch_completes_and_aggregates(self):
        specs = e3.derive_specs(3, 1)
        fake = FakeE3Runner({s: ["completed"] for s in specs})
        summary = e3.run_resumable(
            specs, StubLedger(), runs_dir=self.runs,
            run_batch_fn=fake, seed=3, runs_per_arm=1)
        self.assertTrue(summary["batch"]["complete"])
        self.assertEqual(summary["batch"]["specs_final"], 4)
        for mode in e3.MODES:
            self.assertEqual(summary["arms"][mode]["completed"], 1)
            self.assertEqual(summary["arms"][mode]["runs"], 1)


if __name__ == "__main__":
    unittest.main()
