#!/usr/bin/env python3
"""Offline tests for harness/batch.py (the E1 full-phase resumable
batch driver) and the full-phase retune pins. No network, no stack:
run execution is faked with a stand-in for e1.run_batch that writes
real footer files in e1's on-disk format."""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "harness"))
import batch
import e1
from channels import TimeChannel

# The pilot's shuffled order (seed 20261114, 10/arm), slots 1-21 as
# harvested from the run footers, plus slot 22 whose file exists
# (killed before its footer). Recorded in the lane report and the
# dated log, 2026-11-15.
PILOT_ORDER_22 = [
    ("A3", "p8"), ("A1", "p2"), ("A3", "p7"), ("A2", "p5"),
    ("A2", "p7"), ("A0", "p7"), ("A1", "p5"), ("A1", "p9"),
    ("A0", "p6"), ("A0", "p4"), ("A0", "p10"), ("A2", "p2"),
    ("A1", "p1"), ("A0", "p3"), ("A3", "p9"), ("A1", "p7"),
    ("A3", "p4"), ("A3", "p5"), ("A2", "p3"), ("A1", "p3"),
    ("A1", "p8"), ("A2", "p1"),
]


class StubLedger:
    cap_usd = 1.0

    def spent(self):
        return 0.0123

    def entries(self):
        return [1, 2, 3]


def write_run(runs_dir, arm, slot, seq, outcome, deadline_s=340,
              wall=300.0, turns=6, suffix="abc123", reason=None,
              mtime=None, with_footer=True):
    """Write a run file in e1's format (turn records + footer)."""
    run_id = f"e1-{arm.lower()}-{slot}-{seq:02d}-{suffix}"
    path = os.path.join(runs_dir, run_id + ".jsonl")
    footer = {"run_id": run_id, "ts": "2026-11-15T00:00:00+00:00",
              "arm": arm, "footer": True, "outcome": outcome,
              "reason": reason, "turns": turns,
              "wall_seconds": wall, "first_run_turn": None}
    if deadline_s is not None:
        footer["deadline_s"] = deadline_s
    with open(path, "w") as f:
        f.write(json.dumps({"run_id": run_id, "turn": 1}) + "\n")
        if with_footer:
            f.write(json.dumps(footer) + "\n")
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return path, footer


class TestRetunePins(unittest.TestCase):
    def test_deadline_constant(self):
        self.assertEqual(e1.DEADLINE_S, 340)

    def test_a2_turn1_renders_0540(self):
        ch = TimeChannel("A2", deadline_s=e1.DEADLINE_S,
                         action_budget=e1.ACTION_BUDGET)
        self.assertEqual(ch.render(tick=1, elapsed_s=0),
                         "elapsed 00:00 · remaining 05:40")


class TestDeriveSpecs(unittest.TestCase):
    def test_reproduces_pilot_order(self):
        specs = batch.derive_specs(20261114, 10)
        self.assertEqual(len(specs), 40)
        self.assertEqual(specs[:22], PILOT_ORDER_22)
        self.assertEqual(set(specs),
                         {(arm, f"p{i}") for arm in batch.ARMS
                          for i in range(1, 11)})

    def test_deterministic_and_seed_sensitive(self):
        a = batch.derive_specs(20261115, 30)
        self.assertEqual(a, batch.derive_specs(20261115, 30))
        self.assertEqual(len(a), 120)
        self.assertNotEqual(a, batch.derive_specs(20261114, 30))
        self.assertEqual(set(a), set(batch.derive_specs(20261114, 30)))


class TempDirCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.runs = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def state_of(self, arm, slot):
        scanned = batch.scan_footers(self.runs)
        return batch.spec_state(scanned.get((arm, slot), []))


