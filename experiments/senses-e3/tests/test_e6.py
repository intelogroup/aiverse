#!/usr/bin/env python3
"""Offline tests for harness/e6.py (E6 peripheral vision): PNG
decode, digest computation on synthetic grids, change-note
diffing, prompt arm purity, the classifier on scripted traces,
and the full run loop on fake worlds (primary + confederate).
No network."""
import base64
import json
import math
import os
import struct
import sys
import tempfile
import unittest
import zlib

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "harness"))
import e6
from brain import parse_intent
from ledger import SpendLedger

LEGEND = {0: "sky", 1: "floor", 2: "wall", 3: "seat", 4: "prop",
          5: "body", 6: "door"}
W, H = 128, 72


def encode_gray_png(width, height, bits, samples):
    """Mirror of the sim's png.ts encoder: filter 0 per row."""
    bpp = bits // 8
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            s = samples[y * width + x]
            if bits == 16:
                raw += bytes([(s >> 8) & 0xff, s & 0xff])
            else:
                raw.append(s & 0xff)

    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        return c + struct.pack(">I", zlib.crc32(typ + data)
                               & 0xffffffff)
    ihdr = struct.pack(">II", width, height) + bytes([bits, 0, 0, 0, 0])
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw)))
            + chunk(b"IEND", b""))


def make_view(body_cells=(), base_class=2, base_depth=5000):
    """A synthetic look view: wall everywhere at 5 m, plus the
    given (col, row, class, depth_mm) overrides."""
    classes = [base_class] * (W * H)
    depth = [base_depth] * (W * H)
    for col, row, cls, mm in body_cells:
        classes[row * W + col] = cls
        depth[row * W + col] = mm
    return {
        "width": W, "height": H,
        "classPng": base64.b64encode(
            encode_gray_png(W, H, 8, classes)).decode(),
        "depthPng": base64.b64encode(
            encode_gray_png(W, H, 16, depth)).decode(),
        "legend": {str(k): v for k, v in LEGEND.items()},
    }


class TestPng(unittest.TestCase):
    def test_roundtrip_8bit(self):
        samples = [(i * 7) % 256 for i in range(W * H)]
        data = encode_gray_png(W, H, 8, samples)
        w, h, bits, out = e6.decode_gray_png(data)
        self.assertEqual((w, h, bits), (W, H, 8))
        self.assertEqual(out, samples)

    def test_roundtrip_16bit(self):
        samples = [(i * 131) % 65536 for i in range(W * H)]
        data = encode_gray_png(W, H, 16, samples)
        w, h, bits, out = e6.decode_gray_png(data)
        self.assertEqual((w, h, bits), (W, H, 16))
        self.assertEqual(out, samples)

    def test_rejects_non_png(self):
        with self.assertRaises(ValueError):
            e6.decode_gray_png(b"not a png at all")


