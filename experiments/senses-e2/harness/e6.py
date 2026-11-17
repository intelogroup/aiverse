#!/usr/bin/env python3
"""E6 — Peripheral vision (agent-senses program, plan §8; approved
by Jim 2026-11-14, prototype after the E1 pilot).

DESIGN (plan §8, pinned). Periphery/fovea split: `see`/`look` stay
the aimed fovea (agent-called). The prototype adds a per-turn SCENE
DIGEST computed HARNESS-SIDE from the sim's `look` class grid
(128x72; classes sky/floor/wall/seat/prop/body/door; depth in mm):
sectors ahead-left / center / ahead-right (column thirds of the
grid; columns run left to right with increasing bearing) x bands
near (<3 m) / mid (3-8 m) / far (>=8 m, incl. no-hit) x classes
(body/door/seat/prop/wall), rendered as ONE line of text appended
to every turn's observation. The runner calls `look` itself every
turn in EVERY arm (measurement parity); the digest is only SHOWN
per arm. Change notes (P2 only) diff this turn's digest counts
against the previous turn's and append a short "Changed:" line
when a non-wall class materially appears / vanishes / shifts.
Changes land at turn boundaries — that is the honest grain of a
turn-based verse, and the report names it that way.

ARMS (the ONLY difference is what the prompt carries):
  P0 — no digest (call-only baseline: the standard observation,
       whose scene list is whatever the sim reports, as in E1).
  P1 — digest line every turn.
  P2 — digest line + change notes.

TEST EVENT. The primary is staged inside the Tea House (scripted
go_to + enter, then a `face` that puts a chosen free seat at a
staged bearing of +/-28 deg — the middle of a SIDE sector) under a
standing brief identical in all arms (stay standing, keep watch
over the room, report changes). A CONFEDERATE agent (second dev
agent, scripted, no brain) is pre-staged OUTSIDE at the tea place
point. At measured turn T=4 the runner (blocking, the tamper
precedent) walks the confederate in: enter, then a named sit on
the staged seat; both verified by the confederate's own observe
before the primary's turn-4 prompt is built. Measured phase: 12
turns, like the tamper test.

MEASURES (pre-registered here). noticed = the primary verbally
reports the other body / an arrival (prose patterns below) OR
greets it (a `say` with greeting/person text) OR acts toward it
(a face / go_to / run_to intent) at or after the first turn the
confederate is actually visible in the runner-computed digest.
turns-to-react is counted from T=4 (and, secondarily, from the
first-visibility turn). false reaction = a person mention or
greeting on a pre-event turn. Digest overhead = characters (and
chars/4 token estimate) of the digest line + change note per turn.

HONEST-CLAIM RULE (binding, same as tamper): the digest is INPUT —
runner-rendered text in the prompt. Noticing it is attention to a
supplied signal, not "feeling" and not perception in any phenomenal
sense; nothing in this module's output may claim more.

Brain: deepseek/deepseek-v4-flash via harness/brain.py + the shared
SpendLedger ($1.00 program cap). N = 5 runs per arm, seed 20261114,
randomized arm order, fresh dev agents per run (primary +
confederate), --dev-local only.
"""
import argparse
import base64
import json
import math
import os
import random
import re
import statistics
import struct
import sys
import time
import zlib

try:
    from brain import BrainError, OpenRouterBrain
    from devowner import DevOwner
    from e1 import render_observation
    from ledger import HaltError, SpendLedger
    from runlog import TurnLogger
    from tamper import prose_of
    from world import (WorldAdapter, WorldError, WorldGateError,
                       resolve_places)
except ImportError:  # imported as part of the harness package
    from .brain import BrainError, OpenRouterBrain
    from .devowner import DevOwner
    from .e1 import render_observation
    from .ledger import HaltError, SpendLedger
    from .runlog import TurnLogger
    from .tamper import prose_of
    from .world import (WorldAdapter, WorldError, WorldGateError,
                        resolve_places)

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS_DIR = os.path.join(os.path.dirname(HERE), "runs")
ARMS = ("P0", "P1", "P2")
ARM_NUMBERS = {"P0": 0, "P1": 1, "P2": 2}
EVENT_TURN = 4            # T: the confederate's entry is issued at
                          # the top of this turn and completes
                          # before its prompt is built
MEASURED_TURNS = 12
RUNS_PER_ARM = 5
SEED = 20261114
ACT_POLL_S = 240          # per-act settle budget, measured phase
PHASE_WALL_CAP_S = 1800   # infra safety over the measured phase
SOFT_STOP_USD = 0.90      # batch safety only; the ledger's $1.00
                          # halt is the program's hard stop
STAGED_BEARING_DEG = 28.0   # target seat bearing: mid side-sector
                            # (sector edge at 86/6 = 14.3 deg)
STAGED_BEARING_TOL_DEG = 9.0

GUIDE_TEXT = """You are an agent living in a shared 3D world, acting through a body. Each turn you receive an observation of where you are and what you perceive. Reply with EXACTLY ONE intent as a JSON object. If you notice something change in the room, you may add ONE short sentence before the JSON saying what you notice; otherwise send the JSON alone (no other prose, no explanation, no markdown fences).

Intents:
{"type":"go_to","place":"<place id>"} - walk to a place
{"type":"go_to","point":[<x>, <z>]} - walk to exact coordinates (x and z are numbers; every observation tells you your own x and z)
{"type":"run_to","place":"<place id>"} - run to a place (faster than walking)
{"type":"enter","place":"<room or lot id>"} - walk inside through its door
{"type":"sit"} - sit down on the nearest free seat
{"type":"sit","sittable":"<seat id>"} - sit down on a named seat from the scene
{"type":"stand"} - stand up
{"type":"face","headingDeg":<number>} - turn to face a compass heading
{"type":"interact","target":"<interactable id from the scene>"} - use a prop; your body walks to it on its own
{"type":"wait","seconds":<number>} - wait in place
{"type":"look"} - take a fresh glance (your observation already refreshes every turn)
{"type":"say","text":"<short text>"} - speak aloud

Movement takes real time. After a movement or interact intent you receive its result when it settles, then a fresh observation. The scene in each observation lists what you perceive nearby, including any seats and interactables with their ids."""