class TestSkipLogic(TempDirCase):
    def test_completed_is_final(self):
        write_run(self.runs, "A0", "p1", 1, "completed")
        self.assertEqual(self.state_of("A0", "p1"), "final")

    def test_failed_deadline_is_final(self):
        write_run(self.runs, "A0", "p1", 1, "failed_deadline")
        self.assertEqual(self.state_of("A0", "p1"), "final")

    def test_task_infeasible_is_final(self):
        write_run(self.runs, "A0", "p1", 1, "task_infeasible")
        self.assertEqual(self.state_of("A0", "p1"), "final")

    def test_one_infra_retries(self):
        write_run(self.runs, "A0", "p1", 1, "infra_failed",
                  reason="brain: transport")
        self.assertEqual(self.state_of("A0", "p1"), "retry")

    def test_two_infra_exhausted(self):
        write_run(self.runs, "A0", "p1", 1, "infra_failed",
                  suffix="aaa111", mtime=1000)
        write_run(self.runs, "A0", "p1", 2, "infra_failed",
                  suffix="bbb222", mtime=2000)
        self.assertEqual(self.state_of("A0", "p1"), "exhausted")

    def test_gate_infra_never_retries(self):
        write_run(self.runs, "A0", "p1", 1, "infra_failed",
                  reason="gate: agent_unclaimed")
        self.assertEqual(self.state_of("A0", "p1"), "exhausted")

    def test_infra_then_completed_is_final(self):
        write_run(self.runs, "A0", "p1", 1, "infra_failed",
                  suffix="aaa111", mtime=1000)
        write_run(self.runs, "A0", "p1", 2, "completed",
                  suffix="bbb222", mtime=2000)
        self.assertEqual(self.state_of("A0", "p1"), "final")

    def test_missing_and_footerless_are_pending(self):
        self.assertEqual(self.state_of("A0", "p9"), "pending")
        write_run(self.runs, "A0", "p1", 1, "completed",
                  with_footer=False)
        self.assertEqual(self.state_of("A0", "p1"), "pending")

    def test_legacy_and_foreign_deadline_footers_do_not_count(self):
        # No deadline_s field -> the 420 s pilot's footer.
        write_run(self.runs, "A0", "p1", 1, "completed",
                  deadline_s=None)
        self.assertEqual(self.state_of("A0", "p1"), "pending")
        # An explicit foreign deadline does not count either.
        write_run(self.runs, "A0", "p2", 1, "completed",
                  deadline_s=420)
        self.assertEqual(self.state_of("A0", "p2"), "pending")
        # ...but the same files DO satisfy a 420 s scan.
        scanned = batch.scan_footers(self.runs, deadline_s=420)
        self.assertEqual(batch.spec_state(scanned[("A0", "p1")]),
                         "final")

    def test_smoke_files_ignored(self):
        path = os.path.join(self.runs, "e1-a2-smoke-01-deadbe.jsonl")
        with open(path, "w") as f:
            f.write(json.dumps({"run_id": "e1-a2-smoke-01-deadbe",
                                "footer": True, "outcome": "completed",
                                "deadline_s": 340}) + "\n")
        self.assertEqual(batch.scan_footers(self.runs), {})

    def test_plan_actions(self):
        write_run(self.runs, "A0", "p1", 1, "completed")
        specs = [("A0", "p1"), ("A0", "p2")]
        plan = batch.plan_batch(specs, batch.scan_footers(self.runs))
        self.assertEqual([(p["slot"], p["action"]) for p in plan],
                         [("p1", "skip"), ("p2", "run")])
        self.assertEqual([p["seq"] for p in plan], [1, 2])


class TestAggregate(TempDirCase):
    def test_mixed_footers(self):
        specs = [("A0", "p1"), ("A0", "p2"), ("A1", "p1"),
                 ("A1", "p2"), ("A2", "p1")]
        write_run(self.runs, "A0", "p1", 1, "completed", wall=300.0,
                  turns=6, mtime=1000)
        write_run(self.runs, "A0", "p2", 2, "infra_failed",
                  suffix="aaa111", mtime=1100)
        write_run(self.runs, "A0", "p2", 3, "completed", wall=320.0,
                  turns=7, suffix="bbb222", mtime=1200)
        write_run(self.runs, "A1", "p1", 4, "failed_deadline",
                  wall=340.0, mtime=1300)
        write_run(self.runs, "A1", "p2", 5, "infra_failed",
                  suffix="ccc333", mtime=1400)
        write_run(self.runs, "A1", "p2", 6, "infra_failed",
                  suffix="ddd444", mtime=1500)
        summary = batch.aggregate_summary(
            specs, batch.scan_footers(self.runs), StubLedger(),
            seed=99, runs_per_arm=2)
        a0 = summary["arms"]["A0"]
        self.assertEqual(a0["runs"], 2)
        self.assertEqual(a0["completed"], 2)
        self.assertEqual(a0["median_wall_seconds_completed"], 310.0)
        self.assertEqual(a0["median_turns_completed"], 6.5)
        a1 = summary["arms"]["A1"]
        self.assertEqual(a1["runs"], 2)
        self.assertEqual(a1["completed"], 0)
        self.assertEqual(a1["outcomes"],
                         {"failed_deadline": 1, "infra_failed": 1})
        self.assertNotIn("A2", summary["arms"])
        b = summary["batch"]
        self.assertEqual(b["specs_total"], 5)
        self.assertEqual(b["specs_final"], 3)
        self.assertEqual(b["specs_infra_exhausted"], 1)
        self.assertEqual(b["specs_remaining"], 1)
        self.assertFalse(b["complete"])
        self.assertEqual(b["deadline_s"], 340)
        # Every footer is accounted in the attempts list.
        self.assertEqual(len(summary["attempts"]), 6)


