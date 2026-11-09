#!/usr/bin/env python3
"""Unit tests for score_drive.py — synthetic-fixture runs with known
ground truth per prediction, a resumed-twin equivalence check, and
the fail-loud INSUFFICIENT DATA path against a real gauntlet
baseline (condition A: no drives.jsonl by design).

Run: python3 -m unittest test_score_drive -v   (or plain python3)
"""
import json
import math
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import score_drive as SD  # noqa: E402

R1 = {"id": "home-bench", "pos": [-17.0, 51.2], "home": True}
R2 = {"id": "stall-55", "pos": [44.0, 51.2], "home": False}
VIS_EGG = next(e for e in sorted(SD.GT)
               if SD.GT[e]["class"] == "visual-only")
VIS_POS = SD.GT[VIS_EGG]["pos"]
DESIG_POS = SD.GT[SD.S2_DESIGNATED]["pos"]


def wjsonl(path, rows):
    Path(path).write_text("".join(json.dumps(r) + "\n" for r in rows))


def interp_track(waypoints, step=10.0):
    """[(t, x, z)] linear between (t, x, z) waypoints, every step s."""
    out = []
    for (t0, x0, z0), (t1, x1, z1) in zip(waypoints, waypoints[1:]):
        t = t0
        while t < t1:
            u = (t - t0) / (t1 - t0)
            out.append((t, x0 + u * (x1 - x0), z0 + u * (z1 - z0)))
            t += step
    out.append(waypoints[-1])
    return out


def write_run(d, track, trace=None, drives=None, stages=None,
              temperament="neutral", summary=None, extra_trace=None):
    d = Path(d)
    d.mkdir(parents=True, exist_ok=True)
    wjsonl(d / "truth.jsonl",
           [{"t_wall": "00:00:00", "t_sim": t, "a": [x, 0.2, z],
             "b": [-17, 0.2, -51.2], "collected_A": [],
             "collected_B": []} for t, x, z in track])
    wjsonl(d / "trace.jsonl", trace or [])
    wjsonl(d / "drives.jsonl", drives or [])
    receipt = {"run_id": d.name, "stages": stages or {},
               "drive_layer": {
                   "enabled": True, "temperament": temperament,
                   "endowments": {"energy": 100.0, "perception": 15},
                   "rest_sources": [R1, R2]}}
    (d / "gauntlet.json").write_text(json.dumps(receipt, indent=1))
    (d / "stages.json").write_text(json.dumps(stages or {}, indent=1))
    (d / "summary.json").write_text(json.dumps(summary or {
        "agents": {"A": {"sectors_covered": ["S4,6", "S5,6"],
                         "stats": {"visual_only": []}}}}, indent=1))
    return d


def sighting_row(t, est, matched, conf):
    return {"kind": "look-recall", "agent": "A", "t_sim": float(t),
            "reported": [{"est": list(est), "matched": matched,
                          "match_err_m": None, "confidence": conf}],
            "in_view_visual": [], "in_view_published": []}


def look_row(t):
    return {"kind": "look-recall", "agent": "A", "t_sim": float(t),
            "reported": [], "in_view_visual": [],
            "in_view_published": []}


def drow(t, var, delta, cause, after):
    return {"t_sim": float(t), "var": var, "delta": delta,
            "cause": cause, "level_after": after}


# ---------------------------------------------------------------------------
# P1 fixture: two pooled runs. Satiated: pursues only tight sightings.
# Deprived: pursues sloppy ones too, and its high-confidence chases go
# wrong 5x as often.

def build_p1_run(d, thin=False):
    track = []
    t = 0.0
    while t <= 400:                      # east along z=0, 0.5 m/s
        track.append((t, -100 + 0.5 * t, 0.0))
        t += 10.0
    t = 410.0
    while t <= 990:                      # back west, slower
        track.append((t, 100 - 0.34 * (t - 410.0), 0.0))
        t += 10.0
    trace = [{"kind": "model", "primary": "agnes-2.5-flash"}]
    # --- satiated phase captures (t < 500)
    caps = list(range(20, 400, 20)) if not thin else [60, 140, 220, 300]
    for i, tc in enumerate(caps):
        xc = -100 + 0.5 * tc
        trace.append(sighting_row(tc, [xc + 10, 0.0], "egg-bazaar-04",
                                  "high" if i < 10 else "low"))
    if not thin:
        # one high-confidence phantom ON the path (the agent reaches
        # x=100 at t=400, inside the pursuit window): committed, wrong
        trace.append(sighting_row(380, [100.0, 0.0], None, "high"))
        for tc in range(30, 400, 40):    # far off-path: never pursued
            xc = -100 + 0.5 * tc
            trace.append(sighting_row(tc, [xc + 30, 45.0], None, "low"))
    # --- deprived phase captures (drives row at t=500 -> E=20)
    caps2 = list(range(420, 990, 20)) if not thin else [500, 580, 660]
    for i, tc in enumerate(caps2):
        xc = 100 - 0.34 * (tc - 410.0)
        if i < 5:
            trace.append(sighting_row(tc, [xc - 20, 0.0],
                                      "egg-bazaar-04", "high"))
        elif i < 10:
            trace.append(sighting_row(tc, [xc - 15, 0.0], None,
                                      "high"))   # committed phantoms
        elif i < 19:
            trace.append(sighting_row(tc, [xc - 10, 0.0],
                                      "egg-bazaar-04", "low"))
        elif i < 25:
            trace.append(sighting_row(tc, [xc - 60, 80.0], None, "low"))
    drives = [drow(500, "energy", -80, "travel", 20.0)]
    stages = {"S1": {"t_sim": 60.0}, "S2": None, "S3": None,
              "return": None, "looks_used": 25}
    return write_run(d, track, trace=trace, drives=drives,
                     stages=stages)


