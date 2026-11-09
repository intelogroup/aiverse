#!/usr/bin/env python3
"""Unit tests for checkpoint.py — snapshot integrity, rotation,
fallback, the interruption record, the sim-time offset wrapper, and
the full payload roundtrip (subprocess probe, checkpoint_probe.py).

Run: python3 -m unittest test_checkpoint -v   (or plain python3)
"""
import asyncio
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import checkpoint as CK  # noqa: E402


def payload(marker=0):
    return {"stage": {"looks_used": marker}, "agent_a": {},
            "blackboard": {"sightings": [], "intentions": {},
                           "claims": {}},
            "call_stats": {}, "pos": {"A": None, "B": None},
            "sim_t": float(marker), "drive": None, "artifacts": {},
            "interruptions": []}


class TestManager(unittest.TestCase):
    def test_rotation_and_latest(self):
        with tempfile.TemporaryDirectory() as td:
            m = CK.CheckpointManager(td, "gauntlet-9")
            m.save(payload(1), 1.0)
            m.save(payload(2), 2.0)
            m.save(payload(3), 3.0)
            env, src, _ = m.load_latest()
            self.assertEqual(env["seq"], 3)
            self.assertEqual(src, "checkpoint.json")
            prev = json.loads((Path(td) / "checkpoint.prev.json")
                              .read_text())
            self.assertEqual(prev["seq"], 2)

    def test_torn_newest_falls_back(self):
        with tempfile.TemporaryDirectory() as td:
            m = CK.CheckpointManager(td, "gauntlet-9")
            m.save(payload(1), 1.0)
            m.save(payload(2), 2.0)
            p = Path(td) / "checkpoint.json"
            p.write_text(p.read_text()[:50])   # torn mid-write shape
            env, src, problems = m.load_latest()
            self.assertEqual(env["seq"], 1)
            self.assertEqual(src, "checkpoint.prev.json")
            self.assertTrue(problems)

    def test_tampered_checksum_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            m = CK.CheckpointManager(td, "gauntlet-9")
            m.save(payload(1), 1.0)
            p = Path(td) / "checkpoint.json"
            env = json.loads(p.read_text())
            env["payload"]["stage"]["looks_used"] = 999  # silent edit
            p.write_text(json.dumps(env))
            got, _, _ = m.load_latest()
            self.assertIsNone(got)

    def test_wrong_run_and_garbage_never_load(self):
        with tempfile.TemporaryDirectory() as td:
            m = CK.CheckpointManager(td, "gauntlet-9")
            m.save(payload(1), 1.0)
            other = CK.CheckpointManager(td, "gauntlet-8")
            got, _, problems = other.load_latest()
            self.assertIsNone(got)
            (Path(td) / "checkpoint.json").write_text("not json {{")
            (Path(td) / "checkpoint.prev.json").write_text("][")
            got, _, _ = m.load_latest()
            self.assertIsNone(got)

    def test_note_resume_writes_disclosure(self):
        with tempfile.TemporaryDirectory() as td:
            m = CK.CheckpointManager(td, "drive-b9")
            m.save(payload(7), 7.0)
            env, _, _ = m.load_latest()
            recs = m.note_resume(env, killed_leg_last_t_sim=19.5)
            self.assertEqual(len(recs), 1)
            r = recs[0]
            self.assertEqual(r["resumed_from_seq"], 1)
            self.assertEqual(r["snapshot_t_sim"], 7.0)
            self.assertEqual(r["rewound_sim_s"], 12.5)
            on_disk = json.loads(
                (Path(td) / "interruptions.json").read_text())
            self.assertEqual(on_disk, recs)
            # a second resume appends, never overwrites
            m.save(payload(8), 8.0)
            env, _, _ = m.load_latest()
            recs = m.note_resume(env)
            self.assertEqual(len(recs), 2)
            self.assertIsNone(recs[1]["rewound_sim_s"])


class _FakeAgent:
    def __init__(self):
        self._t = 5.0

    async def snapshot(self):
        self._t += 1.5
        return {"t": self._t, "pos": [0.0, 1.6, 0.0]}

    async def act(self, action, timeout_s=100):
        return {"ok": True,
                "snapshot": {"t": self._t, "pos": [1.0, 1.6, 0.0]}}


class _FakeV2:
    Agent = _FakeAgent


class TestTimeOffset(unittest.TestCase):
    def test_offset_makes_page_time_continuous(self):
        ctx = CK.install_time_offset(_FakeV2, target_t_sim=321.5)
        ag = _FakeAgent()

        async def go():
            s1 = await ag.snapshot()       # page t 6.5 -> fixes offset
            s2 = await ag.snapshot()       # page t 8.0
            r = await ag.act({"type": "run_to"})
            return s1, s2, r
        s1, s2, r = asyncio.run(go())
        self.assertAlmostEqual(ctx["offset"], 315.0)
        self.assertAlmostEqual(s1["t"], 321.5)
        self.assertAlmostEqual(s2["t"], 323.0)
        self.assertAlmostEqual(r["snapshot"]["t"], 323.0)


class TestProbe(unittest.TestCase):
    def test_payload_roundtrip(self):
        r = subprocess.run(
            [sys.executable, str(HERE / "checkpoint_probe.py")],
            capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr[-3000:])
        line = [x for x in r.stdout.splitlines()
                if x.startswith("PROBE-OK")]
        self.assertTrue(line, r.stdout[-1000:])
        v = json.loads(line[0][len("PROBE-OK "):])
        self.assertTrue(v["agent_restored"])
        self.assertTrue(v["shared_restored"])
        self.assertTrue(v["drive_restored"])
        self.assertEqual(v["loaded_seq"], v["saved_seq"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