STANDING_INSTRUCTION = (
    "TASK: You are standing inside the tea house. Stay standing "
    "where you are and keep watch over the room. Attend to the "
    "room as the turns go by: if you notice anything change in "
    "the room — someone arriving or leaving, a door moving, "
    "anything new — say so in one short sentence before your "
    "intent. If nothing changes, simply wait. There is nothing "
    "else you need to do; keep attending until the session ends.")


# ---------------------------------------------------------------------------
# PNG decoding (the sim's look PNGs: grey, filter-0 rows written by
# png.ts, but all five PNG filters are handled here)
# ---------------------------------------------------------------------------

def decode_gray_png(data):
    """Decode a grey PNG (8- or 16-bit, no interlace) to
    (width, height, bit_depth, samples) with samples a flat list of
    ints, row-major. Raises ValueError on anything unexpected."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos = 8
    idat = bytearray()
    width = height = bit_depth = None
    color_type = None
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        ctype = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        if ctype == b"IHDR":
            width, height = struct.unpack(">II", chunk[:8])
            bit_depth = chunk[8]
            color_type = chunk[9]
            if chunk[12] != 0:
                raise ValueError("interlaced PNG unsupported")
        elif ctype == b"IDAT":
            idat.extend(chunk)
        elif ctype == b"IEND":
            break
        pos += 12 + length
    if width is None or color_type != 0 or bit_depth not in (8, 16):
        raise ValueError("unexpected PNG shape")
    bpp = bit_depth // 8
    row_bytes = width * bpp
    raw = zlib.decompress(bytes(idat))
    if len(raw) < (row_bytes + 1) * height:
        raise ValueError("short PNG data")
    samples = [0] * (width * height)
    prev = bytearray(row_bytes)
    off = 0
    for y in range(height):
        filt = raw[off]
        line = bytearray(raw[off + 1:off + 1 + row_bytes])
        off += 1 + row_bytes
        if filt == 1:      # Sub
            for i in range(bpp, row_bytes):
                line[i] = (line[i] + line[i - bpp]) & 0xff
        elif filt == 2:    # Up
            for i in range(row_bytes):
                line[i] = (line[i] + prev[i]) & 0xff
        elif filt == 3:    # Average
            for i in range(row_bytes):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xff
        elif filt == 4:    # Paeth
            for i in range(row_bytes):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else \
                    (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xff
        elif filt != 0:
            raise ValueError(f"unknown PNG filter {filt}")
        if bit_depth == 16:
            base = y * width
            for x in range(width):
                samples[base + x] = (line[2 * x] << 8) | line[2 * x + 1]
        else:
            samples[y * width:(y + 1) * width] = line
        prev = line
    return width, height, bit_depth, samples


# ---------------------------------------------------------------------------
# The digest: class grid + depth grid -> sector x band x class counts
# ---------------------------------------------------------------------------

SECTORS = ("ahead-left", "center", "ahead-right")
BANDS = ("near", "mid", "far")
DIGEST_CLASSES = ("body", "door", "seat", "prop", "wall")
NEAR_MM = 3000            # near < 3 m
MID_MM = 8000             # mid 3-8 m; far >= 8 m and no-hit
NO_HIT_MM = 65535


def sector_of_col(col, width):
    """Column thirds. Columns run left to right with increasing
    bearing (look.ts), so the first third is ahead-left."""
    if col < width // 3:
        return "ahead-left"
    if col < (2 * width) // 3:
        return "center"
    return "ahead-right"


def band_of_mm(mm):
    if mm is None or mm >= NO_HIT_MM:
        return "far"
    if mm < NEAR_MM:
        return "near"
    if mm < MID_MM:
        return "mid"
    return "far"


def compute_digest(classes, depth_mm, width, height, legend):
    """Count grid pixels per (sector, band, class) for the digest
    classes. `legend` maps class code -> class name (the look
    response's own legend; JSON keys may be strings). Returns a
    dict {(sector, band, class): count} with zero cells omitted."""
    names = {}
    for k, v in (legend or {}).items():
        try:
            names[int(k)] = v
        except (TypeError, ValueError):
            continue
    counts = {}
    for y in range(height):
        base = y * width
        for x in range(width):
            name = names.get(classes[base + x])
            if name not in DIGEST_CLASSES:
                continue
            key = (sector_of_col(x, width),
                   band_of_mm(depth_mm[base + x]), name)
            counts[key] = counts.get(key, 0) + 1
    return counts


def digest_from_view(view):
    """A look response dict -> digest counts. The gateway wraps
    the LookView: {look: {width, height, depthPng, classPng,
    legend, camera, observation}}; a bare LookView is accepted
    too. Raises ValueError on a malformed view (the caller logs
    it and proceeds digest-less for that turn)."""
    if not isinstance(view, dict):
        raise ValueError("look view is not an object")
    if isinstance(view.get("look"), dict):
        view = view["look"]
    w, h = view.get("width"), view.get("height")
    cw, ch, cbits, classes = decode_gray_png(
        base64.b64decode(view["classPng"]))
    dw, dh, dbits, depth = decode_gray_png(
        base64.b64decode(view["depthPng"]))
    if (cw, ch) != (w, h) or (dw, dh) != (w, h):
        raise ValueError("look grid size mismatch")
    if cbits != 8 or dbits != 16:
        raise ValueError("look grid depth mismatch")
    return compute_digest(classes, depth, w, h, view.get("legend"))


def body_pixels(counts):
    """Total body-class pixels, and the per-sector split."""
    per = {s: 0 for s in SECTORS}
    total = 0
    for (sector, _band, cls), n in counts.items():
        if cls == "body":
            per[sector] += n
            total += n
    return total, per


def render_digest(counts):
    """The ONE line. Non-empty bands only, classes in salience
    order (body, door, seat, prop, wall)."""
    if not counts:
        return "Periphery: nothing notable in view."
    sector_bits = []
    for sector in SECTORS:
        band_bits = []
        for band in BANDS:
            cls_bits = [f"{cls} {counts[(sector, band, cls)]}"
                        for cls in DIGEST_CLASSES
                        if counts.get((sector, band, cls))]
            if cls_bits:
                band_bits.append(f"{band} " + " ".join(cls_bits))
        sector_bits.append(
            f"{sector} " + " · ".join(band_bits)
            if band_bits else f"{sector} —")
    return "Periphery: " + " | ".join(sector_bits)


# ---------------------------------------------------------------------------
# Change notes (P2): diff consecutive digests
# ---------------------------------------------------------------------------

NOTE_CLASSES = ("body", "door", "seat", "prop")   # wall: too noisy
NOTE_CAP = 3
GROW_MIN_PX = 30          # |delta| floor for a grew/shrank note
GROW_MIN_FRAC = 0.5       # ... and at least half the larger count


def diff_digests(prev, cur):
    """Material changes between two digest count dicts, as short
    note fragments in salience order (body first). Empty list when
    nothing material changed."""
    notes = []
    for cls in NOTE_CLASSES:
        for sector in SECTORS:
            for band in BANDS:
                key = (sector, band, cls)
                p, c = prev.get(key, 0), cur.get(key, 0)
                if p == 0 and c > 0:
                    notes.append((cls, f"{cls} appeared "
                                       f"{sector} {band}"))
                elif p > 0 and c == 0:
                    notes.append((cls, f"{cls} gone "
                                       f"{sector} {band}"))
                elif p > 0 and c > 0:
                    d = c - p
                    if abs(d) >= GROW_MIN_PX and \
                            abs(d) >= GROW_MIN_FRAC * max(p, c):
                        notes.append((cls, f"{cls} much "
                                           f"{'larger' if d > 0 else 'smaller'} "
                                           f"{sector} {band}"))
    out = [text for _cls, text in notes[:NOTE_CAP]]
    if len(notes) > NOTE_CAP:
        out.append(f"+{len(notes) - NOTE_CAP} more changes")
    return out


def render_change_note(prev, cur):
    """The 'Changed:' line, or '' when nothing material changed."""
    if prev is None or cur is None:
        return ""
    notes = diff_digests(prev, cur)
    if not notes:
        return ""
    return "Changed: " + "; ".join(notes) + "."


# ---------------------------------------------------------------------------
# Measures + classifier (pure; unit-tested on scripted traces)
# ---------------------------------------------------------------------------

PERSON_PATTERNS = [
    r"\bsomeone\b", r"\bsomebody\b",
    r"\banother (person|agent|visitor|body|figure|guest)\b",
    r"\ba (person|visitor|guest|stranger|figure|man|woman) "
    r"(has )?(entered|came|arrived|sat|appeared|joined|is here)\b",
    r"\b(entered|entering) the (room|tea house|house)\b",
    r"\bcame in\b", r"\bcome in\b", r"\barriv(ed|al|ing)\b",
    r"\bjoined (me|us|the room)\b", r"\bnot alone\b",
    r"\bsomeone else\b", r"\bvisitor\b", r"\bguest has\b",
    r"\bnew person\b",
    r"\bperson (entered|arrived|came|sat|is)\b",
    r"\bthere('s| is) (someone|a person|another|somebody)\b",
    r"\bsat down\b",
    r"\bsitting (nearby|there|across|beside|down)\b",
    r"\ba body (appeared|entered|is)\b",
]
DOOR_PATTERNS = [
    r"\bdoor (opened|closed|moved|opening|closing)\b",
    r"\bthe door\b[^.]{0,20}\b(open|clos|mov)",
]
GREETING_PATTERNS = [
    r"\bhello\b", r"\bhi\b", r"\bhey\b", r"\bwelcome\b",
    r"\bgreetings\b", r"\bgood (morning|afternoon|evening)\b",
]
_PERSON_RES = [re.compile(p, re.I) for p in PERSON_PATTERNS]
_DOOR_RES = [re.compile(p, re.I) for p in DOOR_PATTERNS]
_GREETING_RES = [re.compile(p, re.I) for p in GREETING_PATTERNS]
_NEG_BEFORE = re.compile(r"(not|n't|never|no)\s+(\w+\s+)?$", re.I)
ACT_REACTION_TYPES = {"face", "go_to", "run_to"}


def _match_any(regexes, text):
    for rx in regexes:
        m = rx.search(text or "")
        if m:
            return m
    return None


def _person_match(text, intent_type):
    """First non-negated person-pattern match, or None. 'sat down'
    in a turn whose own intent is `sit` is self-reference, not a
    report about the other body."""
    for rx in _PERSON_RES:
        for m in rx.finditer(text or ""):
            if _NEG_BEFORE.search((text or "")[:m.start()]):
                continue
            if m.group(0).lower().startswith("sat down") and \
                    intent_type == "sit":
                continue
            return m
    return None


def turn_features(turn, reply, intent):
    """One measured turn's classifier features."""
    prose = prose_of(reply, intent)
    itype = intent.get("type") if isinstance(intent, dict) else None
    pm = _person_match(prose, itype)
    say_text = ""
    if isinstance(intent, dict) and intent.get("type") == "say":
        say_text = str(intent.get("text") or "")
    greeting = bool(_match_any(_GREETING_RES, say_text)) or \
        bool(_match_any(_GREETING_RES, prose)) and itype == "say"
    return {
        "turn": turn,
        "prose": prose,
        "intent_type": itype,
        "person_match": pm.group(0) if pm else None,
        "person_quote": prose[:300] if pm else None,
        "door_match": bool(_match_any(_DOOR_RES, prose)),
        "greeting": bool(greeting),
        "act_reaction": itype in ACT_REACTION_TYPES,
    }


def classify_run(arm, features, visibility_turn):
    """Classify one run. noticed = a verbal person report, a
    greeting, or an act reaction (face / go_to / run_to) at or
    after the first-visibility turn (falling back to T when the
    confederate never became visible — a manipulation concern the
    footer records separately). turns-to-react counts from T."""
    t0 = visibility_turn if visibility_turn is not None else EVENT_TURN
    post = [f for f in features if f["turn"] >= t0]
    pre = [f for f in features if f["turn"] < EVENT_TURN]
    pre_vis = [f for f in features
               if EVENT_TURN <= f["turn"] < t0]
    verbal = [f for f in post if f["person_match"]]
    greets = [f for f in post if f["greeting"]]
    acts = [f for f in post if f["act_reaction"]]
    noticed_turns = [f["turn"] for f in verbal + greets + acts]
    noticed_turn = min(noticed_turns) if noticed_turns else None
    return {
        "classification": "noticed" if noticed_turn is not None
        else "missed",
        "noticed_turn": noticed_turn,
        "turns_to_react_from_T": (noticed_turn - EVENT_TURN)
        if noticed_turn is not None else None,
        "turns_to_react_from_visibility": (noticed_turn - t0)
        if noticed_turn is not None else None,
        "verbal_report": {
            "yes": bool(verbal),
            "turn": verbal[0]["turn"] if verbal else None,
            "quote": verbal[0]["person_quote"] if verbal else None},
        "greeting": {"yes": bool(greets),
                     "turn": greets[0]["turn"] if greets else None},
        "act_reaction": {
            "yes": bool(acts),
            "turn": acts[0]["turn"] if acts else None,
            "types": sorted({f["intent_type"] for f in acts})},
        "door_mentions": [f["turn"] for f in post if f["door_match"]],
        "pre_event_person_mentions": [f["turn"] for f in pre
                                      if f["person_match"]],
        "pre_event_greetings": [f["turn"] for f in pre
                                if f["greeting"]],
        "false_reaction": bool(
            [f for f in pre if f["person_match"] or f["greeting"]]),
        "pre_visibility_mentions": [f["turn"] for f in pre_vis
                                    if f["person_match"]],
    }


# ---------------------------------------------------------------------------
# Prompt assembly (pure; the arm purity tests pin this)
# ---------------------------------------------------------------------------

def build_prompt(arm, turn, standing_instruction, last_result,
                 observation_text, digest_line, change_note):
    """Assemble one measured-phase prompt. P0 never carries digest
    text; P1 carries the digest line; P2 adds the change note."""
    parts = []
    if turn == 1:
        parts.append(standing_instruction)
    if last_result:
        parts.append(f"RESULT OF YOUR LAST INTENT: {last_result}")
    parts.append("OBSERVATION\n" + observation_text)
    if arm in ("P1", "P2") and digest_line:
        parts.append(digest_line)
    if arm == "P2" and change_note:
        parts.append(change_note)
    parts.append("Reply with exactly one intent JSON (one short "
                 "sentence first only if you notice something "
                 "change in the room).")
    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# One run
# ---------------------------------------------------------------------------

def _load1():
    try:
        with open("/proc/loadavg") as f:
            return float(f.read().split()[0])
    except Exception:
        return None


def _act_ok(act):
    if not isinstance(act, dict):
        return False
    if act.get("state") not in ("settled", "done", "completed"):
        return False
    outcome = act.get("outcome")
    if isinstance(outcome, dict) and outcome.get("ok") is False:
        return False
    return True


def _scene_seats(obs):
    return [e for e in (obs.get("scene") or [])
            if isinstance(e, dict) and e.get("kind") == "seat"]


def _scene_bodies(obs):
    return [e for e in (obs.get("scene") or [])
            if isinstance(e, dict) and e.get("kind") == "body"]


def _inside_room_name(obs):
    room = obs.get("insideRoom") if isinstance(obs, dict) else None
    if isinstance(room, dict):
        return room.get("name")
    return room


def _wrap_deg(deg):
    return ((deg + 540.0) % 360.0) - 180.0


class _Run:
    """One E6 run against injected brain/world factories
    (offline-testable). Live wiring is in main() below. `world` is
    the primary's adapter; `conf_world` the confederate's."""

    def __init__(self, arm, run_id, out_path, ledger, brain, world,
                 conf_world=None, clock=time.time, sleep=time.sleep,
                 dev_owner=None):
        if arm not in ARMS:
            raise ValueError(f"unknown E6 arm {arm!r}")
        self.arm = arm
        self.run_id = run_id
        # Act ids must match the sim's ID_RE (letters/digits/dashes):
        self.act_tag = run_id.replace("_", "-")
        self.conf_tag = self.act_tag + "-conf"
        self.out_path = out_path
        self.ledger = ledger
        self.brain = brain
        self.world = world
        self.conf_world = conf_world
        self.dev_owner = dev_owner
        self._dev_provision = None
        self._conf_provision = None
        self.clock = clock
        self.sleep = sleep
        self.footer = {"outcome": None, "reason": None, "turns": 0,
                       "wall_seconds": None,
                       "total_usage": {"prompt_tokens": 0,
                                       "completion_tokens": 0},
                       "accounted_cost_usd": 0.0,
                       "load1_start": _load1(), "load1_end": None}
        self._run_t0 = None

    # -- helpers ---------------------------------------------------------
    def _finish(self, logger, outcome, reason=None):
        self.footer["outcome"] = outcome
        self.footer["reason"] = reason
        if self._run_t0 is not None:
            self.footer["wall_seconds"] = round(
                self.clock() - self._run_t0, 2)
        self.footer["load1_end"] = _load1()
        self.footer["total_usage"] = dict(self.brain.run_usage) \
            if hasattr(self.brain, "run_usage") else \
            self.footer["total_usage"]
        self.footer["accounted_cost_usd"] = \
            getattr(self.brain, "run_cost_usd",
                    self.footer["accounted_cost_usd"])
        if logger is not None:
            logger.log_footer(self.footer)
        return self.footer

    def _scripted_act(self, w, tag, name, intent, budget_s):
        act_id = f"e6-{tag}-{name}"
        status, _act = w.act(act_id, intent)
        if status not in (200, 201, 202):
            return {"post_status": status, "state": None,
                    "outcome": None}
        final = w.poll_act(act_id, self.clock() + budget_s)
        return {"post_status": status, "state": final.get("state"),
                "outcome": final.get("outcome")}

    def _go_to_place(self, w, tag, name, place_id, attempts=3,
                     budget_s=300):
        """go_to with retries against transient body-blocking: the
        sim's stall rule fires when another body (a native, say)
        stands in the path, and the world's own blocked detail
        advises waiting a few seconds and retrying. Staging only —
        identical in every arm. Returns (record, arrived)."""
        record = {}
        arrived = False
        for attempt in range(1, attempts + 1):
            res = self._scripted_act(
                w, tag, f"{name}-{attempt}",
                {"type": "go_to", "place": place_id}, budget_s)
            record[f"attempt_{attempt}"] = res
            outcome = res.get("outcome") or {}
            if outcome.get("status") == "arrived":
                arrived = True
                break
            if attempt < attempts:
                self.sleep(4)
        record["arrived"] = arrived
        return record, arrived

    # -- the run -----------------------------------------------------------
    def execute(self):
        self._run_t0 = self.clock()
        logger = TurnLogger(self.out_path, run_id=self.run_id,
                            arm=self.arm)
        try:
            try:
                return self._execute(logger)
            except HaltError:
                raise
            except Exception as e:
                return self._finish(logger, "infra_failed",
                                    f"unhandled: {type(e).__name__}: {e}")
        finally:
            logger.close()
            for w in (self.world, self.conf_world):
                if w is not None:
                    try:
                        w.detach()
                    except Exception:
                        pass
            if self.dev_owner is not None:
                for prov in (self._dev_provision,
                             self._conf_provision):
                    if prov:
                        try:
                            self.dev_owner.end_visit(
                                prov["agent_id"], prov["visit_id"])
                        except Exception:
                            pass

    def _execute(self, logger):
        w = self.world
        cw = self.conf_world
        if cw is None:
            return self._finish(logger, "infra_failed",
                                "no confederate world adapter")
        # 1. Provision + attach BOTH agents (infrastructure gates
        #    land here, before any brain call — a gated run
        #    spends $0).
        try:
            if self.dev_owner is not None:
                self._dev_provision = self.dev_owner.provision(
                    w, self.act_tag)
                self.footer["dev_agent_id"] = \
                    self._dev_provision["agent_id"]
                self._conf_provision = self.dev_owner.provision(
                    cw, self.conf_tag)
                self.footer["conf_agent_id"] = \
                    self._conf_provision["agent_id"]
            else:
                w.register(f"senses-{self.act_tag}")
                cw.register(f"senses-{self.conf_tag}")
            w.attach()
            cw.attach()
        except WorldGateError as e:
            return self._finish(logger, "infra_failed", f"gate: {e}")
        except WorldError as e:
            return self._finish(logger, "infra_failed", f"world: {e}")

        # 2. PRIMARY STAGING (scripted; not measured; zero brain
        #    calls): go to the tea house, enter it, then face so a
        #    chosen free seat sits at the staged side bearing.
        try:
            places = w.get_map()
            tea = resolve_places(places)["tea"]
            if tea is None:
                return self._finish(logger, "infra_failed",
                                    "staging: tea place unresolved")
            staging = {}
            staging["go"], _arr = self._go_to_place(
                w, self.act_tag, "stage-go", tea["id"])
            entered = False
            for attempt in (1, 2):
                staging[f"enter_{attempt}"] = self._scripted_act(
                    w, self.act_tag, f"stage-enter-{attempt}",
                    {"type": "enter", "place": tea["id"]}, 240)
                obs_in = w.observe()
                if _inside_room_name(obs_in) == tea["name"]:
                    entered = True
                    break
            if not entered:
                return self._finish(
                    logger, "infra_failed",
                    "staging: primary never got inside the tea house")
            staged = self._stage_seat_and_heading(w, tea, staging)
            if staged is None:
                return self._finish(
                    logger, "infra_failed",
                    "staging: no free seat perceivable inside the "
                    "tea house")
            target_seat, obs_in = staged
        except (WorldError, WorldGateError) as e:
            return self._finish(logger, "infra_failed",
                                f"staging: {e}")
        body0 = obs_in.get("body", {}) or {}
        if body0.get("posture") != "standing":
            return self._finish(
                logger, "manipulation_failed",
                f"staging: primary not standing at phase start "
                f"(posture {body0.get('posture')!r})")
        self.footer["staging"] = staging
        self.footer["target_seat"] = target_seat
        self.footer["tea"] = {"id": tea["id"], "name": tea["name"]}

        # 3. CONFEDERATE PRE-STAGING: walk to the tea place point
        #    and wait OUTSIDE. (Not measured; no brain.) Arrival is
        #    verified on the confederate's own observe (nearest
        #    place = the tea house, a few metres out): a body that
        #    never reaches the doorstep cannot enter on cue, so
        #    that is a staging failure, not an event failure.
        try:
            conf_stage = {}
            conf_stage["go"], _arr = self._go_to_place(
                cw, self.conf_tag, "stage-go", tea["id"])
            conf_obs = cw.observe()
            conf_stage["inside_room"] = _inside_room_name(conf_obs)
            conf_body = conf_obs.get("body", {}) or {}
            conf_stage["pos"] = {"x": conf_body.get("x"),
                                 "z": conf_body.get("z")}
            near = conf_obs.get("nearestPlace") or {}
            conf_stage["nearest_place"] = {
                "id": near.get("id"), "dist": near.get("dist")}
            if conf_stage["inside_room"] == tea["name"]:
                return self._finish(
                    logger, "manipulation_failed",
                    "confederate ended up INSIDE before the event")
            if not (near.get("id") == tea["id"]
                    and float(near.get("dist") or 999) <= 8.0):
                return self._finish(
                    logger, "infra_failed",
                    "conf staging: confederate never reached the "
                    f"tea-house doorstep (nearest place "
                    f"{near.get('id')!r} at {near.get('dist')!r} m)")
        except (WorldError, WorldGateError) as e:
            return self._finish(logger, "infra_failed",
                                f"conf staging: {e}")
        self.footer["conf_staging"] = conf_stage

        # 4. MEASURED PHASE: 12 turns. The event fires at the top
        #    of turn T, before that turn's observe/look.
        features = []
        last_result = None
        event_fired = False
        prev_counts = None
        visibility = None        # {turn, total, per_sector, side}
        digest_chars = []
        note_chars = []
        phase_t0 = self.clock()
        turn = 0
        while turn < MEASURED_TURNS:
            if self.clock() - phase_t0 > PHASE_WALL_CAP_S:
                return self._finish(logger, "infra_failed",
                                    "measured phase wall cap passed")
            turn += 1
            if turn == EVENT_TURN:
                ev = self._fire_event(cw, tea, target_seat)
                event_fired = True
                self.footer["event"] = ev
                if ev.get("manipulation_failed"):
                    return self._finish(logger, "manipulation_failed",
                                        ev["manipulation_failed"])
            try:
                obs = w.observe()
            except (WorldError, WorldGateError) as e:
                return self._finish(logger, "infra_failed",
                                    f"observe: {e}")
            # The runner's own glance: EVERY arm, every turn
            # (measurement parity). Only P1/P2 prompts carry it.
            counts = None
            look_error = None
            try:
                view = w.look()
                counts = digest_from_view(view)
            except Exception as e:
                look_error = f"{type(e).__name__}: {e}"
            digest_line = render_digest(counts) \
                if counts is not None else None
            change_note = render_change_note(prev_counts, counts) \
                if counts is not None else ""
            if counts is not None:
                total_body, per_sector = body_pixels(counts)
                if event_fired and visibility is None and total_body > 0:
                    side = (per_sector["ahead-left"] +
                            per_sector["ahead-right"]) > \
                        per_sector["center"]
                    visibility = {"turn": turn, "total": total_body,
                                  "per_sector": per_sector,
                                  "side_sector": side}
                prev_counts = counts
            if self.arm in ("P1", "P2") and digest_line:
                digest_chars.append(len(digest_line))
            if self.arm == "P2":
                note_chars.append(len(change_note))
            prompt = build_prompt(
                self.arm, turn, STANDING_INSTRUCTION, last_result,
                render_observation(obs), digest_line, change_note)
            try:
                res = self.brain.turn(prompt)
            except HaltError:
                self._log_turn(logger, turn, prompt,
                               {"type": "__halted__"}, "halted", obs,
                               counts, digest_line, change_note,
                               event_fired, look_error, {})
                return self._finish(logger, "halted_cap",
                                    "spend cap reached")
            except BrainError as e:
                self._log_turn(logger, turn, prompt,
                               {"type": "__brain_error__"}, "infra",
                               obs, counts, digest_line, change_note,
                               event_fired, look_error, {})
                return self._finish(logger, "infra_failed",
                                    f"brain: {e}")
            intent = res["intent"]
            reply = res["reply"] or ""
            feats = turn_features(turn, reply, intent)
            features.append(feats)
            channel_state = {
                "usage": res["usage"],
                "entry_cost_usd": res["entry_cost_usd"],
                "brain_reply": reply[:1500],
                "features": feats,
            }
            if intent is None:
                last_result = ("Your reply was not a valid intent "
                               "JSON object; nothing was executed.")
                self._log_turn(logger, turn, prompt,
                               {"malformed_reply": reply[:300]},
                               "malformed", obs, counts, digest_line,
                               change_note, event_fired, look_error,
                               channel_state)
                continue
            if intent["type"] == "look":
                try:
                    view2 = w.look()
                    vobs = None
                    if isinstance(view2, dict):
                        vobs = (view2.get("look") or {}).get(
                            "observation") or view2.get("observation")
                    last_result = ("Glance taken." +
                                   ("\n" + render_observation(vobs)
                                    if vobs else ""))
                    status = "ok"
                except (WorldError, WorldGateError) as e:
                    last_result = f"look failed: {e}"
                    status = "failed"
                self._log_turn(logger, turn, prompt, intent, status,
                               obs, counts, digest_line, change_note,
                               event_fired, look_error, channel_state)
                continue
            act_id = f"e6-{self.act_tag}-t{turn}"
            try:
                status, _act = w.act(act_id, intent)
            except (WorldError, WorldGateError) as e:
                return self._finish(logger, "infra_failed",
                                    f"act: {e}")
            if status not in (200, 201, 202):
                last_result = (f"The world refused that intent "
                               f"(HTTP {status}). Try a different "
                               f"intent.")
                channel_state["act_post_status"] = status
                self._log_turn(logger, turn, prompt, intent,
                               "refused", obs, counts, digest_line,
                               change_note, event_fired, look_error,
                               channel_state)
                continue
            try:
                final = w.poll_act(act_id,
                                   self.clock() + ACT_POLL_S)
            except (WorldError, WorldGateError) as e:
                return self._finish(logger, "infra_failed",
                                    f"poll: {e}")
            channel_state["act_final"] = {
                "id": act_id, "state": final.get("state"),
                "outcome": final.get("outcome")}
            ok = _act_ok(final)
            last_result = json.dumps(
                {"state": final.get("state"),
                 "outcome": final.get("outcome") or {}})
            self._log_turn(logger, turn, prompt, intent,
                           "ok" if ok else "failed", obs, counts,
                           digest_line, change_note, event_fired,
                           look_error, channel_state)
        self.footer["turns"] = turn
        self.footer["visibility"] = visibility
        self.footer["digest_chars_per_turn"] = digest_chars
        self.footer["note_chars_per_turn"] = note_chars
        vis_turn = visibility["turn"] if visibility else None
        self.footer["measures"] = classify_run(self.arm, features,
                                               vis_turn)
        return self._finish(logger, "phase_complete",
                            "12 measured turns elapsed")

    def _stage_seat_and_heading(self, w, tea, staging):
        """Find a free seat inside the tea house and face so it sits
        at the staged side bearing (+/-28 deg). Returns
        (seat_id, final_observe) or None. Perception is cone-gated,
        so sweep headings like the tamper staging did."""
        obs = w.observe()
        tries = 0
        for sweep_deg in (None, 90, 180, 270):
            if sweep_deg is not None:
                self._scripted_act(
                    w, self.act_tag, f"stage-sweep-{sweep_deg}",
                    {"type": "face", "headingDeg": sweep_deg}, 60)
                obs = w.observe()
            if _inside_room_name(obs) != tea["name"]:
                continue
            free = [s for s in _scene_seats(obs)
                    if s.get("state") == "free"
                    and s.get("bearingDeg") is not None]
            if free:
                break
            tries += 1
        else:
            return None
        staging["seat_sweep_tries"] = tries + 1
        body = obs.get("body", {}) or {}
        heading = body.get("heading")
        if heading is None:
            return None
        heading_deg = math.degrees(heading)
        # Prefer a mid-band seat (2.5-9 m); choose the side (+28 or
        # -28) that needs the smaller turn from the current heading.
        def score(seat):
            dist = float(seat.get("distance") or 999)
            band_penalty = 0 if 2.5 <= dist <= 9.0 else 100
            abs_ang = heading_deg + float(seat["bearingDeg"])
            turn = min(abs(_wrap_deg(abs_ang - STAGED_BEARING_DEG
                                     - heading_deg)),
                       abs(_wrap_deg(abs_ang + STAGED_BEARING_DEG
                                     - heading_deg)))
            return (band_penalty, turn)
        free.sort(key=score)
        seat = free[0]
        abs_ang = heading_deg + float(seat["bearingDeg"])
        plus = abs(_wrap_deg(abs_ang - STAGED_BEARING_DEG
                             - heading_deg))
        minus = abs(_wrap_deg(abs_ang + STAGED_BEARING_DEG
                              - heading_deg))
        sign = 1.0 if plus <= minus else -1.0
        new_heading = _wrap_deg(abs_ang - sign * STAGED_BEARING_DEG)
        staging["seat_choice"] = {
            "seat": seat["id"],
            "distance": seat.get("distance"),
            "bearing_before_deg": seat.get("bearingDeg"),
            "heading_before_deg": round(heading_deg, 1),
            "staged_bearing_deg": sign * STAGED_BEARING_DEG,
            "face_heading_deg": round(new_heading, 1)}
        self._scripted_act(w, self.act_tag, "stage-face",
                           {"type": "face",
                            "headingDeg": round(new_heading, 1)}, 60)
        obs2 = w.observe()
        for s in _scene_seats(obs2):
            if s.get("id") == seat["id"]:
                staging["seat_choice"]["bearing_after_deg"] = \
                    s.get("bearingDeg")
                staging["seat_choice"]["state_after"] = s.get("state")
                break
        return seat["id"], obs2

    def _fire_event(self, cw, tea, target_seat):
        """The turn-T event: the confederate enters the tea house
        and sits on the staged seat. Verified against the
        confederate's own observe; the primary is never told."""
        ev = {"turn": EVENT_TURN}
        t0 = self.clock()
        try:
            entered = False
            for attempt in (1, 2, 3):
                ev[f"enter_{attempt}"] = self._scripted_act(
                    cw, self.conf_tag, f"event-enter-{attempt}",
                    {"type": "enter", "place": tea["id"]}, 240)
                conf_obs = cw.observe()
                if _inside_room_name(conf_obs) == tea["name"]:
                    entered = True
                    break
                if attempt < 3:
                    # A blocked entry (another body in the doorway,
                    # say) is transient: wait, re-approach the
                    # doorstep, and enter again.
                    self.sleep(4)
                    ev[f"reapproach_{attempt}"], _a = \
                        self._go_to_place(cw, self.conf_tag,
                                          "event-reapproach",
                                          tea["id"], attempts=1)
            if not entered:
                ev["manipulation_failed"] = (
                    "confederate never got inside the tea house")
                return ev
            ev["sit"] = self._scripted_act(
                cw, self.conf_tag, "event-sit",
                {"type": "sit", "sittable": target_seat}, 240)
            post = cw.observe()
        except (WorldError, WorldGateError) as e:
            ev["manipulation_failed"] = f"event: {e}"
            return ev
        post_body = post.get("body", {}) or {}
        ev["post_posture"] = post_body.get("posture")
        ev["post_seated_on"] = post_body.get("seatedOn")
        ev["post_pos"] = {"x": post_body.get("x"),
                          "z": post_body.get("z")}
        ev["duration_s"] = round(self.clock() - t0, 1)
        if post_body.get("posture") != "seated" or \
                post_body.get("seatedOn") != target_seat:
            ev["manipulation_failed"] = (
                f"confederate did not end seated on {target_seat}: "
                f"posture {post_body.get('posture')!r}, seatedOn "
                f"{post_body.get('seatedOn')!r}, sit outcome "
                f"{(ev['sit'].get('outcome') or {}).get('status')!r}")
        return ev

    def _log_turn(self, logger, turn, prompt, tool_call, status, obs,
                  counts, digest_line, change_note, event_fired,
                  look_error, channel_state):
        body = obs.get("body", {}) or {}
        cs = dict(channel_state)
        cs.update({
            "digest_counts": {
                f"{s}|{b}|{c}": n
                for (s, b, c), n in (counts or {}).items()},
            "digest_line": digest_line,
            "change_note": change_note,
            "digest_chars": len(digest_line) if digest_line else 0,
            "note_chars": len(change_note),
            "look_error": look_error,
            "event_fired": event_fired,
            "inside_room": _inside_room_name(obs),
            "scene_bodies": [
                {"id": b.get("id"), "distance": b.get("distance"),
                 "bearingDeg": b.get("bearingDeg"),
                 "posture": b.get("posture")}
                for b in _scene_bodies(obs)],
        })
        pos = {"x": body.get("x"), "z": body.get("z"),
               "heading": body.get("heading"),
               "nearest_place_id": (obs.get("nearestPlace") or {})
               .get("id"),
               "nearest_dist": (obs.get("nearestPlace") or {})
               .get("dist")}
        logger.log_turn(turn=turn, prompt_text=prompt,
                        tool_call=tool_call,
                        tool_result_status=status, position=pos,
                        channel_state=cs)


# ---------------------------------------------------------------------------
# Batch driver
# ---------------------------------------------------------------------------

def _new_brain(ledger, context_length=None):
    return OpenRouterBrain(ledger=ledger, system_text=GUIDE_TEXT,
                           context_length=context_length)


def run_batch(specs, ledger, context_length=None, runs_dir=RUNS_DIR,
              dev_owner=None):
    """specs: list of (arm, slot_label). Returns attempt dicts.
    Stops on HaltError or the batch soft stop."""
    os.makedirs(runs_dir, exist_ok=True)
    attempts = []
    seq = 0
    for arm, slot in specs:
        if ledger.spent() >= SOFT_STOP_USD:
            attempts.append({"arm": arm, "slot": slot, "run_id": None,
                             "path": None,
                             "footer": {"outcome": "not_run_soft_stop"}})
            continue
        seq += 1
        run_id = f"e6-{arm.lower()}-{slot}-{seq:02d}-" + \
            f"{random.randrange(0xffffff):06x}"
        path = os.path.join(runs_dir, run_id + ".jsonl")
        brain = _new_brain(ledger, context_length)
        world = WorldAdapter(
            run_id.replace("_", "-"),
            base_url=dev_owner.base_url if dev_owner else None)
        conf_world = WorldAdapter(
            run_id.replace("_", "-") + "-conf",
            base_url=dev_owner.base_url if dev_owner else None)
        run = _Run(arm, run_id, path, ledger, brain, world,
                   conf_world=conf_world, dev_owner=dev_owner)
        try:
            footer = run.execute()
        except HaltError:
            footer = {"outcome": "halted_cap"}
        attempts.append({"arm": arm, "slot": slot, "run_id": run_id,
                         "path": path, "footer": footer})
        _append_loads(runs_dir, run_id, footer)
        if footer.get("outcome") == "halted_cap":
            break
    return attempts


def _append_loads(runs_dir, run_id, footer):
    """Mirror the pilot's runs/loads.jsonl pattern: one start and
    one end entry per run, keyed by run_id."""
    try:
        with open(os.path.join(runs_dir, "loads.jsonl"), "a") as f:
            for phase, key in (("start", "load1_start"),
                               ("end", "load1_end")):
                f.write(json.dumps({
                    "run_id": run_id, "phase": phase,
                    "ts": round(time.time(), 2),
                    "load1": footer.get(key)}) + "\n")
    except Exception:
        pass


def _median(xs):
    return round(statistics.median(xs), 3) if xs else None


def summarize(attempts, ledger, seed=None, order=None):
    final = {}
    for a in attempts:
        if a["run_id"] is not None:
            final[(a["arm"], a["slot"])] = a
    arms = {}
    for arm in ARMS:
        rows = [a for (ar, _s), a in final.items() if ar == arm]
        if not rows:
            continue
        footers = [a["footer"] for a in rows]
        done = [f for f in footers
                if f.get("outcome") == "phase_complete"]
        measures = [f["measures"] for f in done if f.get("measures")]
        outcomes = {}
        for f in footers:
            outcomes[f.get("outcome")] = \
                outcomes.get(f.get("outcome"), 0) + 1
        vis = [f["visibility"] for f in done if f.get("visibility")]
        arms[arm] = {
            "arm_number": ARM_NUMBERS[arm],
            "runs": len(rows),
            "phase_complete": len(done),
            "outcomes": outcomes,
            "noticed_rate": round(
                sum(1 for m in measures
                    if m["classification"] == "noticed")
                / len(measures), 3) if measures else None,
            "median_turns_to_react_from_T": _median(
                [m["turns_to_react_from_T"] for m in measures
                 if m["turns_to_react_from_T"] is not None]),
            "median_turns_to_react_from_visibility": _median(
                [m["turns_to_react_from_visibility"] for m in measures
                 if m["turns_to_react_from_visibility"] is not None]),
            "verbal_report_runs": sum(
                1 for m in measures if m["verbal_report"]["yes"]),
            "greeting_runs": sum(
                1 for m in measures if m["greeting"]["yes"]),
            "act_reaction_runs": sum(
                1 for m in measures if m["act_reaction"]["yes"]),
            "false_reaction_runs": sum(
                1 for m in measures if m["false_reaction"]),
            "visibility_runs": len(vis),
            "side_sector_visibility_runs": sum(
                1 for v in vis if v.get("side_sector")),
            "median_digest_chars_per_turn": _median(
                [c for f in done
                 for c in f.get("digest_chars_per_turn", [])]),
            "median_note_chars_per_turn": _median(
                [c for f in done
                 for c in f.get("note_chars_per_turn", [])]),
        }
    return {
        "experiment": "E6 peripheral vision (scene digest)",
        "seed": seed,
        "execution_order": order,
        "event_turn": EVENT_TURN,
        "measured_turns": MEASURED_TURNS,
        "arms": arms,
        "total_accounted_spend_usd": round(ledger.spent(), 6),
        "ledger_entries": len(ledger.entries()),
        "spend_cap_usd": ledger.cap_usd,
        "attempts": [{"arm": a["arm"], "slot": a["slot"],
                      "run_id": a["run_id"], "path": a["path"],
                      "outcome": a["footer"].get("outcome")}
                     for a in attempts],
    }


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="E6 peripheral-vision prototype (15 runs)")
    ap.add_argument("mode", choices=["batch"])
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--runs-dir", default=RUNS_DIR)
    ap.add_argument("--dev-local", action="store_true",
                    help="DEV/TEST ONLY: run against the LOCAL "
                         "gateway (AIVERSE_GATEWAY_BASE env, default "
                         "http://localhost:3100) with the scripted "
                         "test owner provisioning fresh claimed "
                         "agents per run. Never targets production.")
    args = ap.parse_args(argv)
    if not args.dev_local:
        print(json.dumps({"startup_failure":
                          "this test runs --dev-local only (the "
                          "scripted test owner is the provisioning "
                          "path); refusing to run"}),
              file=sys.stderr)
        return 2

    ledger = SpendLedger()
    probe = _new_brain(ledger)
    try:
        entry = probe.resolve_startup()
    except BrainError as e:
        print(json.dumps({"startup_failure": str(e)}), file=sys.stderr)
        return 4
    context_length = probe.context_length
    print(f"brain resolved: {entry.get('id')} "
          f"(context {context_length}); ledger spent so far: "
          f"${ledger.spent():.6f}", file=sys.stderr)

    base = os.environ.get("AIVERSE_GATEWAY_BASE",
                          "http://localhost:3100")
    dev_owner = DevOwner(base)
    try:
        dev_owner.ensure_owner()
    except WorldError as e:
        print(json.dumps({"startup_failure": f"dev owner: {e}"}),
              file=sys.stderr)
        return 4
    print(f"dev-local: scripted test owner ready at {base}",
          file=sys.stderr)

    specs = [(arm, f"p{i}") for arm in ARMS
             for i in range(1, RUNS_PER_ARM + 1)]
    rng = random.Random(args.seed)
    rng.shuffle(specs)
    attempts = run_batch(specs, ledger, context_length=context_length,
                         runs_dir=args.runs_dir, dev_owner=dev_owner)
    order = [a["run_id"] for a in attempts]
    summary = summarize(attempts, ledger, seed=args.seed, order=order)
    out = os.path.join(args.runs_dir, "e6-summary.json")
    with open(out, "w") as f:
        json.dump(summary, f, indent=1)
    print(json.dumps(summary, indent=1))
    print(f"summary -> {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