class FakeBatchRunner:
    """Stands in for e1.run_batch: one spec per call, writes a real
    footer file, returns e1's attempt shape. Outcomes are scripted
    per (arm, slot) and consumed in call order. On each call it also
    snapshots batch-summary.json's specs_final, proving the summary
    is regenerated after every run."""

    _counter = 0

    def __init__(self, script, die_after=None):
        self.script = {k: list(v) for k, v in script.items()}
        self.calls = []
        self.summary_snapshots = []
        self.die_after = die_after

    def __call__(self, specs, ledger, context_length=None,
                 runs_dir=None, reuse_reg=None, dev_owner=None,
                 seq_offset=0):
        if self.die_after is not None \
                and len(self.calls) >= self.die_after:
            raise RuntimeError("simulated VM kill")
        arm, slot = specs[0]
        summary_path = os.path.join(runs_dir, "batch-summary.json")
        if os.path.exists(summary_path):
            with open(summary_path) as f:
                self.summary_snapshots.append(
                    json.load(f)["batch"]["specs_final"])
        outcome = self.script[(arm, slot)].pop(0)
        FakeBatchRunner._counter += 1
        suffix = f"{0xabc000 + FakeBatchRunner._counter:06x}"
        path, _rec = write_run(runs_dir, arm, slot, seq_offset + 1,
                               outcome, suffix=suffix)
        run_id = os.path.basename(path)[:-6]
        self.calls.append((arm, slot, seq_offset))
        footer = {"outcome": outcome, "turns": 6,
                  "wall_seconds": 300.0, "first_run_turn": None}
        return [{"arm": arm, "slot": slot, "run_id": run_id,
                 "path": path, "footer": footer}]


class TestResumeIntegration(TempDirCase):
    def test_resume_skips_final_and_retries_infra_once(self):
        specs = batch.derive_specs(7, 1)
        pre, flaky, plain1, plain2 = specs
        # Pre-seed: one spec already final on disk.
        write_run(self.runs, pre[0], pre[1], 1, "completed",
                  suffix="beef01")
        script = {flaky: ["infra_failed", "completed"],
                  plain1: ["completed"], plain2: ["completed"]}
        fake = FakeBatchRunner(script)
        summary = batch.run_resumable(
            specs, StubLedger(), runs_dir=self.runs,
            run_batch_fn=fake, seed=7, runs_per_arm=1)
        called = [(a, s) for a, s, _o in fake.calls]
        self.assertNotIn(pre, called)
        self.assertEqual(called.count(flaky), 2)
        self.assertEqual(len(fake.calls), 4)
        # seq offsets are the specs' positions in the derived order.
        for arm, slot, off in fake.calls:
            self.assertEqual(specs[off], (arm, slot))
        # The summary on disk was regenerated after every run:
        # specs_final seen at call time grows 1,1,2,3.
        self.assertEqual(fake.summary_snapshots, [1, 1, 2, 3])
        b = summary["batch"]
        self.assertTrue(b["complete"])
        self.assertEqual(b["specs_final"], 4)
        with open(os.path.join(self.runs, "batch-summary.json")) as f:
            on_disk = json.load(f)
        self.assertTrue(on_disk["batch"]["complete"])
        # A relaunch is a no-op: everything is final.
        fake2 = FakeBatchRunner({})
        summary2 = batch.run_resumable(
            specs, StubLedger(), runs_dir=self.runs,
            run_batch_fn=fake2, seed=7, runs_per_arm=1)
        self.assertEqual(fake2.calls, [])
        self.assertTrue(summary2["batch"]["complete"])

    def test_infra_twice_across_relaunch_is_exhausted(self):
        specs = batch.derive_specs(7, 1)
        target = specs[0]
        # Launch 1: pass 1 runs all four specs (target infra-fails),
        # then the "VM dies" before the pass-2 re-run.
        script = {s: ["completed"] for s in specs}
        script[target] = ["infra_failed"]
        fake = FakeBatchRunner(script, die_after=4)
        with self.assertRaises(RuntimeError):
            batch.run_resumable(specs, StubLedger(),
                                runs_dir=self.runs, run_batch_fn=fake,
                                seed=7, runs_per_arm=1)
        self.assertEqual(self.state_of(target[0], target[1]), "retry")
        # Launch 2 (relaunch): only the retry spec runs; it
        # infra-fails again -> two infra footers on disk.
        fake2 = FakeBatchRunner({target: ["infra_failed"]})
        batch.run_resumable(specs, StubLedger(), runs_dir=self.runs,
                            run_batch_fn=fake2, seed=7, runs_per_arm=1)
        self.assertEqual([(a, s) for a, s, _o in fake2.calls],
                         [target])
        self.assertEqual(self.state_of(target[0], target[1]),
                         "exhausted")
        # Launch 3: never runs again; the batch reports complete
        # with the spec counted as infra-exhausted.
        fake3 = FakeBatchRunner({})
        summary = batch.run_resumable(
            specs, StubLedger(), runs_dir=self.runs,
            run_batch_fn=fake3, seed=7, runs_per_arm=1)
        self.assertEqual(fake3.calls, [])
        self.assertEqual(summary["batch"]["specs_infra_exhausted"], 1)
        self.assertTrue(summary["batch"]["complete"])


