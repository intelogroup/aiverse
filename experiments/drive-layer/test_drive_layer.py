#!/usr/bin/env python3
"""Unit tests for the drive layer (DRIVE-LAYER-SPEC v1).

Run: python3 -m unittest test_drive_layer -v   (or plain python3)

Covers: depletion/replenishment math, blocked segments costing 0,
regen accrual + cap + the 25-look budget identity, refusal at pool
0, rest rules (credit, cap, full-refusal, closure, away-refusal),
limp-home trigger/exemption/release, band boundaries, the
drives.jsonl event schema, temperament ordering in the block, and
the flag-off byte-identity proof (subprocess, identity_probe.py).
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import drive_layer as DL  # noqa: E402

SOURCES = [{"id": "home-bench", "pos": [-17.0, 51.2], "home": True},
           {"id": "stall-55", "pos": [44.0, 51.2], "home": False}]
COST = 0.5  # round numbers for accounting tests


def mk(cond="B", temperament="neutral", **kw):
    return DL.DriveState(condition=cond, temperament=temperament,
                         energy_cost_per_m=COST, rest_sources=SOURCES,
                         **kw)


class TestEnergyAccounting(unittest.TestCase):
    def test_travel_debits_by_distance(self):
        st = mk()
        st.on_sample(0.0, [0.0, 0.0])
        st.on_sample(1.5, [8.0, 0.0])       # 8 m at 0.5/m (a single
        # sample step >= 10 m is a glitch by the chassis' own guard)
        self.assertAlmostEqual(st.energy, 96.0)
        self.assertAlmostEqual(st.total_distance_m, 8.0)

    def test_blocked_segment_costs_zero(self):
        st = mk()
        st.on_sample(0.0, [3.0, 3.0])
        for i in range(1, 6):               # wedged: same truth pos
            st.on_sample(1.5 * i, [3.0, 3.0])
        self.assertAlmostEqual(st.energy, 100.0)
        self.assertAlmostEqual(st.total_distance_m, 0.0)

    def test_glitch_jump_meters_nothing(self):
        st = mk()
        st.on_sample(0.0, [0.0, 0.0])
        st.on_sample(1.5, [50.0, 0.0])      # 50 m teleport: ignored
        self.assertAlmostEqual(st.energy, 100.0)
        st.on_sample(3.0, [52.0, 0.0])      # real 2 m from new anchor
        self.assertAlmostEqual(st.energy, 99.0)

    def test_energy_floors_at_zero(self):
        st = mk(cond="C")                   # 25 units = 50 m at 0.5/m
        st.on_sample(0.0, [0.0, 0.0])
        for i in range(1, 9):               # 8 x 9 m = 72 m of travel
            st.on_sample(1.5 * i, [9.0 * i, 0.0])
        self.assertEqual(st.energy, 0.0)
        self.assertTrue(st.limp_home())


class TestPerceptionAccounting(unittest.TestCase):
    def test_look_debits_and_refuses_at_zero(self):
        st = mk()
        for i in range(15):
            self.assertTrue(st.try_fire_look(10.0 + i))
        self.assertEqual(st.perception, 0)
        self.assertFalse(st.try_fire_look(30.0))
        self.assertEqual(st.looks_refused, 1)

    def test_regen_accrual_and_cap(self):
        st = mk()
        for i in range(15):
            st.try_fire_look(0.0)
        self.assertEqual(st.perception_available(239.0), 0)
        self.assertEqual(st.perception_available(240.0), 1)
        self.assertEqual(st.perception_available(480.0), 2)
        # cap: a full pool does not bank ticks
        st2 = mk()
        st2.perception = 20
        st2.settle_regen(100000.0)
        self.assertEqual(st2.perception, 20)

    def test_budget_identity_25_over_2400(self):
        # spec §1b: endowment 15 + regen over the 2,400 s sim budget
        # = exactly the gauntlet's 25-look budget
        st = mk()
        fired = 0
        t = 0.0
        while t <= 2400.0:
            if st.try_fire_look(t):
                fired += 1
            t += 1.0
        self.assertEqual(fired, 25)


class TestRest(unittest.TestCase):
    def test_rest_credits_and_caps(self):
        st = mk(cond="C")
        st.energy = 90.0
        self.assertIsNone(st.rest_refusal(0.0, [-17.0, 51.2]))
        st.apply_rest(10.0, [-17.0, 51.2])
        self.assertAlmostEqual(st.energy, 94.0)
        st.apply_rest(20.0, [-17.0, 51.2])
        st.apply_rest(30.0, [-17.0, 51.2])   # capped at 100
        self.assertAlmostEqual(st.energy, 100.0)
        self.assertEqual(st.rest_steps, 3)

    def test_rest_refused_at_full(self):
        st = mk()
        self.assertIn("full", st.rest_refusal(0.0, [-17.0, 51.2]))
        with self.assertRaises(ValueError):
            st.apply_rest(10.0, [-17.0, 51.2])

    def test_rest_refused_away_from_source(self):
        st = mk(cond="C")
        self.assertIn("not at a rest source",
                      st.rest_refusal(0.0, [0.0, 0.0]))

    def test_rest_refused_at_r1_during_closure_only(self):
        st = mk(cond="C")
        self.assertIn("closed", st.rest_refusal(900.0, [-17.0, 51.2]))
        self.assertIsNone(st.rest_refusal(900.0, [44.0, 51.2]))  # R2 open
        self.assertIsNone(st.rest_refusal(599.0, [-17.0, 51.2]))
        self.assertIsNone(st.rest_refusal(1200.0, [-17.0, 51.2]))


class TestLimpHome(unittest.TestCase):
    def drained(self):
        st = mk(cond="C")
        st.on_sample(0.0, [0.0, 0.0])
        for i in range(1, 7):               # 54 m > 50 m of range
            st.on_sample(1.5 * i, [9.0 * i, 0.0])
        assert st.limp_home()
        return st

    def test_gate_blocks_world_targets(self):
        st = self.drained()
        pos = [54.0, 0.0]
        self.assertIsNotNone(st.gate_refusal(10.0, pos, [0.0, -40.0]))

    def test_gate_exempts_only_nearest_source(self):
        st = self.drained()
        pos = [54.0, 0.0]                   # nearest source: stall-55
        self.assertIsNone(st.gate_refusal(10.0, pos, [44.0, 51.2]))
        self.assertIsNotNone(st.gate_refusal(10.0, pos, [-17.0, 51.2]))

    def test_no_gate_above_zero(self):
        st = mk(cond="C")                   # 25 units, untouched
        self.assertIsNone(st.gate_refusal(0.0, [0.0, 0.0], [99.0, 99.0]))

    def test_limp_releases_after_rest(self):
        st = self.drained()
        st.on_sample(20.0, [44.0, 51.2])    # (glitch-guarded hop; the
        # state only needs position for the rest check below)
        st._last_pos = [44.0, 51.2]
        st.apply_rest(30.0, [44.0, 51.2])
        self.assertFalse(st.limp_home())
        self.assertAlmostEqual(st.energy, 4.0)
        causes = [e["cause"] for e in st.events]
        self.assertIn("limp-home-on", causes)
        self.assertIn("limp-home-off", causes)


class TestBands(unittest.TestCase):
    def test_energy_bands(self):
        for lvl, want in [(100, "satiated"), (80, "satiated"),
                          (79.9, "adequate"), (30, "adequate"),
                          (29.9, "hungry"), (10, "hungry"),
                          (9.9, "critical"), (0, "critical")]:
            self.assertEqual(DL.energy_band(lvl), want, lvl)

    def test_perception_bands(self):
        for lvl, want in [(20, "satiated"), (12, "satiated"),
                          (11, "adequate"), (6, "adequate"),
                          (5, "hungry"), (3, "hungry"),
                          (2, "critical"), (0, "critical")]:
            self.assertEqual(DL.perception_band(lvl), want, lvl)


class TestEventLog(unittest.TestCase):
    def test_schema_and_file_emission(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "drives.jsonl"
            st = mk(log_path=p)
            st.on_sample(0.0, [0.0, 0.0])
            st.on_sample(1.5, [4.0, 0.0])
            st.try_fire_look(2.0)
            rows = [json.loads(x) for x in p.read_text().splitlines()]
            self.assertEqual(len(rows), len(st.events))
            for r in rows:
                self.assertEqual(set(r), {"t_sim", "var", "delta",
                                          "cause", "level_after"})
            trav = [r for r in rows if r["cause"] == "travel"]
            self.assertEqual(trav[0]["delta"], -2.0)
            self.assertEqual(trav[0]["level_after"], 98.0)
            look = [r for r in rows if r["cause"] == "look"]
            self.assertEqual(look[0]["var"], "perception")
            st._logf.close()


class TestBlock(unittest.TestCase):
    def test_temperament_flips_order_and_line(self):
        e_first = mk(temperament="ENERGY_FIRST").block_text(0.0, [0, 0])
        p_first = mk(temperament="PERCEPTION_FIRST").block_text(0.0,
                                                                [0, 0])
        self.assertLess(e_first.index("ENERGY 100"),
                        e_first.index("PERCEPTION 15"))
        self.assertLess(p_first.index("PERCEPTION 15"),
                        p_first.index("ENERGY 100"))
        self.assertIn("ENERGY first", e_first)
        self.assertIn("PERCEPTION first", p_first)
        standing = ("When more than one need is hungry, attend to the "
                    "first-listed first.")
        self.assertIn(standing, e_first)
        self.assertIn(standing, p_first)

    def test_block_states_laws_sources_closure(self):
        st = mk(cond="C")
        txt = st.block_text(900.0, [-17.0, 51.2])   # inside closure
        self.assertIn("home bench is CLOSED from t=600 to t=1200", txt)
        self.assertIn("HOME BENCH IS CLOSED NOW", txt)
        self.assertIn("stall-55", txt)
        self.assertIn('"type": "rest"', txt)
        st2 = mk(cond="C")
        st2.energy = 0.0
        self.assertIn("LIMP-HOME ACTIVE",
                      st2.block_text(0.0, [0.0, 0.0]))

    def test_endowments(self):
        self.assertEqual(mk("B").energy, 100.0)
        self.assertEqual(mk("C").energy, 25.0)
        self.assertEqual(mk("B").perception, 15)
        self.assertEqual(mk("C").perception, 15)   # §3: differs in
        # ENERGY endowment only


class TestFlagOffIdentity(unittest.TestCase):
    """The spec's hard requirement, as a test: with the flag off, the
    digest bytes and the validated plan for a fixed snapshot equal
    the UNMODIFIED runner's, byte for byte; no seam is patched."""

    def _probe(self, mode, out):
        r = subprocess.run(
            [sys.executable, str(HERE / "identity_probe.py"), mode,
             str(out)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr[-2000:])

    def test_off_is_byte_identical(self):
        with tempfile.TemporaryDirectory() as td:
            for m in ("pristine", "off", "on"):
                self._probe(m, Path(td) / m)
            for name in ("digest.txt", "plan.json"):
                self.assertEqual((Path(td) / "pristine" / name)
                                 .read_bytes(),
                                 (Path(td) / "off" / name).read_bytes(),
                                 f"{name} differs with flag off")
            seams = json.loads((Path(td) / "off" / "seams.json")
                               .read_text())
            self.assertTrue(all(seams.values()), seams)
            # and flag ON must actually change both surfaces: the plan
            # gains exactly the rest step, the digest exactly the block
            on_plan = json.loads((Path(td) / "on" / "plan.json")
                                 .read_text())
            off_plan = json.loads((Path(td) / "off" / "plan.json")
                                  .read_text())
            self.assertEqual([s for s in on_plan if s["type"] != "rest"],
                             off_plan)
            self.assertIn({"type": "rest"}, on_plan)
            self.assertGreater(
                len((Path(td) / "on" / "digest.txt").read_bytes()),
                len((Path(td) / "off" / "digest.txt").read_bytes()))


class TestSupervisorIdentity(unittest.TestCase):
    """Level 2 of the identity proof: the drive supervisor's briefing
    composition vs the GAUNTLET supervisor's own digest_patched —
    extracted from gauntlet_runner.py by AST and executed with stubs,
    so the reference is the original code, not a re-typing of it."""

    def _gauntlet_digest_fn(self, stage):
        import ast
        src = (Path.home() / "workspace/.build-tmp/experiments"
               / "gauntlet/gauntlet_runner.py").read_text()
        tree = ast.parse(src)
        segs = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name in (
                    "digest_patched", "current_objective"):
                segs[node.name] = ast.get_source_segment(src, node)
            if isinstance(node, ast.Assign) and getattr(
                    node.targets[0], "id", "") == "OBJ":
                segs["OBJ"] = ast.get_source_segment(src, node)
        sealed = json.loads(
            (Path.home() / "workspace/.build-tmp/experiments/gauntlet"
             / "prep/ground_truth_gauntlet.json").read_text())
        ns = {"LOOK_CAP": sealed["budgets"]["look_cap"],
              "STAGE": stage,
              "S1_PLACE": sealed["stages"]["S1"]["place"],
              "S1_STAND": sealed["stages"]["S1"]["stand"],
              "S2_DESIGNATED": sealed["stages"]["S2"]["designated_egg"],
              "SPAWN_A": sealed["spawn_a"],
              "orig_digest": lambda self, snap: "D-STANDARD"}
        exec(segs["OBJ"], ns)
        exec(segs["current_objective"], ns)
        exec(segs["digest_patched"], ns)
        return ns["digest_patched"]

    def test_supervisor_briefing_byte_identical(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "drive_runner", HERE / "drive_runner.py")
        dr = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(dr)
        snap = {"pos": [-20.0, 1.62, 44.0], "t": 100.0}
        for stage in (
                {"S1": None, "S2": None, "S3": None, "return": None,
                 "looks_used": 7},
                {"S1": {"t_sim": 9.7}, "S2": None, "S3": None,
                 "return": None, "looks_used": 25}):
            ref_fn = self._gauntlet_digest_fn(stage)

            class FakeSelf:
                key = "A"
            reference = ref_fn(FakeSelf(), snap)
            mine = dr.compose_briefing("D-STANDARD", snap, stage, None)
            self.assertEqual(reference, mine)
            # flag ON: identical except the LOOKS line and the block
            st = mk()
            on = dr.compose_briefing("D-STANDARD", snap, stage, st)
            block = st.block_text(100.0, [-20.0, 44.0])
            rebuilt = mine.replace(
                f"LOOKS LEFT: {25 - stage['looks_used']}/25 — every "
                "look costs real time; spend looks where they decide "
                "something.\n",
                "LOOKS: no fixed count — your PERCEPTION pool is the "
                "budget (see YOUR BODY below).\n").replace(
                "=== your standard briefing follows ===\n",
                "=== your standard briefing follows ===\n"
                + block + "\n\n")
            self.assertEqual(on, rebuilt)


if __name__ == "__main__":
    unittest.main(verbosity=2)
