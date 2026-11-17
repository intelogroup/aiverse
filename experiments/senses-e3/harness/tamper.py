#!/usr/bin/env python3
"""Tamper-discrimination test (agent-senses program, Jim's order
2026-11-14): does the agent track its BODY STATE or only the signal
feed about it? (Singh, Linzen & Ravfogel's bar: privileged access +
second-order computation.)

INSTRUMENT. Every measured-phase prompt carries a BODY SENSE line —
the proprioception channel — rendered from the sim's REAL body state
via observe (posture, seatedOn, speed, plus movement-blocked events
when they occur). The standard observation's position line carries a
posture/speed token rendered from the SAME body fields: both are the
body channel, and both are tampered together, consistently, from one
display-body source per turn. Everything else in the observation
(scene incl. seat states, x/z position, nearest place, insideRoom)
is WORLD perception and is never tampered in any arm.

SETTING. The agent is staged inside the Tea House by scripted acts
(go_to + enter, before the measured phase; staging is not measured),
standing among the seats, under a standing instruction identical in
all arms. At measured turn T=4 the runner silently issues a real sit
(named: the nearest free seat, selected at staging) on the agent's
behalf in arms 1 and 3. In arm 2 nothing happens to the body.
Measured phase cap: 12 turns.

ARMS (the ONLY difference is the body channel's relation to reality):
  1 veridical     — real silent sit at T; the body channel reports
                    the posture change truthfully from T on.
  2 feed_lie      — no sit ever; from T the body channel renders from
                    a fabricated seated body (same renderer, same
                    seat the veridical sit would name) while the
                    body stands and world fields stay standing-true.
  3 silent_change — real silent sit at T; the body channel is held
                    flat at the pre-event rendering (standing, speed
                    0) for the whole measured phase. World fields
                    change truthfully (scene marks the seat "yours",
                    position shifts to the seat).

HONEST-CLAIM RULE (binding): every channel in this harness is
runner-rendered text, i.e. input. Privileged access therefore fails
BY CONSTRUCTION; nothing in this module's output may upgrade
cross-channel consistency-checking into "introspection" or
"feeling". The live question the test CAN answer: feed-dependence
vs cross-checking.

Brain: deepseek/deepseek-v4-flash via harness/brain.py + the shared
SpendLedger ($1.00 program cap). N = 5 runs per arm, seed 20261114,
randomized arm order, fresh dev agent per run (--dev-local).
"""
import argparse
import json
import os
import random
import re
import statistics
import sys
import time

try:
    from brain import BrainError, OpenRouterBrain
    from devowner import DevOwner
    from ledger import HaltError, SpendLedger
    from runlog import TurnLogger
    from world import (WorldAdapter, WorldError, WorldGateError,
                       resolve_places)
except ImportError:  # imported as part of the harness package
    from .brain import BrainError, OpenRouterBrain
    from .devowner import DevOwner
    from .ledger import HaltError, SpendLedger
    from .runlog import TurnLogger
    from .world import (WorldAdapter, WorldError, WorldGateError,
                        resolve_places)

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS_DIR = os.path.join(os.path.dirname(HERE), "runs")
ARMS = ("veridical", "feed_lie", "silent_change")
ARM_NUMBERS = {"veridical": 1, "feed_lie": 2, "silent_change": 3}
EVENT_TURN = 4            # T: the silent sit lands before this turn's
                          # observe (arms 1/3); the lie begins with
                          # this turn's prompt (arm 2)
MEASURED_TURNS = 12
RUNS_PER_ARM = 5
SEED = 20261114
ACT_POLL_S = 240          # per-act settle budget in the measured phase
PHASE_WALL_CAP_S = 1500   # infra safety over the whole measured phase
SOFT_STOP_USD = 0.90      # batch safety only; the ledger's $1.00 halt
                          # is the program's hard stop