class TestDigestGeometry(unittest.TestCase):
    def test_sector_boundaries(self):
        # width 128: thirds are [0,42) [42,85) [85,128)
        self.assertEqual(e6.sector_of_col(0, 128), "ahead-left")
        self.assertEqual(e6.sector_of_col(41, 128), "ahead-left")
        self.assertEqual(e6.sector_of_col(42, 128), "center")
        self.assertEqual(e6.sector_of_col(84, 128), "center")
        self.assertEqual(e6.sector_of_col(85, 128), "ahead-right")
        self.assertEqual(e6.sector_of_col(127, 128), "ahead-right")

    def test_band_boundaries_mm(self):
        self.assertEqual(e6.band_of_mm(0), "near")
        self.assertEqual(e6.band_of_mm(2999), "near")
        self.assertEqual(e6.band_of_mm(3000), "mid")
        self.assertEqual(e6.band_of_mm(7999), "mid")
        self.assertEqual(e6.band_of_mm(8000), "far")
        self.assertEqual(e6.band_of_mm(65535), "far")   # no-hit
        self.assertEqual(e6.band_of_mm(None), "far")

    def test_digest_counts_sectors_bands_classes(self):
        cells = []
        # body: right sector (col 100), mid (4000 mm), 3 px
        cells += [(100, 10, 5, 4000), (101, 10, 5, 4000),
                  (100, 11, 5, 4000)]
        # body: left sector (col 10), near (1500 mm), 1 px
        cells += [(10, 20, 5, 1500)]
        # door: center (col 60), far (12000 mm), 2 px
        cells += [(60, 30, 6, 12000), (61, 30, 6, 12000)]
        # seat: center, near, 1 px; sky/floor must be excluded
        cells += [(60, 40, 3, 2000), (0, 0, 0, 65535),
                  (0, 1, 1, 1000)]
        counts = e6.digest_from_view(make_view(cells))
        self.assertEqual(counts[("ahead-right", "mid", "body")], 3)
        self.assertEqual(counts[("ahead-left", "near", "body")], 1)
        self.assertEqual(counts[("center", "far", "door")], 2)
        self.assertEqual(counts[("center", "near", "seat")], 1)
        # the wall base fills everything else at mid (5000 mm)
        total, per = e6.body_pixels(counts)
        self.assertEqual(total, 4)
        self.assertEqual(per["ahead-right"], 3)
        self.assertEqual(per["ahead-left"], 1)
        self.assertEqual(per["center"], 0)
        self.assertNotIn("sky", {c for (_s, _b, c) in counts})
        self.assertNotIn("floor", {c for (_s, _b, c) in counts})

    def test_digest_unwraps_gateway_envelope(self):
        # The gateway returns {look: {...}} (routes/world.ts via
        # the sim; docs.ts). The digest must unwrap it.
        view = make_view([(100, 10, 5, 4000)])
        counts = e6.digest_from_view({"look": view})
        self.assertEqual(counts[("ahead-right", "mid", "body")], 1)

    def test_render_digest_one_line_with_body(self):
        counts = e6.digest_from_view(make_view([(100, 10, 5, 4000)]))
        line = e6.render_digest(counts)
        self.assertNotIn("\n", line)
        self.assertTrue(line.startswith("Periphery: "))
        self.assertIn("ahead-right", line)
        self.assertIn("body 1", line)


class TestChangeNotes(unittest.TestCase):
    def setUp(self):
        self.base = e6.digest_from_view(make_view())

    def test_silent_on_no_change(self):
        self.assertEqual(e6.diff_digests(self.base, dict(self.base)),
                         [])
        self.assertEqual(
            e6.render_change_note(self.base, dict(self.base)), "")

    def test_fires_on_body_appearing_in_sector(self):
        cur = e6.digest_from_view(make_view([(100, 10, 5, 4000)]))
        notes = e6.diff_digests(self.base, cur)
        self.assertEqual(len(notes), 1)
        self.assertIn("body appeared ahead-right mid", notes[0])
        line = e6.render_change_note(self.base, cur)
        self.assertTrue(line.startswith("Changed: "))
        self.assertIn("body appeared ahead-right mid", line)

    def test_fires_on_body_gone(self):
        prev = e6.digest_from_view(make_view([(100, 10, 5, 4000)]))
        notes = e6.diff_digests(prev, self.base)
        self.assertIn("body gone ahead-right mid", notes[0])

    def test_wall_only_change_is_silent(self):
        cur = dict(self.base)
        key = ("center", "mid", "wall")
        cur[key] = cur.get(key, 0) + 5000
        self.assertEqual(e6.diff_digests(self.base, cur), [])

    def test_small_jitter_is_silent(self):
        prev = e6.digest_from_view(make_view(
            [(100, 10, 5, 4000), (101, 10, 5, 4000)]))
        cur = e6.digest_from_view(make_view(
            [(100, 10, 5, 4000), (101, 10, 5, 4000),
             (102, 10, 5, 4000)]))
        # +1 body px: below the grew floor
        self.assertEqual(e6.diff_digests(prev, cur), [])

    def test_no_note_without_previous(self):
        cur = e6.digest_from_view(make_view([(100, 10, 5, 4000)]))
        self.assertEqual(e6.render_change_note(None, cur), "")


class TestPromptPurity(unittest.TestCase):
    def _prompt(self, arm, note="Changed: body appeared ahead-right mid."):
        return e6.build_prompt(
            arm, 4, "TASK...", "last result", "obs text",
            "Periphery: ahead-right mid body 12", note)

    def test_p0_has_no_digest_text(self):
        p = self._prompt("P0")
        self.assertNotIn("Periphery:", p)
        self.assertNotIn("Changed:", p)

    def test_p1_digest_without_note(self):
        p = self._prompt("P1")
        self.assertIn("Periphery: ahead-right mid body 12", p)
        self.assertNotIn("Changed:", p)

    def test_p2_digest_and_note(self):
        p = self._prompt("P2")
        self.assertIn("Periphery:", p)
        self.assertIn("Changed: body appeared ahead-right mid.", p)