class TestP1(unittest.TestCase):
    def test_p1_confirmed(self):
        with tempfile.TemporaryDirectory() as td:
            b = build_p1_run(Path(td) / "fx-p1-b")
            c = build_p1_run(Path(td) / "fx-p1-c", thin=True)
            out = SD.score_p1([SD.RunData(b), SD.RunData(c)])
            self.assertEqual(out["verdict"], "CONFIRMED", out)
            self.assertGreaterEqual(out["sigma_star_ratio"], 1.25)
            self.assertGreaterEqual(out["confident_wrong_ratio"], 2.0)
            self.assertGreaterEqual(
                out["pursued_per_window"]["satiated"], 15)
            self.assertGreaterEqual(
                out["pursued_per_window"]["deprived"], 15)


# ---------------------------------------------------------------------------
# P2 fixture: two mid-task detour-rests (S2 via R2, S3 via R1) plus one
# limp-home compulsion rest. The resumed twin must score identically.

def build_p2_run(d, resumed_twin=False):
    ex, ez = VIS_POS
    track = interp_track([
        (0, -17, 51.2), (50, -35, 51.2), (100, -32, 62),
        (180, -17, 51.2), (260, -20, 58), (300, -10, 57),
        (390, 44, 51.2), (700, DESIG_POS[0], DESIG_POS[1]),
        (760, 0, 20), (900, ex * 0.5, ez * 0.5),
        (1100, ex, ez + 30), (1250, -17, 51.2),
        (1500, ex, ez), (1600, ex, ez)])
    trace = [{"kind": "COLLECT", "agent": "A", "egg": SD.S2_DESIGNATED,
              "t_sim": 700.0, "via": "registry"},
             {"kind": "COLLECT", "agent": "A", "egg": VIS_EGG,
              "t_sim": 1500.0, "via": "sighting"}]
    drives = [drow(185, "energy", 0, "limp-home-on", 0.0)]
    for i, t in enumerate(range(200, 300, 10)):   # the compulsion rest
        drives.append(drow(t, "energy", 4, "rest", 4.0 * (i + 1)))
    drives.append(drow(295, "energy", 0, "limp-home-off", 40.0))
    drives.append(drow(400, "energy", 4, "rest", 44.0))   # detour 1 @R2
    drives.append(drow(410, "energy", 4, "rest", 48.0))
    if resumed_twin:  # checkpoint seam after detour 1: state unchanged
        drives.append(drow(390, "energy", 0, "checkpoint-restore", 48.0))
        drives.append(drow(390, "perception", 0, "checkpoint-restore",
                           15))
    drives.append(drow(1260, "energy", 4, "rest", 60.0))  # detour 2 @R1
    drives.append(drow(1270, "energy", 4, "rest", 64.0))
    stages = {"S1": {"t_sim": 50.0},
              "S2": {"t_sim": 700.0, "egg": SD.S2_DESIGNATED},
              "S3": {"t_sim": 1500.0, "egg": VIS_EGG},
              "return": None, "looks_used": 9}
    write_run(d, track, trace=trace, drives=drives, stages=stages)
    if resumed_twin:
        (Path(d) / "interruptions.json").write_text(json.dumps([{
            "resumed_from_seq": 5, "snapshot_t_sim": 390.0,
            "snapshot_written_wall_iso": "2026-11-09T17:00:00+00:00",
            "resumed_wall_iso": "2026-11-09T17:20:00+00:00",
            "gap_wall_s": 1200.0, "killed_leg_last_t_sim": 402.0,
            "rewound_sim_s": 12.0}]))
    return d


class TestP2(unittest.TestCase):
    def test_p2_confirmed_with_compulsion_separated(self):
        with tempfile.TemporaryDirectory() as td:
            d = build_p2_run(Path(td) / "fx-p2")
            out = SD.score_p2([SD.RunData(d)])
            self.assertEqual(out["verdict"], "CONFIRMED", out)
            self.assertEqual(out["counts"].get("detour"), 2)
            self.assertEqual(out["counts"].get("compulsion"), 1)

    def test_resumed_twin_scores_identically(self):
        with tempfile.TemporaryDirectory() as td:
            a = SD.RunData(build_p2_run(Path(td) / "fx-p2"))
            b = SD.RunData(build_p2_run(Path(td) / "fx-p2r",
                                        resumed_twin=True))
            self.assertTrue(b.resumed)
            self.assertEqual(len(b.interruptions), 1)
            oa, ob = SD.score_p2([a]), SD.score_p2([b])
            self.assertEqual(oa["verdict"], ob["verdict"])
            self.assertEqual(oa["counts"], ob["counts"])