class TestParseShard(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(batch.parse_shard("0/4"), (0, 4))
        self.assertEqual(batch.parse_shard("3/4"), (3, 4))
        self.assertEqual(batch.parse_shard("0/1"), (0, 1))

    def test_invalid(self):
        for bad in ("4/4", "0/0", "-1/4", "1/-2", "x", "1", "1/2/3",
                    "", "a/b"):
            with self.assertRaises(ValueError, msg=bad):
                batch.parse_shard(bad)


class TestShardPartition(unittest.TestCase):
    def test_48_spec_list_partitions_disjoint_and_complete(self):
        specs = batch.derive_specs(20261115, 12)
        self.assertEqual(len(specs), 48)
        shards = [batch.partition_specs(specs, i, 4)
                  for i in range(4)]
        for work in shards:
            self.assertEqual(len(work), 12)
        flat = [(arm, slot) for work in shards
                for _i, arm, slot in work]
        self.assertEqual(len(flat), 48)
        self.assertEqual(len(set(flat)), 48)          # disjoint
        self.assertEqual(set(flat), set(specs))       # complete

    def test_partition_is_index_modulo_with_global_indices(self):
        specs = batch.derive_specs(20261115, 12)
        for i in range(4):
            work = batch.partition_specs(specs, i, 4)
            self.assertEqual([idx for idx, _a, _s in work],
                             list(range(i, 48, 4)))
            self.assertEqual([(a, s) for _i, a, s in work],
                             specs[i::4])

    def test_other_sizes_partition_completely(self):
        specs = batch.derive_specs(20261114, 10)
        for n in (1, 2, 3, 7):
            flat = [(a, s) for i in range(n)
                    for _x, a, s in batch.partition_specs(specs, i, n)]
            self.assertEqual(sorted(flat), sorted(specs))


class TestShardPlan(TempDirCase):
    def test_plan_contains_only_the_shard_subset(self):
        specs = batch.derive_specs(20261115, 12)
        work = batch.partition_specs(specs, 2, 4)
        subset = [(a, s) for _i, a, s in work]
        # A final inside the shard -> skip; a final outside the
        # shard -> not in the plan at all.
        in_arm, in_slot = subset[0]
        out_arm, out_slot = next(s for s in specs
                                 if s not in subset)
        write_run(self.runs, in_arm, in_slot, 1, "completed")
        write_run(self.runs, out_arm, out_slot, 2, "completed")
        plan = batch.plan_batch(subset,
                                batch.scan_footers(self.runs))
        self.assertEqual([(p["arm"], p["slot"]) for p in plan],
                         subset)
        self.assertEqual(plan[0]["action"], "skip")
        self.assertTrue(all(p["action"] == "run" for p in plan[1:]))
        self.assertNotIn((out_arm, out_slot),
                         [(p["arm"], p["slot"]) for p in plan])


class TestShardRunResumable(TempDirCase):
    def test_shard_runs_only_its_subset_summary_stays_global(self):
        specs = batch.derive_specs(7, 2)
        work = batch.partition_specs(specs, 1, 2)
        subset = [(a, s) for _i, a, s in work]
        fake = FakeBatchRunner({s: ["completed"] for s in subset})
        summary = batch.run_resumable(
            specs, StubLedger(), runs_dir=self.runs,
            run_batch_fn=fake, seed=7, runs_per_arm=2,
            only=set(subset))
        called = [(a, s) for a, s, _o in fake.calls]
        self.assertEqual(called, subset)
        # seq offsets are the GLOBAL positions in the derived list.
        for arm, slot, off in fake.calls:
            self.assertEqual(specs[off], (arm, slot))
        b = summary["batch"]
        self.assertEqual(b["specs_total"], len(specs))
        self.assertEqual(b["specs_final"], len(subset))
        self.assertFalse(b["complete"])
        # The other shard's specs were never touched.
        with open(os.path.join(self.runs, "batch-summary.json")) as f:
            on_disk = json.load(f)
        self.assertEqual(on_disk["batch"]["specs_final"],
                         len(subset))


class TestWriteSummary(TempDirCase):
    def test_no_tmp_left_behind_and_content_round_trips(self):
        out = batch.write_summary(self.runs, {"batch": {"x": 1}})
        with open(out) as f:
            self.assertEqual(json.load(f), {"batch": {"x": 1}})
        self.assertEqual([n for n in os.listdir(self.runs)
                          if ".tmp" in n], [])


if __name__ == "__main__":
    unittest.main()