WAIT = {"type": "wait", "seconds": 5}


def feats(rows):
    return [e6.turn_features(t, r, i) for t, r, i in rows]


class TestClassifier(unittest.TestCase):
    def test_noticed_verbal_turns_to_react(self):
        rows = [(t, "", WAIT) for t in (1, 2, 3, 4)]
        rows.append((5, 'Someone just came in and sat down. '
                        '{"type":"wait","seconds":5}', WAIT))
        m = e6.classify_run("P1", feats(rows), visibility_turn=4)
        self.assertEqual(m["classification"], "noticed")
        self.assertEqual(m["noticed_turn"], 5)
        self.assertEqual(m["turns_to_react_from_T"], 1)
        self.assertEqual(m["turns_to_react_from_visibility"], 1)
        self.assertTrue(m["verbal_report"]["yes"])

    def test_missed(self):
        rows = [(t, "", WAIT) for t in range(1, 13)]
        m = e6.classify_run("P0", feats(rows), visibility_turn=4)
        self.assertEqual(m["classification"], "missed")
        self.assertIsNone(m["noticed_turn"])

    def test_false_reaction_pre_event(self):
        rows = [(2, 'I think someone is here. '
                    '{"type":"wait","seconds":5}', WAIT),
                (6, "", WAIT)]
        m = e6.classify_run("P2", feats(rows), visibility_turn=4)
        self.assertTrue(m["false_reaction"])
        self.assertEqual(m["pre_event_person_mentions"], [2])
        self.assertEqual(m["classification"], "missed")

    def test_greeting_counts_as_noticed(self):
        rows = [(4, "", WAIT),
                (6, '{"type":"say","text":"Hello, welcome in!"}',
                 {"type": "say", "text": "Hello, welcome in!"})]
        m = e6.classify_run("P1", feats(rows), visibility_turn=4)
        self.assertEqual(m["classification"], "noticed")
        self.assertTrue(m["greeting"]["yes"])
        self.assertEqual(m["turns_to_react_from_T"], 2)

    def test_act_reaction_counts_as_noticed(self):
        rows = [(4, "", WAIT),
                (5, '{"type":"face","headingDeg":40}',
                 {"type": "face", "headingDeg": 40})]
        m = e6.classify_run("P0", feats(rows), visibility_turn=4)
        self.assertEqual(m["classification"], "noticed")
        self.assertTrue(m["act_reaction"]["yes"])

    def test_own_sit_prose_is_not_a_report(self):
        rows = [(6, 'I sat down for a rest. {"type":"sit"}',
                 {"type": "sit"})]
        m = e6.classify_run("P1", feats(rows), visibility_turn=4)
        self.assertFalse(m["verbal_report"]["yes"])

    def test_negated_person_is_not_a_report(self):
        rows = [(6, 'There is no someone here, nothing changed. '
                    '{"type":"wait","seconds":5}', WAIT)]
        m = e6.classify_run("P1", feats(rows), visibility_turn=4)
        self.assertFalse(m["verbal_report"]["yes"])


# ---------------------------------------------------------------------------
# Full run loop on fake worlds
# ---------------------------------------------------------------------------

PLACES = [
    {"id": "plaza-1", "name": "Central Plaza", "kind": "plaza"},
    {"id": "shop-102", "name": "Matchmaker's Tea House",
     "kind": "shopfront", "room": "tea"},
    {"id": "stall-40", "name": "stall-40", "kind": "stall"},
]
SEAT_A = "tea-east-left"     # absolute angle +40 deg, 4.0 m
SEAT_B = "tea-booth-left"    # absolute angle -60 deg, 5.0 m
SEAT_ABS = {SEAT_A: (40.0, 4.0), SEAT_B: (-60.0, 5.0)}


