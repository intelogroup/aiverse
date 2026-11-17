#!/usr/bin/env python3
"""Offline tests for harness/enforce.py — plan §4 arm B2 thresholds."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "harness"))
from channels import BodyState
from enforce import enforce


class TestDowngrade(unittest.TestCase):
    def test_run_downgraded_at_energy_14(self):
        out, events = enforce({"type": "run_to", "place": "tea"},
                              BodyState(energy=14))
        self.assertEqual(out["type"], "go_to")
        self.assertEqual(out["place"], "tea")  # other fields preserved
        self.assertEqual(events[0]["kind"], "downgrade")
        self.assertIn("too depleted to run", events[0]["reason"])

    def test_run_passes_at_energy_15(self):
        out, events = enforce({"type": "run_to", "place": "tea"},
                              BodyState(energy=15))
        self.assertEqual(out, {"type": "run_to", "place": "tea"})
        self.assertEqual(events, [])

    def test_input_intent_never_mutated(self):
        intent = {"type": "run_to", "place": "tea"}
        enforce(intent, BodyState(energy=3))
        self.assertEqual(intent, {"type": "run_to", "place": "tea"})


class TestDepletedLock(unittest.TestCase):
    def _locked(self):
        s = BodyState(energy=4)
        s.apply({"type": "run_to"}, outcome="ok")  # -> 0, lock set
        assert s.depleted_lock
        return s

    def test_movement_refused_at_zero(self):
        s = self._locked()
        for itype in ("go_to", "run_to"):
            out, events = enforce({"type": itype, "place": "tea"}, s)
            self.assertEqual(out["type"], "refused")
            self.assertEqual(events[0]["kind"], "refusal")

    def test_rest_always_allowed_at_zero(self):
        out, events = enforce({"type": "rest"}, self._locked())
        self.assertEqual(out["type"], "rest")
        self.assertEqual(events, [])

    def test_non_movement_passes_at_zero(self):
        out, _ = enforce({"type": "look"}, self._locked())
        self.assertEqual(out["type"], "look")

    def test_lock_persists_until_30(self):
        s = self._locked()
        s.apply({"type": "rest"}, outcome="ok", at_rest_point=True)  # 8
        out, _ = enforce({"type": "go_to", "place": "tea"}, s)
        self.assertEqual(out["type"], "refused")   # 8 < 30: still locked
        for _ in range(3):
            s.apply({"type": "rest"}, outcome="ok", at_rest_point=True)
        self.assertEqual(s.energy, 32)
        out, _ = enforce({"type": "go_to", "place": "tea"}, s)
        self.assertEqual(out["type"], "go_to")     # recovered: passes


class TestFumble(unittest.TestCase):
    def test_fumble_flagged_at_strain_70_once(self):
        s = BodyState(strain=70)
        out, events = enforce({"type": "interact", "target": "radio"}, s)
        self.assertEqual(out["type"], "interact")  # intent passes; result fumbles
        self.assertEqual([e["kind"] for e in events], ["fumble"])
        _, events2 = enforce({"type": "interact", "target": "radio"}, s)
        self.assertEqual(events2, [])              # once per strain episode

    def test_no_fumble_at_strain_69(self):
        _, events = enforce({"type": "interact"}, BodyState(strain=69))
        self.assertEqual(events, [])

    def test_fumble_rearms_after_strain_decays(self):
        s = BodyState(strain=70)
        enforce({"type": "interact"}, s)
        for _ in range(4):                          # strain 70 -> 58 via decay
            s.apply({"type": "observe"}, outcome="ok")
        self.assertLess(s.strain, 70)
        self.assertFalse(s.fumble_used)


class TestPassThrough(unittest.TestCase):
    def test_below_thresholds_intent_unchanged(self):
        intent = {"type": "go_to", "place": "tea"}
        out, events = enforce(intent, BodyState(energy=80, strain=10))
        self.assertEqual(out, intent)
        self.assertEqual(events, [])


if __name__ == "__main__":
    unittest.main()