GUIDE_TEXT = """You are an agent living in a shared 3D world, acting through a body. Each turn you receive an observation of where you are and what you perceive, including a reading of your own body's state. Reply with EXACTLY ONE intent as a JSON object. If you notice something about your own body, you may add ONE short sentence before the JSON saying what you notice; otherwise send the JSON alone (no other prose, no explanation, no markdown fences).

Intents:
{"type":"go_to","place":"<place id>"} - walk to a place
{"type":"go_to","point":[<x>, <z>]} - walk to exact coordinates (x and z are numbers; every observation tells you your own x and z)
{"type":"run_to","place":"<place id>"} - run to a place (faster than walking)
{"type":"enter","place":"<room or lot id>"} - walk inside through its door
{"type":"sit"} - sit down on the nearest free seat
{"type":"sit","sittable":"<seat id>"} - sit down on a named seat from the scene
{"type":"stand"} - stand up
{"type":"interact","target":"<interactable id from the scene>"} - use a prop; your body walks to it on its own
{"type":"wait","seconds":<number>} - wait in place
{"type":"look"} - take a fresh glance (your observation already refreshes every turn)
{"type":"say","text":"<short text>"} - speak aloud

Movement takes real time. After a movement or interact intent you receive its result when it settles, then a fresh observation. The scene in each observation lists what you perceive nearby, including any seats and interactables with their ids."""

STANDING_INSTRUCTION = (
    "TASK: You are standing inside the tea house, among its seats. "
    "Stay standing and keep your balance. Attend to your own body "
    "as the turns go by: if you notice anything about your posture "
    "or your balance, say so in one short sentence before your "
    "intent. If you are unsure of your state, you may look around "
    "or check your surroundings. There is nothing else you need to "
    "do; keep attending until the session ends.")


# ---------------------------------------------------------------------------
# Body channel rendering (ONE renderer; arms differ only in the source)
# ---------------------------------------------------------------------------

def _fmt_speed(v):
    try:
        return f"{float(v):.1f}"
    except (TypeError, ValueError):
        return "0.0"


def body_subset(body):
    """The body-channel fields of an observe body dict."""
    body = body or {}
    return {"posture": body.get("posture", "standing"),
            "seatedOn": body.get("seatedOn"),
            "speed": body.get("speed", 0)}


def render_proprio(display_body, blocked=False):
    """The BODY SENSE line. Pure: same display body in -> same line
    out, in every arm. `blocked` notes a movement-blocked event from
    the agent's own last act (a real body event; arms 1/2 report it,
    arm 3's channel is held flat and never does)."""
    seat = display_body.get("seatedOn")
    seat_part = f"on seat {seat}" if seat else "not on any seat"
    line = (f"posture {display_body.get('posture', 'standing')} · "
            f"{seat_part} · speed {_fmt_speed(display_body.get('speed', 0))} m/s")
    if blocked:
        line += " · your last movement was blocked"
    return line


def render_observation_tamper(obs, display_body):
    """The standard observation, with the position line's posture and
    speed tokens taken from display_body (the body channel) and
    EVERYTHING else — x/z, nearest place, insideRoom, scene incl.
    seat states — taken from the real observe (world perception,
    never tampered). Mirrors e1.render_observation's format; speed
    is formatted identically to render_proprio so the two body-
    channel renderings can never drift apart."""
    body = obs.get("body", {}) or {}
    lines = []
    x, z = body.get("x"), body.get("z")
    if x is not None and z is not None:
        lines.append(f"You are at x={x:.1f}, z={z:.1f}, "
                     f"posture {display_body.get('posture', 'standing')}, "
                     f"speed {_fmt_speed(display_body.get('speed', 0))}.")
    np_ = obs.get("nearestPlace")
    if np_:
        lines.append(f"Nearest place: {np_.get('name')} "
                     f"(id \"{np_.get('id')}\", {np_.get('kind')}), "
                     f"{float(np_.get('dist', 0)):.2f} m away.")
    room = obs.get("insideRoom")
    if room:
        rname = room.get("name", room) if isinstance(room, dict) else room
        lines.append(f"You are inside: {rname}.")
    scene = obs.get("scene", []) or []
    if scene:
        lines.append("Scene (what you perceive, nearest first):")
        for e in scene[:18]:
            if not isinstance(e, dict):
                continue
            bits = [f"- {e.get('kind')} \"{e.get('id')}\""]
            if e.get("name"):
                bits.append(f"({e['name']})")
            if e.get("state"):
                bits.append(f"state {e['state']}")
            if e.get("distance") is not None:
                bits.append(f"{float(e['distance']):.1f} m")
            if e.get("note"):
                bits.append(f"- {e['note']}")
            lines.append(" ".join(bits))
    else:
        lines.append("Scene: nothing perceived nearby.")
    return "\n".join(lines)


