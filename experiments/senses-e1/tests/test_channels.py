#!/usr/bin/env python3
"""Offline tests for harness/channels.py — plan §3, §4, §5, §6."""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "harness"))
from channels import (BodyState, SelfSignalSource, ShamBodyRenderer,
                      TimeChannel, render_a0, render_a1, render_a2, render_a3,
                      render_body_hidden, render_body_permuted,
                      render_body_shown, render_self_signal)


class TestTimeArms(unittest.TestCase):
    def test_a0_renders_nothing(self):
        self.assertEqual(render_a0(3, 60, 360, 2, 24), "")
        self.assertEqual(TimeChannel("A0").render(tick=9, elapsed_s=300), "")

    def test_a1_tick_count_only(self):
        self.assertEqual(render_a1(7, 0, 360, 0, 24), "tick: 7")
        self.assertEqual(TimeChannel("A1").render(tick=12), "tick: 12")

    def test_a2_clock_format(self):
        # 151s elapsed of a 360s deadline -> 209s = 03:29 remaining.
        self.assertEqual(render_a2(0, 151, 360, 0, 24),
                         "elapsed 02:31 · remaining 03:29")
        ch = TimeChannel("A2", deadline_s=360)
        self.assertEqual(ch.render(tick=1, elapsed_s=0),
                         "elapsed 00:00 · remaining 06:00")

    def test_a2_remaining_clamps_at_zero(self):
        self.assertEqual(render_a2(0, 999, 360, 0, 24),
                         "elapsed 16:39 · remaining 00:00")

    def test_a3_action_budget_decrements(self):
        self.assertEqual(render_a3(0, 0, 360, 0, 24), "actions remaining: 24")
        self.assertEqual(render_a3(0, 0, 360, 9, 24), "actions remaining: 15")
        self.assertEqual(render_a3(0, 0, 360, 30, 24), "actions remaining: 0")

    def test_unknown_arm_rejected(self):
        with self.assertRaises(ValueError):
            TimeChannel("A9")


class TestBodyStateRules(unittest.TestCase):
    """Plan §4 numbers, exactly."""

    def test_drains(self):
        for itype, want in (("run_to", 94), ("go_to", 98),
                            ("interact", 99), ("look", 99)):
            s = BodyState()
            s.apply({"type": itype}, outcome="ok")
            self.assertEqual(s.energy, want, itype)

    def test_other_intents_cost_nothing(self):
        s = BodyState()
        s.apply({"type": "observe"}, outcome="ok")
        self.assertEqual(s.energy, 100)

    def test_rest_refills(self):
        s = BodyState(energy=50)
        s.apply({"type": "rest"}, outcome="ok", at_rest_point=True)
        self.assertEqual(s.energy, 58)          # +8 at a rest point
        s = BodyState(energy=50)
        s.apply({"type": "rest"}, outcome="ok", at_rest_point=False)
        self.assertEqual(s.energy, 51)          # +1 idle elsewhere

    def test_energy_clamps(self):
        s = BodyState(energy=98)
        s.apply({"type": "rest"}, outcome="ok", at_rest_point=True)
        self.assertEqual(s.energy, 100)
        s = BodyState(energy=3)
        s.apply({"type": "run_to"}, outcome="ok")
        self.assertEqual(s.energy, 0)

    def test_strain_failed_and_decay(self):
        s = BodyState()
        s.apply({"type": "go_to"}, outcome="failed")
        self.assertEqual(s.strain, 15)          # +15, decay floored at 0 first
        s.apply({"type": "observe"}, outcome="ok")
        self.assertEqual(s.strain, 12)          # -3 decay per turn

    def test_strain_refusals(self):
        s = BodyState()
        s.apply({"type": "go_to"}, outcome="refused")
        self.assertEqual((s.energy, s.strain), (100, 15))  # no drain on refusal
        s = BodyState()
        s.apply({"type": "go_to"}, outcome="collision_refusal")
        self.assertEqual((s.energy, s.strain), (100, 5))   # +5 variant

    def test_depleted_lock_lifecycle(self):
        s = BodyState(energy=4)
        s.apply({"type": "run_to"}, outcome="ok")   # 4 - 6 -> 0, lock sets
        self.assertEqual(s.energy, 0)
        self.assertTrue(s.depleted_lock)
        s.apply({"type": "rest"}, outcome="ok", at_rest_point=True)
        self.assertEqual(s.energy, 8)
        self.assertTrue(s.depleted_lock)            # still locked below 30
        for _ in range(3):
            s.apply({"type": "rest"}, outcome="ok", at_rest_point=True)
        self.assertEqual(s.energy, 32)
        self.assertFalse(s.depleted_lock)           # cleared at >= 30

    def test_context_pressure_clamped_and_rendered(self):
        s = BodyState()
        s.set_context_pressure(0.34)
        self.assertAlmostEqual(s.context_pressure, 0.34)
        s.set_context_pressure(1.7)
        self.assertEqual(s.context_pressure, 1.0)


class TestBodyRenderers(unittest.TestCase):
    def _state(self):
        s = BodyState(energy=62, strain=10)
        s.set_context_pressure(0.34)
        return s

    def test_shown_exact_format(self):
        self.assertEqual(render_body_shown(self._state()),
                         "body: energy 62 · strain 10 · context 34%")

    def test_hidden_renders_nothing(self):
        self.assertEqual(render_body_hidden(self._state()), "")

    def test_permuted_swaps_labels(self):
        self.assertEqual(render_body_permuted(self._state()),
                         "body: energy 10 · strain 62 · context 34%")


def _pearson(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    vx = sum((x - mx) ** 2 for x in xs)
    vy = sum((y - my) ** 2 for y in ys)
    return cov / (vx * vy) ** 0.5 if vx and vy else 0.0


class TestShamRenderer(unittest.TestCase):
    def test_seeded_reproducible_and_seed_sensitive(self):
        a = [ShamBodyRenderer(seed=7).render() for _ in range(1)]
        r1, r2 = ShamBodyRenderer(seed=7), ShamBodyRenderer(seed=7)
        self.assertEqual([r1.render() for _ in range(10)],
                         [r2.render() for _ in range(10)])
        r3 = ShamBodyRenderer(seed=8)
        self.assertNotEqual([r1.render() for _ in range(5)],
                            [r3.render() for _ in range(5)])
        self.assertTrue(a)

    def test_uncorrelated_with_true_state(self):
        # True state: agent runs every turn (steady drain to the floor).
        true = BodyState()
        true_series = []
        for _ in range(60):
            true.apply({"type": "run_to"}, outcome="ok")
            true_series.append(true.energy)
        sham = ShamBodyRenderer(seed=28)  # seed pinned: r = 0.017 when chosen
        shown_series = []
        for _ in range(60):
            txt = sham.render(true)
            shown_series.append(int(re.search(r"energy (\d+)", txt).group(1)))
        self.assertLess(abs(_pearson(shown_series, true_series)), 0.3)
        # And the sham plainly is not tracking the true values.
        self.assertNotEqual(shown_series, true_series)


class TestSelfSignalStub(unittest.TestCase):
    def test_stub_interface_only(self):
        with self.assertRaises(NotImplementedError):
            SelfSignalSource().sample({})
        self.assertEqual(render_self_signal(None, {}), "")


if __name__ == "__main__":
    unittest.main()