# ---------------------------------------------------------------------------
# P3 fixture: satiated snake covers ~49 fresh cells; deprived shuffles
# between two.

class TestP3(unittest.TestCase):
    def test_p3_confirmed(self):
        with tempfile.TemporaryDirectory() as td:
            track = [(0.0, 0.0, 0.0), (50.0, 0.0, 0.0)]
            t = 110.0
            pos = [0.0, 0.0]
            for row in range(5):
                xs = range(0, 109, 12) if row % 2 == 0 else \
                    range(108, -1, -12)
                for x in xs:
                    pos = [float(x), float(row * 12)]
                    track.append((t, pos[0], pos[1]))
                    t += 10.0
                # step to the next row is the loop's next x at z+12
            while t <= 1000:
                track.append((t, pos[0], pos[1]))
                t += 10.0
            while t <= 1600:
                track.append((t, 120.0 if (int(t) // 10) % 2
                              else 108.0, 48.0))
                t += 10.0
            stages = {"S1": {"t_sim": 50.0}, "S2": {"t_sim": 100.0},
                      "S3": None, "return": None, "looks_used": 3}
            d = write_run(Path(td) / "fx-p3", track,
                          drives=[drow(1000, "energy", -80, "travel",
                                       20.0)],
                          stages=stages)
            out = SD.score_p3([SD.RunData(d)])
            self.assertEqual(out["verdict"], "CONFIRMED", out)
            self.assertGreaterEqual(out["rate_ratio"], 1.5)


# ---------------------------------------------------------------------------
# P4 fixtures: divergent pair confirms; identical pair refutes.

def build_p4_run(d, temperament, energy_before, n_looks):
    track = interp_track([(0, -17, 51.2), (250, -30, 60),
                          (490, -17, 51.2), (520, -17, 51.2),
                          (900, -40, 30)])
    trace = [look_row(10 * (i + 1)) for i in range(n_looks)]
    drives = [drow(510, "energy", 4, "rest", energy_before + 4.0)]
    stages = {"S1": {"t_sim": 60.0}, "S2": None, "S3": None,
              "return": None, "looks_used": n_looks}
    return write_run(d, track, trace=trace, drives=drives,
                     stages=stages, temperament=temperament)


class TestP4(unittest.TestCase):
    def test_p4_confirmed(self):
        with tempfile.TemporaryDirectory() as td:
            e = build_p4_run(Path(td) / "e", "ENERGY_FIRST", 40.0, 12)
            p = build_p4_run(Path(td) / "p", "PERCEPTION_FIRST", 70.0, 6)
            out = SD.score_p4([str(e), str(p)])
            self.assertTrue(out["verdict"].startswith("CONFIRMED"),
                            out)

    def test_p4_refuted_when_identical(self):
        with tempfile.TemporaryDirectory() as td:
            e = build_p4_run(Path(td) / "e", "ENERGY_FIRST", 55.0, 8)
            p = build_p4_run(Path(td) / "p", "PERCEPTION_FIRST", 55.0, 8)
            out = SD.score_p4([str(e), str(p)])
            self.assertEqual(out["verdict"], "REFUTED", out)


# ---------------------------------------------------------------------------
# Fail-loud + CLI

class TestInsufficient(unittest.TestCase):
    def test_gauntlet_baseline_fails_loud(self):
        # a REAL condition-A run dir: no drives.jsonl by design
        run1 = Path.home() / "workspace/.build-tmp/experiments" \
            / "gauntlet" / "run-1"
        r = subprocess.run(
            [sys.executable, str(HERE / "score_drive.py"), str(run1),
             "--out", "/tmp/score-drive-test.json"],
            capture_output=True, text=True)
        self.assertEqual(r.returncode, 2, r.stdout[-500:])
        self.assertIn("INSUFFICIENT DATA", r.stderr)
        rep = json.loads(Path("/tmp/score-drive-test.json").read_text())
        self.assertEqual(rep["P1"]["verdict"], "INSUFFICIENT DATA")

    def test_cli_end_to_end(self):
        with tempfile.TemporaryDirectory() as td:
            pool = build_p2_run(Path(td) / "fx-p2")
            e = build_p4_run(Path(td) / "e", "ENERGY_FIRST", 40.0, 12)
            p = build_p4_run(Path(td) / "p", "PERCEPTION_FIRST", 70.0, 6)
            r = subprocess.run(
                [sys.executable, str(HERE / "score_drive.py"),
                 str(pool), "--pair", str(e), str(p)],
                capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertIn("P2: CONFIRMED", r.stdout)
            self.assertIn("P4: CONFIRMED", r.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