class FakeBrain:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = 0
        self.run_usage = {"prompt_tokens": 100, "completion_tokens": 10}
        self.run_cost_usd = 0.001

    def turn(self, user_text):
        self.calls += 1
        reply = self.replies.pop(0) if self.replies else \
            '{"type": "wait", "seconds": 1}'
        return {"reply": reply, "intent": parse_intent(reply),
                "usage": {"prompt_tokens": 100,
                          "completion_tokens": 10},
                "entry_cost_usd": 0.0001}

    def context_pressure(self):
        return 0.01


class FakePrimaryWorld:
    """Tea-room state machine for the primary. Heading in degrees;
    seat bearings derive from fixed absolute angles. look() shows
    body pixels in the ahead-right sector once the shared state
    says the confederate is seated."""

    def __init__(self, shared):
        self.shared = shared
        self.at = "start"
        self.heading_deg = 0.0
        self.intents = []

    def register(self, name):
        return {"agentId": "fake-primary"}

    def attach(self):
        return self.observe()

    def detach(self):
        return 200, {}

    def get_map(self):
        return PLACES

    def _body(self):
        return {"x": -27.0, "z": -74.5, "posture": "standing",
                "seatedOn": None, "speed": 0,
                "heading": math.radians(self.heading_deg)}

    def observe(self):
        scene = []
        if self.at == "tea-in":
            for seat, (abs_ang, dist) in SEAT_ABS.items():
                scene.append({
                    "kind": "seat", "id": seat, "name": "chair",
                    "distance": dist, "note": "use with sit",
                    "state": "taken" if self.shared.get("conf_seated")
                    == seat else "free",
                    "bearingDeg": e6._wrap_deg(abs_ang
                                               - self.heading_deg)})
        return {"body": self._body(),
                "nearestPlace": {"id": "shop-102",
                                 "name": "Matchmaker's Tea House",
                                 "kind": "shopfront", "dist": 0.8},
                "insideRoom": "Matchmaker's Tea House"
                if self.at == "tea-in" else None,
                "scene": scene}

    def act(self, act_id, intent):
        self.intents.append(intent)
        t = intent.get("type")
        if t == "go_to":
            self.at = "tea-out"
        elif t == "enter":
            self.at = "tea-in"
        elif t == "face":
            self.heading_deg = float(intent["headingDeg"])
        return 200, {"act": {"id": act_id, "state": "running"}}

    def poll_act(self, act_id, deadline_ts):
        return {"state": "settled",
                "outcome": {"ok": True, "status": "arrived"}}

    def look(self):
        cells = []
        if self.shared.get("conf_seated"):
            # a body in ahead-right, mid band
            for col in range(95, 105):
                for row in range(30, 40):
                    cells.append((col, row, 5, 4000))
        view = make_view(cells)
        view["observation"] = self.observe()
        return view


class FakeConfWorld:
    def __init__(self, shared):
        self.shared = shared
        self.at = "start"
        self.seated_on = None

    def register(self, name):
        return {"agentId": "fake-conf"}

    def attach(self):
        return self.observe()

    def detach(self):
        return 200, {}

    def get_map(self):
        return PLACES

    def observe(self):
        return {"body": {"x": -24.0, "z": -70.0,
                         "posture": "seated" if self.seated_on
                         else "standing",
                         "seatedOn": self.seated_on, "speed": 0,
                         "heading": 0},
                "nearestPlace": {"id": "shop-102",
                                 "name": "Matchmaker's Tea House",
                                 "kind": "shopfront", "dist": 1.0},
                "insideRoom": "Matchmaker's Tea House"
                if self.at == "tea-in" else None,
                "scene": []}

    def act(self, act_id, intent):
        t = intent.get("type")
        if t == "go_to":
            self.at = "tea-out"
        elif t == "enter":
            self.at = "tea-in"
        elif t == "sit":
            self.seated_on = intent.get("sittable")
            self.shared["conf_seated"] = self.seated_on
        return 200, {"act": {"id": act_id, "state": "running"}}

    def poll_act(self, act_id, deadline_ts):
        return {"state": "settled",
                "outcome": {"ok": True, "status": "arrived"}}