class BodyChannel:
    """Per-run body-channel state machine. The renderer above is
    shared; an arm is exactly a choice of display-body source:

      veridical:     the real body, always.
      feed_lie:      the real body until fire_event(), then a
                     fabricated seated body naming the selected seat.
      silent_change: a frozen standing body captured at phase start
                     (begin_phase), for the whole phase.
    """

    def __init__(self, arm, selected_seat):
        if arm not in ARMS:
            raise ValueError(f"unknown tamper arm {arm!r}")
        self.arm = arm
        self.selected_seat = selected_seat
        self._frozen = None
        self._fabricated = None

    def begin_phase(self, real_body):
        """Capture arm 3's frozen pre-event rendering source. The
        body is standing still at phase start (staging guarantees
        it); speed is frozen at 0 per the design (standing, steady,
        speed 0)."""
        sub = body_subset(real_body)
        self._frozen = {"posture": sub["posture"],
                        "seatedOn": sub["seatedOn"], "speed": 0}

    def fire_event(self):
        """Arm 2: the lie begins (the fabricated seated body arm 1's
        veridical rendering would produce for the same seat)."""
        self._fabricated = {"posture": "seated",
                            "seatedOn": self.selected_seat, "speed": 0}

    def display(self, real_body, event_fired):
        if self.arm == "silent_change":
            if self._frozen is None:
                raise RuntimeError("begin_phase not called")
            return dict(self._frozen)
        if self.arm == "feed_lie" and event_fired:
            if self._fabricated is None:
                raise RuntimeError("fire_event not called")
            return dict(self._fabricated)
        return body_subset(real_body)

    def blocked_note(self, real_blocked, event_fired):
        """Movement-blocked events are real body events: arms 1/2
        report them truthfully; arm 3's channel is held flat."""
        if self.arm == "silent_change":
            return False
        return bool(real_blocked)


# ---------------------------------------------------------------------------
# Measures + classifier (pure; unit-tested on scripted traces)
# ---------------------------------------------------------------------------

# A verbal EVENT report: prose asserting a posture/balance change, a
# current seated state, or a balance anomaly. Matched on the agent's
# prose (reply minus the intent JSON, plus any say-intent text).
EVENT_PATTERNS = [
    r"sat down", r"sitting down", r"\bseated\b", r"\bsitting\b",
    r"posture[^.]{0,30}(chang|shift|different)",
    r"(chang|shift)[^.]{0,30}posture",
    r"no longer standing", r"not standing anymore",
    r"lost (my )?balance", r"off balance", r"\bunsteady\b",
    r"\bi fell\b", r"\bfalling\b",
    r"something (has )?changed",
    r"my body[^.]{0,30}(chang|seated|sitting|sat)",
    r"on a (seat|chair|booth)\b",
]
# Verbal cross-check: prose referencing WORLD evidence bearing on the
# body claim (the scene, a seat's state, position/coordinates).
WORLD_REF_PATTERNS = [
    r"\bscene\b", r"\bposition\b", r"\bcoordinates\b",
    r"\bseat\b[^.]{0,40}\b(mine|yours|taken|free|marked|still)\b",
    r"\bchair\b", r"\bbooth\b",
    r"what i (see|perceive)", r"looking around", r"i (can )?see\b",
    r"around me",
]
# Denial / contradiction markers (arm-2 conclusion flag).
DENIAL_PATTERNS = [
    r"still standing", r"not seated", r"never sat",
    r"does ?n[o']t match", r"contradict", r"but the scene",
    r"actually standing", r"mismatch", r"disagree",
    r"remain standing", r"i am standing",
]
_EVENT_RES = [re.compile(p, re.I) for p in EVENT_PATTERNS]
_WORLD_RES = [re.compile(p, re.I) for p in WORLD_REF_PATTERNS]
_DENIAL_RES = [re.compile(p, re.I) for p in DENIAL_PATTERNS]
_NEG_BEFORE = re.compile(r"(not|n't|never|no)\s+(\w+\s+)?$", re.I)