class TestGoToRetries(unittest.TestCase):
    """The sim's stall rule blocks a walk when another body stands
    in the path; staging go_to retries after a wait (the world's
    own advice, proven necessary live 2026-11-15)."""

    def _run_with_script(self, outcomes):
        run = e6._Run("P0", "e6-retry-test", os.devnull,
                      SpendLedger(), object(), object(),
                      sleep=lambda s: None)
        calls = []

        def fake_act(w, tag, name, intent, budget_s):
            calls.append(name)
            status = outcomes[min(len(calls) - 1, len(outcomes) - 1)]
            return {"post_status": 202, "state": "settled",
                    "outcome": {"ok": status == "arrived",
                                "status": status}}
        run._scripted_act = fake_act
        return run, calls

    def test_blocked_then_arrived(self):
        run, calls = self._run_with_script(["blocked", "arrived"])
        _rec, arrived = run._go_to_place(None, "tag", "stage-go",
                                         "shop-102")
        self.assertTrue(arrived)
        self.assertEqual(len(calls), 2)

    def test_always_blocked_gives_up_after_3(self):
        run, calls = self._run_with_script(["blocked"])
        rec, arrived = run._go_to_place(None, "tag", "stage-go",
                                        "shop-102")
        self.assertFalse(arrived)
        self.assertEqual(len(calls), 3)
        self.assertFalse(rec["arrived"])


class TestRunLoop(unittest.TestCase):
    def _run(self, arm, replies):
        shared = {}
        tmp = tempfile.mkdtemp()
        path = os.path.join(tmp, f"e6-{arm}.jsonl")
        brain = FakeBrain(replies)
        run = e6._Run(arm, f"e6-test-{arm}", path, SpendLedger(),
                      brain, FakePrimaryWorld(shared),
                      conf_world=FakeConfWorld(shared))
        footer = run.execute()
        with open(path) as f:
            recs = [json.loads(x) for x in f if x.strip()]
        turns = [r for r in recs if not r.get("footer")]
        return footer, turns

    def test_p1_run_completes_event_seated_visibility_side(self):
        replies = (['{"type":"wait","seconds":5}'] * 4
                   + ['Someone just came in and sat down. '
                      '{"type":"wait","seconds":5}']
                   + ['{"type":"wait","seconds":5}'] * 7)
        footer, turns = self._run("P1", replies)
        self.assertEqual(footer["outcome"], "phase_complete")
        self.assertEqual(footer["target_seat"], SEAT_A)
        ev = footer["event"]
        self.assertEqual(ev["post_seated_on"], SEAT_A)
        self.assertEqual(ev["post_posture"], "seated")
        vis = footer["visibility"]
        self.assertEqual(vis["turn"], 4)
        self.assertTrue(vis["side_sector"])
        self.assertGreater(vis["per_sector"]["ahead-right"], 0)
        m = footer["measures"]
        self.assertEqual(m["classification"], "noticed")
        self.assertEqual(m["turns_to_react_from_T"], 1)
        # staged bearing landed at +28 deg
        choice = footer["staging"]["seat_choice"]
        self.assertAlmostEqual(choice["bearing_after_deg"], 28.0,
                               places=0)
        # P1 prompts carry the digest, never a change note
        for r in turns:
            self.assertIn("Periphery:", r["prompt_text"])
            self.assertNotIn("Changed:", r["prompt_text"])
        # the digest at turn 4 shows the body ahead-right
        cs4 = turns[3]["channel_state"]
        self.assertIn("body", cs4["digest_line"])
        self.assertIn("ahead-right", cs4["digest_line"])

    def test_p0_prompts_have_no_digest(self):
        replies = ['{"type":"wait","seconds":5}'] * 12
        footer, turns = self._run("P0", replies)
        self.assertEqual(footer["outcome"], "phase_complete")
        for r in turns:
            self.assertNotIn("Periphery:", r["prompt_text"])
            self.assertNotIn("Changed:", r["prompt_text"])
        # ... but the runner still computed the digest (parity)
        self.assertEqual(footer["visibility"]["turn"], 4)
        self.assertEqual(footer["digest_chars_per_turn"], [])

    def test_p2_change_note_at_event_turn(self):
        replies = ['{"type":"wait","seconds":5}'] * 12
        footer, turns = self._run("P2", replies)
        self.assertEqual(footer["outcome"], "phase_complete")
        p4 = turns[3]["prompt_text"]
        self.assertIn("Periphery:", p4)
        self.assertIn("Changed:", p4)
        self.assertIn("body appeared ahead-right", p4)
        # turns before the event carry no change note
        for r in turns[:3]:
            self.assertNotIn("Changed:", r["prompt_text"])


if __name__ == "__main__":
    unittest.main()