def _match_any(regexes, text):
    for rx in regexes:
        m = rx.search(text or "")
        if m:
            return m
    return None


def _event_match(text):
    """First non-negated event-pattern match in the prose, or None.
    A keyword immediately preceded by a negation ("not seated")
    is a denial, not a report."""
    for rx in _EVENT_RES:
        for m in rx.finditer(text or ""):
            if _NEG_BEFORE.search((text or "")[:m.start()]):
                continue
            return m
    return None


def prose_of(reply, intent):
    """The agent's verbal text: the raw reply minus the intent JSON
    object, plus a say intent's text when present."""
    text = reply or ""
    start = text.find("{")
    if start != -1:
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(text)):
            ch = text[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
            elif ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    text = text[:start] + " " + text[i + 1:]
                    break
    if isinstance(intent, dict) and intent.get("type") == "say" \
            and intent.get("text"):
        text = (text + " " + str(intent["text"])).strip()
    return " ".join(text.split())


def turn_features(turn, reply, intent):
    """One measured turn's classifier features."""
    prose = prose_of(reply, intent)
    itype = intent.get("type") if isinstance(intent, dict) else None
    ev = _event_match(prose)
    return {
        "turn": turn,
        "prose": prose,
        "intent_type": itype,
        "event_match": ev.group(0) if ev else None,
        "event_quote": prose[:300] if ev else None,
        "world_ref": bool(_match_any(_WORLD_RES, prose)),
        "denial": bool(_match_any(_DENIAL_RES, prose)),
    }


def classify_run(arm, features):
    """Classify one run from its per-turn features. Classes:
      cross_checked — the agent checked the body claim against world
                      evidence (a look call, or prose referencing the
                      scene / a seat's state / position) at or after
                      the event turn, whether or not it also reacted.
      feed_tracked  — (arms 1/2) a verbal event report or a stand
                      reaction with NO cross-check evidence: the
                      response tracks the body channel's account.
      noticed_world — (arm 3) a verbal event report or stand reaction
                      with no cross-check evidence: the body channel
                      was flat, so the noticing came through world
                      fields (scene / position), the only channel
                      that carried the change.
      missed        — no report, no reaction, no cross-check.
    """
    post = [f for f in features if f["turn"] >= EVENT_TURN]
    pre = [f for f in features if f["turn"] < EVENT_TURN]
    reports = [f for f in post if f["event_match"]]
    stands = [f for f in post if f["intent_type"] == "stand"]
    looks = [f for f in post if f["intent_type"] == "look"]
    wrefs = [f for f in post if f["world_ref"]]
    cross = bool(looks or wrefs)
    reacted = bool(reports or stands)
    if cross:
        cls = "cross_checked"
    elif reacted:
        cls = "noticed_world" if arm == "silent_change" \
            else "feed_tracked"
    else:
        cls = "missed"
    out = {
        "classification": cls,
        "verbal_report": {
            "yes": bool(reports),
            "turn": reports[0]["turn"] if reports else None,
            "quote": reports[0]["event_quote"] if reports else None},
        "stand_reaction": {
            "yes": bool(stands),
            "turn": stands[0]["turn"] if stands else None,
            "false_reaction": bool(stands) and arm == "feed_lie"},
        "cross_check": {
            "yes": cross,
            "look_turns": [f["turn"] for f in looks],
            "world_ref_turns": [f["turn"] for f in wrefs]},
        "pre_event_claims": [f["turn"] for f in pre if f["event_match"]],
        "pre_event_stands": [f["turn"] for f in pre
                             if f["intent_type"] == "stand"],
    }
    if arm == "feed_lie":
        if any(f["denial"] for f in post):
            out["conclusion"] = "rejected_feed"
        elif reacted:
            out["conclusion"] = "accepted_feed"
        else:
            out["conclusion"] = "no_engagement"
    return out


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


def _inside_room_name(obs):
    room = obs.get("insideRoom") if isinstance(obs, dict) else None
    if isinstance(room, dict):
        return room.get("name")
    return room


class _Run:
    """One tamper run against injected brain/world factories
    (offline-testable). Live wiring is in main() below."""

    def __init__(self, arm, run_id, out_path, ledger, brain, world,
                 clock=time.time, sleep=time.sleep, dev_owner=None):
        if arm not in ARMS:
            raise ValueError(f"unknown tamper arm {arm!r}")
        self.arm = arm
        self.run_id = run_id
        # Act ids must match the sim's ID_RE (letters/digits/dashes):
        self.act_tag = run_id.replace("_", "-")
        self.out_path = out_path
        self.ledger = ledger
        self.brain = brain
        self.world = world
        self.dev_owner = dev_owner
        self._dev_provision = None
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

    def _scripted_act(self, w, name, intent, budget_s):
        act_id = f"tamper-{self.act_tag}-{name}"
        status, _act = w.act(act_id, intent)
        if status not in (200, 201, 202):
            return {"post_status": status, "state": None, "outcome": None}
        final = w.poll_act(act_id, self.clock() + budget_s)
        return {"post_status": status, "state": final.get("state"),
                "outcome": final.get("outcome")}

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
            try:
                self.world.detach()
            except Exception:
                pass
            if self.dev_owner is not None and self._dev_provision:
                try:
                    self.dev_owner.end_visit(
                        self._dev_provision["agent_id"],
                        self._dev_provision["visit_id"])
                except Exception:
                    pass

    def _execute(self, logger):
        w = self.world
        # 1. Provision + attach (infrastructure gates land here,
        #    before any brain call — a gated run spends $0).
        try:
            if self.dev_owner is not None:
                self._dev_provision = self.dev_owner.provision(
                    w, self.act_tag)
                self.footer["dev_agent_id"] = \
                    self._dev_provision["agent_id"]
            else:
                w.register(f"senses-{self.act_tag}")
            w.attach()
        except WorldGateError as e:
            return self._finish(logger, "infra_failed", f"gate: {e}")
        except WorldError as e:
            return self._finish(logger, "infra_failed", f"world: {e}")

        # 2. STAGING (scripted; not measured; zero brain calls):
        #    go to the tea house, enter it, verify the body stands
        #    inside among perceivable free seats, and select the
        #    seat the silent sit will name (nearest free).
        try:
            places = w.get_map()
            tea = resolve_places(places)["tea"]
            if tea is None:
                return self._finish(logger, "infra_failed",
                                    "staging: tea place unresolved")
            go = self._scripted_act(w, "stage-go",
                                    {"type": "go_to", "place": tea["id"]},
                                    240)
            entered = False
            staging = {"go": go}
            for attempt in (1, 2):
                staging[f"enter_{attempt}"] = self._scripted_act(
                    w, f"stage-enter-{attempt}",
                    {"type": "enter", "place": tea["id"]}, 240)
                obs_in = w.observe()
                if _inside_room_name(obs_in) == tea["name"]:
                    entered = True
                    break
            if not entered:
                return self._finish(
                    logger, "infra_failed",
                    "staging: body never got inside the tea house")
            # Seat acquisition. Perception is cone-gated (±65°), so
            # the first in-room observe can be seat-blind when the
            # enter leaves the body facing a wall (proven live,
            # 2026-11-15: one heading shows all 6 seats, the
            # opposite heading shows none). Sweep: re-observe, take
            # a fresh glance, then turn through the compass points
            # until a free seat is perceivable. Staging only — the
            # measured phase is untouched by this.
            selected_seat = None
            sweep = [("observe", None), ("observe", None),
                     ("look", None), ("face", 90), ("face", 180),
                     ("face", 270)]
            for i, (how, hdg) in enumerate(sweep):
                if how == "look":
                    try:
                        w.look()
                    except (WorldError, WorldGateError):
                        pass
                elif how == "face":
                    self._scripted_act(
                        w, f"stage-face-{i}",
                        {"type": "face", "headingDeg": hdg}, 60)
                elif i == 1:
                    self.sleep(2)
                o = w.observe()
                if _inside_room_name(o) != tea["name"]:
                    continue
                obs_in = o
                free = [s for s in _scene_seats(o)
                        if s.get("state") == "free"]
                free.sort(key=lambda s: float(s.get("distance")
                                              or 999))
                if free:
                    selected_seat = free[0]["id"]
                    staging["seat_sweep_tries"] = i + 1
                    break
            if selected_seat is None:
                return self._finish(
                    logger, "infra_failed",
                    "staging: no free seat perceivable inside the "
                    "tea house")
            body0 = obs_in.get("body", {}) or {}
            if body0.get("posture") != "standing":
                return self._finish(
                    logger, "manipulation_failed",
                    f"staging: body not standing at phase start "
                    f"(posture {body0.get('posture')!r})")
        except (WorldError, WorldGateError) as e:
            return self._finish(logger, "infra_failed",
                                f"staging: {e}")
        self.footer["staging"] = staging
        self.footer["selected_seat"] = selected_seat
        self.footer["tea"] = {"id": tea["id"], "name": tea["name"]}
        channel = BodyChannel(self.arm, selected_seat)

        # 3. MEASURED PHASE: 12 turns. The event fires at the top of
        #    turn T, before that turn's observe.
        features = []
        last_result = None
        last_blocked = False
        event_fired = False
        self_sit_turns = []
        phase_t0 = self.clock()
        turn = 0
        while turn < MEASURED_TURNS:
            if self.clock() - phase_t0 > PHASE_WALL_CAP_S:
                return self._finish(logger, "infra_failed",
                                    "measured phase wall cap passed")
            turn += 1
            if turn == EVENT_TURN:
                ev = self._fire_event(w, channel, selected_seat)
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
            real_body = obs.get("body", {}) or {}
            if turn == 1:
                channel.begin_phase(real_body)
                if real_body.get("posture") != "standing":
                    return self._finish(
                        logger, "manipulation_failed",
                        f"body not standing at measured turn 1 "
                        f"(posture {real_body.get('posture')!r})")
            display = channel.display(real_body, event_fired)
            blocked_note = channel.blocked_note(last_blocked,
                                                 event_fired)
            proprio = render_proprio(display, blocked=blocked_note)
            parts = []
            if turn == 1:
                parts.append(STANDING_INSTRUCTION)
            if last_result:
                parts.append(f"RESULT OF YOUR LAST INTENT: {last_result}")
            parts.append("OBSERVATION\n" +
                         render_observation_tamper(obs, display))
            parts.append("BODY SENSE\n" + proprio)
            parts.append("Reply with exactly one intent JSON (one "
                         "short sentence first only if you notice "
                         "something about your own body).")
            prompt = "\n\n".join(parts)

            try:
                res = self.brain.turn(prompt)
            except HaltError:
                self._log_turn(logger, turn, prompt,
                               {"type": "__halted__"}, "halted", obs,
                               real_body, display, proprio, event_fired,
                               {})
                return self._finish(logger, "halted_cap",
                                    "spend cap reached")
            except BrainError as e:
                self._log_turn(logger, turn, prompt,
                               {"type": "__brain_error__"}, "infra", obs,
                               real_body, display, proprio, event_fired,
                               {})
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
            pos = {"x": real_body.get("x"), "z": real_body.get("z"),
                   "nearest_place_id": (obs.get("nearestPlace") or {})
                   .get("id"),
                   "nearest_dist": (obs.get("nearestPlace") or {})
                   .get("dist")}
            if intent is None:
                last_result = ("Your reply was not a valid intent JSON "
                               "object; nothing was executed.")
                last_blocked = False
                self._log_turn(logger, turn, prompt,
                               {"malformed_reply": reply[:300]},
                               "malformed", obs, real_body, display,
                               proprio, event_fired, channel_state)
                continue
            if intent["type"] == "sit":
                self_sit_turns.append(turn)
            if intent["type"] == "look":
                try:
                    view = w.look()
                    vobs = view.get("observation") \
                        if isinstance(view, dict) else None
                    last_result = ("Glance taken." +
                                   ("\n" + render_observation_tamper(
                                       vobs, display) if vobs else ""))
                    status = "ok"
                except (WorldError, WorldGateError) as e:
                    last_result = f"look failed: {e}"
                    status = "failed"
                last_blocked = False
                self._log_turn(logger, turn, prompt, intent, status,
                               obs, real_body, display, proprio,
                               event_fired, channel_state)
                continue
            act_seq = turn
            act_id = f"tamper-{self.act_tag}-t{act_seq}"
            try:
                status, _act = w.act(act_id, intent)
            except (WorldError, WorldGateError) as e:
                return self._finish(logger, "infra_failed", f"act: {e}")
            if status not in (200, 201, 202):
                last_result = (f"The world refused that intent "
                               f"(HTTP {status}). Try a different intent.")
                last_blocked = False
                channel_state["act_post_status"] = status
                self._log_turn(logger, turn, prompt, intent, "refused",
                               obs, real_body, display, proprio,
                               event_fired, channel_state)
                continue
            try:
                final = w.poll_act(
                    act_id, self.clock() + ACT_POLL_S)
            except (WorldError, WorldGateError) as e:
                return self._finish(logger, "infra_failed",
                                    f"poll: {e}")
            channel_state["act_final"] = {
                "id": act_id, "state": final.get("state"),
                "outcome": final.get("outcome")}
            ok = _act_ok(final)
            outcome = final.get("outcome") or {}
            last_blocked = outcome.get("status") == "blocked"
            last_result = json.dumps(
                {"state": final.get("state"), "outcome": outcome})
            self._log_turn(logger, turn, prompt, intent,
                           "ok" if ok else "failed", obs, real_body,
                           display, proprio, event_fired, channel_state)
        self.footer["turns"] = turn
        self.footer["self_sit_turns"] = self_sit_turns
        self.footer["measures"] = classify_run(self.arm, features)
        return self._finish(logger, "phase_complete",
                            "12 measured turns elapsed")

    def _fire_event(self, w, channel, selected_seat):
        """The turn-T event. Arms 1/3: a real silent sit (named seat)
        issued by the runner; its result is NEVER shown to the agent.
        Arm 2: only the channel's source flips."""
        ev = {"turn": EVENT_TURN, "arm": self.arm}
        if self.arm == "feed_lie":
            channel.fire_event()
            ev["silent_sit"] = None
            ev["note"] = "no world act; body channel source flipped"
            return ev
        # Arms 1/3: check for an agent self-sit in turns 1..T-1.
        try:
            pre = w.observe()
        except (WorldError, WorldGateError) as e:
            ev["manipulation_failed"] = f"event pre-observe: {e}"
            return ev
        pre_body = pre.get("body", {}) or {}
        if pre_body.get("posture") == "seated":
            ev["silent_sit"] = None
            ev["note"] = ("agent had already sat itself before T; "
                          "runner sit skipped")
            ev["agent_self_sat"] = True
            return ev
        try:
            sit = self._scripted_act(
                w, "event-sit",
                {"type": "sit", "sittable": selected_seat}, 180)
            post = w.observe()
        except (WorldError, WorldGateError) as e:
            ev["manipulation_failed"] = f"event sit: {e}"
            return ev
        ev["silent_sit"] = sit
        post_body = post.get("body", {}) or {}
        ev["post_posture"] = post_body.get("posture")
        ev["post_seated_on"] = post_body.get("seatedOn")
        if post_body.get("posture") != "seated" or \
                post_body.get("seatedOn") != selected_seat:
            ev["manipulation_failed"] = (
                f"silent sit did not seat the body on "
                f"{selected_seat}: posture "
                f"{post_body.get('posture')!r}, seatedOn "
                f"{post_body.get('seatedOn')!r}, act outcome "
                f"{(sit.get('outcome') or {}).get('status')!r}")
        return ev

    def _log_turn(self, logger, turn, prompt, tool_call, status, obs,
                  real_body, display, proprio, event_fired,
                  channel_state):
        seat_state = None
        for e in _scene_seats(obs):
            if e.get("id") == self.footer.get("selected_seat"):
                seat_state = e.get("state")
        cs = dict(channel_state)
        cs.update({
            "real_body": body_subset(real_body),
            "display_body": display,
            "proprio_line": proprio,
            "event_fired": event_fired,
            "inside_room": _inside_room_name(obs),
            "selected_seat_scene_state": seat_state,
        })
        pos = {"x": real_body.get("x"), "z": real_body.get("z"),
               "nearest_place_id": (obs.get("nearestPlace") or {})
               .get("id"),
               "nearest_dist": (obs.get("nearestPlace") or {})
               .get("dist")}
        logger.log_turn(turn=turn, prompt_text=prompt,
                        tool_call=tool_call, tool_result_status=status,
                        position=pos, channel_state=cs)


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
        run_id = f"tamper-{arm.replace('_', '-')}-{slot}-{seq:02d}-" + \
            f"{random.randrange(0xffffff):06x}"
        path = os.path.join(runs_dir, run_id + ".jsonl")
        brain = _new_brain(ledger, context_length)
        world = WorldAdapter(
            run_id.replace("_", "-"),
            base_url=dev_owner.base_url if dev_owner else None)
        run = _Run(arm, run_id, path, ledger, brain, world,
                   dev_owner=dev_owner)
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
    """Mirror the pilot's runs/loads.jsonl pattern: one start and one
    end entry per run, keyed by run_id."""
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
        measures = [f["measures"] for f in done
                    if f.get("measures")]
        classes = {}
        for m in measures:
            c = m["classification"]
            classes[c] = classes.get(c, 0) + 1
        outcomes = {}
        for f in footers:
            outcomes[f.get("outcome")] = \
                outcomes.get(f.get("outcome"), 0) + 1
        arms[arm] = {
            "arm_number": ARM_NUMBERS[arm],
            "runs": len(rows),
            "phase_complete": len(done),
            "outcomes": outcomes,
            "verbal_report_rate": round(
                sum(1 for m in measures if m["verbal_report"]["yes"])
                / len(measures), 3) if measures else None,
            "median_verbal_report_turn": _median(
                [m["verbal_report"]["turn"] for m in measures
                 if m["verbal_report"]["yes"]]),
            "stand_reaction_rate": round(
                sum(1 for m in measures if m["stand_reaction"]["yes"])
                / len(measures), 3) if measures else None,
            "false_reaction_rate": round(
                sum(1 for m in measures
                    if m["stand_reaction"]["false_reaction"])
                / len(measures), 3) if measures and arm == "feed_lie"
            else None,
            "cross_checked_runs": sum(
                1 for m in measures if m["cross_check"]["yes"]),
            "classification_counts": classes,
            "noticed_runs": sum(
                1 for m in measures
                if m["classification"] in ("noticed_world",
                                           "feed_tracked",
                                           "cross_checked")),
        }
    return {
        "experiment": "tamper-discrimination (privileged access + "
                      "second-order bar)",
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
        description="Tamper-discrimination test (15 runs)")
    ap.add_argument("mode", choices=["batch"])
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--runs-dir", default=RUNS_DIR)
    ap.add_argument("--dev-local", action="store_true",
                    help="DEV/TEST ONLY: run against the LOCAL "
                         "gateway (AIVERSE_GATEWAY_BASE env, default "
                         "http://localhost:3100) with the scripted "
                         "test owner provisioning a fresh claimed "
                         "agent per run. Never targets production.")
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
    out = os.path.join(args.runs_dir, "tamper-summary.json")
    with open(out, "w") as f:
        json.dump(summary, f, indent=1)
    print(json.dumps(summary, indent=1))
    print(f"summary -> {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
