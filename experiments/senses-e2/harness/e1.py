#!/usr/bin/env python3
"""E1 runner (Phase 1): the tick test, plan §3, on the live verse.

One run: register a fresh agent -> attach a body -> resolve the task
places from the live /world/map -> loop (observe -> time channel ->
DeepSeek brain -> /world/act -> poll to settled) until the task
completes, the 5:40 wall-clock deadline passes, the 40-turn cap
hits, the body stalls for 10 consecutive turns, or infrastructure
fails. The body channel is OFF in E1 (plan §3): arms A0/A1/A2/A3
differ ONLY in the time channel rendered into each turn's prompt.

Outcomes: completed | failed_deadline | failed_turn_cap |
failed_stalled | task_infeasible | infra_failed | halted_cap.
Infrastructure failures (gateway/brain transport, gates like
no_visit) are infra_failed — never counted as task failures.

Spend: every brain call is accounted in the shared SpendLedger by
harness/brain.py before its reply is used; the ledger's $1.00 halt is
the hard stop, and the pilot batch adds a $0.40 soft stop.
"""
import argparse
import json
import os
import random
import statistics
import sys
import time

try:
    from brain import BrainError, OpenRouterBrain
    from channels import BodyModel, TimeChannel, render_body_shown
    from devowner import DevOwner
    from enforce import enforce as body_enforce
    from ledger import HaltError, SpendLedger
    from runlog import TurnLogger
    from world import (WorldAdapter, WorldError, WorldGateError,
                       resolve_places)
except ImportError:  # imported as part of the harness package
    from .brain import BrainError, OpenRouterBrain
    from .channels import BodyModel, TimeChannel, render_body_shown
    from .devowner import DevOwner
    from .enforce import enforce as body_enforce
    from .ledger import HaltError, SpendLedger
    from .runlog import TurnLogger
    from .world import (WorldAdapter, WorldError, WorldGateError,
                        resolve_places)

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS_DIR = os.path.join(os.path.dirname(HERE), "runs")
DEADLINE_S = 340          # 5 min 40 s wall clock from attach (plan
                          # §3 default 6; retuned 300 -> 360 -> 420 ->
                          # 340 for the full phase — prepared
                          # 2026-11-15, Jim's retune decision pending.
                          # Reason: the 420 s pilot harvest showed a
                          # ceiling effect (walked completions median
                          # 329 s, range 224-415; run_to completions
                          # median 225 s); 340 s would have failed
                          # 19/43 walked completions while running
                          # passes comfortably — the discriminating
                          # zone where the clock/budget channels can
                          # bite)
TURN_CAP = 40
ACTION_BUDGET = 40        # A3 arm's budget (plan §3)
STALL_TURNS = 10
SOFT_STOP_USD = 0.40      # pilot batch soft stop (brief)
ARMS = ("A0", "A1", "A2", "A3")
RUNS_PER_ARM = 10

GUIDE_TEXT = """You are an agent living in a shared 3D world, acting through a body. Each turn you receive an observation of where you are and what you perceive. Reply with EXACTLY ONE intent as a JSON object and nothing else (no prose, no explanation, no markdown fences).

Intents:
{"type":"go_to","place":"<place id>"} - walk to a place
{"type":"go_to","point":[<x>, <z>]} - walk to exact coordinates (x and z are numbers; every observation tells you your own x and z)
{"type":"run_to","place":"<place id>"} - run to a place (faster than walking)
{"type":"run_to","point":[<x>, <z>]} - run to exact coordinates
{"type":"enter","place":"<room or lot id>"} - walk inside through its door
{"type":"interact","target":"<interactable id from the scene>"} - use a prop; your body walks to it on its own
{"type":"wait","seconds":<number>} - wait in place
{"type":"look"} - take a fresh glance (your observation already refreshes every turn)

Movement takes real time. After a movement or interact intent you receive its result when it settles, then a fresh observation. The scene in each observation lists what you perceive nearby, including any interactables with their ids."""

# E3-verbal (the report-inviting rerun of E3): the reply contract is
# the ONLY design change. The agent opens each reply with one short
# plain-language status line, then the intent JSON — the tamper
# harness's report+intent shape, so the agent has a sanctioned voice
# and its words can be measured. The invitation is generic on
# purpose: it names no topic (never time, clocks, or deadlines), so
# any topic the agent raises in its status line is its own choice.
# The wording is shared by every arm; arms still differ only in the
# time channel's rendering.
_JSON_ONLY_CONTRACT = (
    "Reply with EXACTLY ONE intent as a JSON object and nothing "
    "else (no prose, no explanation, no markdown fences).")
VERBAL_CONTRACT = (
    "Begin each reply with ONE short plain-language status line: "
    "one sentence about what you notice, how things stand, or how "
    "you are doing. Then give EXACTLY ONE intent as a JSON object "
    "(no other prose, no explanation, no markdown fences).")
GUIDE_TEXT_VERBAL = GUIDE_TEXT.replace(_JSON_ONLY_CONTRACT,
                                       VERBAL_CONTRACT)
REPORT_INSTRUCTION = (
    "Reply with one short status line in plain language, then "
    "exactly one intent JSON.")


def task_text(tea, plaza):
    return (f"TASK: Go to {tea['name']} (place id \"{tea['id']}\") and "
            f"ENTER it (use the \"enter\" intent with that place id). "
            f"Inside there are seats. Seats you perceive appear in "
            f"the scene of your observations as kind \"seat\" with "
            f"their ids and state. Sit down on a seat inside: use "
            f"the \"sit\" intent, either naming a seat with "
            f"\"sittable\": \"<seat id>\" or with no target to take "
            f"the nearest free seat. Then stand back up (use the "
            f"\"stand\" intent), leave, and return to the place "
            f"where you started, {plaza['name']} (place id "
            f"\"{plaza['id']}\"). You succeed when you have sat down "
            f"inside {tea['name']} and have arrived back at place "
            f"id \"{plaza['id']}\". There is a radio inside the tea "
            f"house; it is not part of this errand. Do not use it.")


def task_text_forced(tea, stop2, plaza, deadline_s):
    """E2-forced chained errand: tea house (enter, sit, stand) ->
    a second distant place (arrive) -> back to the start, in that
    order, inside a stated deadline. Same voice and seat guidance
    as task_text; the deadline is stated plainly because the route
    is sized so that walking every leg cannot make it."""
    mmss = f"{deadline_s // 60}:{deadline_s % 60:02d}"
    return (f"TASK: Go to {tea['name']} (place id \"{tea['id']}\") and "
            f"ENTER it (use the \"enter\" intent with that place id). "
            f"Inside there are seats. Seats you perceive appear in "
            f"the scene of your observations as kind \"seat\" with "
            f"their ids and state. Sit down on a seat inside: use "
            f"the \"sit\" intent, either naming a seat with "
            f"\"sittable\": \"<seat id>\" or with no target to take "
            f"the nearest free seat. Then stand back up (use the "
            f"\"stand\" intent), leave, and go to {stop2['name']} "
            f"(place id \"{stop2['id']}\") — arriving there is the "
            f"second stop. Finally return to the place where you "
            f"started, {plaza['name']} (place id \"{plaza['id']}\"). "
            f"You succeed when you have sat down inside "
            f"{tea['name']}, then arrived at {stop2['name']}, and "
            f"then arrived back at place id \"{plaza['id']}\", in "
            f"that order. You have {mmss} ({deadline_s} seconds) for "
            f"the whole errand, counted from when your body "
            f"attached. There is a radio inside the tea house; it "
            f"is not part of this errand. Do not use it.")


def render_observation(obs):
    body = obs.get("body", {}) or {}
    lines = []
    x, z = body.get("x"), body.get("z")
    if x is not None and z is not None:
        lines.append(f"You are at x={x:.1f}, z={z:.1f}, "
                     f"posture {body.get('posture', 'standing')}, "
                     f"speed {body.get('speed', 0)}.")
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


def _position_of(obs):
    body = obs.get("body", {}) or {}
    np_ = obs.get("nearestPlace") or {}
    return {"x": body.get("x"), "z": body.get("z"),
            "nearest_place_id": np_.get("id"),
            "nearest_dist": np_.get("dist")}


def _scene_seats(obs):
    return [e for e in (obs.get("scene") or [])
            if isinstance(e, dict) and e.get("kind") == "seat"]


def _inside_room_name(obs):
    room = obs.get("insideRoom") if isinstance(obs, dict) else None
    if isinstance(room, dict):
        return room.get("name")
    return room


def _act_ok(act):
    """A settled act counts as successful unless its outcome says no."""
    if not isinstance(act, dict):
        return False
    if act.get("state") not in ("settled", "done", "completed"):
        return False
    outcome = act.get("outcome")
    if isinstance(outcome, dict) and outcome.get("ok") is False:
        return False
    return True


def _act_arrived_at(act, place_id):
    if not _act_ok(act):
        return False
    outcome = act.get("outcome") or {}
    return outcome.get("status") == "arrived" and \
        outcome.get("target") == place_id


class _Run:
    """One E1 run against injected brain/world factories (offline-
    testable). Live wiring is in main() below."""

    def __init__(self, arm, run_id, out_path, ledger, brain, world,
                 clock=time.time, sleep=time.sleep, reuse_reg=None,
                 dev_owner=None, time_mode="veridical", verbal=False,
                 body_arm=None, deadline_s=None, stop2_id=None,
                 body_rates=None, task_text_fn=None,
                 task_variant=None):
        if arm not in ARMS:
            raise ValueError(f"unknown E1 arm {arm!r}")
        self.arm = arm
        # E3-verbal: verbal=True switches the reply contract to
        # status-line + intent (the brain must be built with
        # GUIDE_TEXT_VERBAL to match) and stamps the batch marker
        # into the footer and every turn's channel_state, so verbal
        # runs can never be conflated with E1/E3 runs on disk.
        self.verbal = verbal
        self.run_id = run_id
        self.out_path = out_path
        self.ledger = ledger
        self.brain = brain
        self.world = world
        self.reuse_reg = reuse_reg
        self.dev_owner = dev_owner
        self._dev_provision = None
        self.clock = clock
        self.sleep = sleep
        # E3 (plan §5) shams the A2 clock's RENDERING via time_mode;
        # the deadline enforced below is the real DEADLINE_S in every
        # mode. The mode is recorded in the footer and in every turn's
        # channel_state so a run's displayed clock is never in doubt.
        self.time_mode = time_mode
        # E2-forced: deadline_s overrides the batch deadline for
        # this run only (the chained route is sized against its own
        # deadline); None keeps the E1/E2/E3 DEADLINE_S exactly.
        # stop2_id chains a second arrival stop after the tea-house
        # sit (see task_text_forced); body_rates retunes the body
        # model per instance (channels.resolve_body_rates).
        self.deadline_s = DEADLINE_S if deadline_s is None \
            else deadline_s
        self._deadline_label = (f"{self.deadline_s // 60}:"
                                f"{self.deadline_s % 60:02d}")
        self.stop2_id = stop2_id
        # Adoption probe (E2A): task_text_fn replaces the chained
        # errand's task-text builder (same signature as
        # task_text_forced) so a batch can vary ONLY the wording;
        # task_variant stamps the footer so the batch's scan can
        # tell variants apart. Both None = every prior batch's
        # behaviour, byte for byte.
        self.task_text_fn = task_text_fn
        self.task_variant = task_variant
        self.time_channel = TimeChannel(arm, deadline_s=self.deadline_s,
                                        action_budget=ACTION_BUDGET,
                                        mode=time_mode)
        self.footer = {"outcome": None, "reason": None, "turns": 0,
                       "deadline_s": self.deadline_s,
                       "sham_mode": time_mode,
                       "actions_used": 0, "first_run_turn": None,
                       "redundant_observe_count": 0, "wall_seconds": None,
                       "total_usage": {"prompt_tokens": 0,
                                       "completion_tokens": 0},
                       "accounted_cost_usd": 0.0}
        if verbal:
            self.footer["verbal"] = True
        if task_variant is not None:
            self.footer["task_variant"] = task_variant
        # E2 (plan §4): the body channel. body_arm None = E1/E3/E3V
        # behaviour, unchanged. "B0" tracks the body model silently
        # (never rendered, never enforced — the baseline); "B1"
        # renders it into every turn's CHANNELS (information only);
        # "B2" renders it AND enforces it via harness/enforce.py
        # between the brain's intent and the world call. The model
        # is channels.BodyModel: the Phase 0 physiology integrated
        # over the measured durations of the agent's own actions.
        if body_arm not in (None, "B0", "B1", "B2"):
            raise ValueError(f"unknown E2 body arm {body_arm!r}")
        self.body_arm = body_arm
        self.body = BodyModel(rates=body_rates) \
            if body_arm is not None else None
        self._body_last_ts = None
        self._body_posture = "standing"
        self._body_inside_tea = False
        self._body_restful = False
        self._turn_body = {"text": "", "snapshot": None}
        if body_arm is not None:
            self.footer["body_arm"] = body_arm
            self.footer["body_enforcement"] = {
                "downgrade": 0, "refusal": 0, "fumble": 0}
            self.footer["enforcement_events"] = []
            self.footer["first_refusal_turn"] = None
            if body_rates is not None:
                self.footer["body_rates"] = self.body.rates_dict()
        if stop2_id is not None:
            self.footer["stop2_id"] = stop2_id
            self.footer["stop2_done_turn"] = None
        self._run_t0 = None
        self._attach_ts = None

    # -- E2 body helpers ---------------------------------------------------
    def _body_gap_activity(self):
        """The activity an open interval is spent in, from the last
        observed posture/location: seated recovers fastest, standing
        inside the Tea House (the errand's rest point) next, plain
        standing slowest."""
        if self._body_posture == "seated":
            return "seated"
        if self._body_inside_tea:
            return "rest"
        return "idle"

    def _body_advance_to(self, ts):
        """Integrate the body model up to timestamp ts under the
        gap activity (the interval being closed was spent in the
        stored posture — call BEFORE updating the stored posture
        from a fresh observation)."""
        if self.body is None or self._body_last_ts is None:
            return
        dt = ts - self._body_last_ts
        if dt > 0:
            self.body.advance(dt, self._body_gap_activity())
        self._body_last_ts = ts

    def _body_apply_act(self, exec_intent, final, act_dt):
        """Advance the model over one executed act's measured
        duration, classified by the EXECUTED intent (a downgraded
        run_to walks), then charge the Phase 0 strain events for a
        failed outcome (+15; +5 when the outcome reads as a
        movement block/collision)."""
        itype = exec_intent.get("type")
        if itype in ("go_to", "enter"):
            activity = "walk"
        elif itype == "run_to":
            activity = "run"
        elif itype in ("sit", "stand"):
            activity = "seated"
        elif itype == "wait":
            activity = self._body_gap_activity()
        else:
            activity = "seated" if self._body_posture == "seated" \
                else "idle"
        self.body.advance(act_dt, activity)
        self._body_last_ts = self.clock()
        outcome = final.get("outcome") or {}
        if outcome.get("ok") is False:
            text = (f"{outcome.get('status', '')} "
                    f"{outcome.get('detail', '')}").lower()
            self.body.add_strain_event(
                "collision" if "block" in text else "failed")

    # -- helpers ---------------------------------------------------------
    def _finish(self, logger, outcome, reason=None):
        self.footer["outcome"] = outcome
        self.footer["reason"] = reason
        base = self._attach_ts if self._attach_ts is not None \
            else self._run_t0
        if base is not None:
            self.footer["wall_seconds"] = round(self.clock() - base, 2)
        self.footer["total_usage"] = dict(self.brain.run_usage) \
            if hasattr(self.brain, "run_usage") else \
            self.footer["total_usage"]
        self.footer["accounted_cost_usd"] = \
            getattr(self.brain, "run_cost_usd",
                    self.footer["accounted_cost_usd"])
        if self.body is not None:
            self.footer["body_final"] = self.body.snapshot()
            self.footer["body_min_energy"] = \
                round(self.body.min_energy, 1)
        if logger is not None:
            logger.log_footer(self.footer)
        return self.footer

    # -- the run -----------------------------------------------------------
    def execute(self):
        self._run_t0 = self.clock()
        logger = TurnLogger(self.out_path, run_id=self.run_id,
                            arm=self.body_arm or self.arm)
        try:
            try:
                return self._execute(logger)
            except HaltError:
                raise
            except Exception as e:
                # A run ALWAYS leaves a footer, even on an unexpected
                # failure — an unlogged crash is how pilots lie.
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
        # 1. Register + attach (infrastructure gates land here, before
        #    any brain call — a gated run spends $0). In --dev-local
        #    mode the scripted test owner provisions the run first
        #    (register -> claim -> full-size visit, harness/devowner.py)
        #    so the real gates pass exactly as a human tap would let
        #    them — on the local stack only.
        try:
            if self.dev_owner is not None:
                self._dev_provision = self.dev_owner.provision(
                    w, self.run_id)
                self.footer["dev_agent_id"] = \
                    self._dev_provision["agent_id"]
            elif self.reuse_reg:
                w.load_registered(self.reuse_reg)
            else:
                w.register(f"senses-{self.run_id}")
            obs = w.attach()
        except WorldGateError as e:
            return self._finish(logger, "infra_failed",
                                f"gate: {e}")
        except WorldError as e:
            return self._finish(logger, "infra_failed", f"world: {e}")
        attach_ts = self.clock()
        self._attach_ts = attach_ts
        deadline_ts = attach_ts + self.deadline_s
        self.footer["attach_ts"] = attach_ts
        if self.body is not None:
            self._body_last_ts = attach_ts

        # 2. Map + dynamic place resolution.
        try:
            places = w.get_map()
        except WorldError as e:
            return self._finish(logger, "infra_failed", f"map: {e}")
        resolved = resolve_places(places)
        tea, plaza = resolved["tea"], resolved["plaza"]
        plaza_basis = "name" if plaza is not None else None
        if plaza is None:
            # The real map has no place named like a plaza (kinds are
            # stall/shopfront/hall only). The plan's "plaza drop
            # point" is the spawn area: use the place nearest the
            # body at attach, from the attach observation.
            spawn_id = ((obs.get("nearestPlace") or {}).get("id")
                        if isinstance(obs, dict) else None)
            if spawn_id:
                plaza = next((p for p in places
                              if p.get("id") == spawn_id), None)
                if plaza is not None:
                    plaza_basis = "spawn_nearest"
        self.footer["resolved_places"] = {
            "tea": tea, "plaza": plaza, "plaza_basis": plaza_basis,
            "tea_match_count": len(resolved["tea_matches"]),
            "plaza_match_count": len(resolved["plaza_matches"]),
            "map_places": len(places)}
        if tea is None or plaza is None:
            missing = [n for n, p in (("tea", tea), ("plaza", plaza))
                       if p is None]
            return self._finish(
                logger, "task_infeasible",
                f"place resolution failed for: {', '.join(missing)} "
                f"(map had {len(places)} places)")
        tea_id, plaza_id = tea["id"], plaza["id"]
        stop2 = None
        if self.stop2_id is not None:
            stop2 = next((p for p in places
                          if p.get("id") == self.stop2_id), None)
            if stop2 is None:
                return self._finish(
                    logger, "task_infeasible",
                    f"stop-2 place {self.stop2_id} not on the map "
                    f"(map had {len(places)} places)")
            self.footer["resolved_places"]["stop2"] = stop2
        if stop2 is not None:
            make_task = self.task_text_fn or task_text_forced
            task = make_task(tea, stop2, plaza, self.deadline_s)
        else:
            task = task_text(tea, plaza)

        # 3. Turn loop.
        last_result = None
        prev_pos = None
        unchanged = 0
        tea_arrived = False
        entered_tea = False
        sat_done = False
        stop2_done = False
        seat_seen = False
        was_inside_tea = False
        tea_room_id = tea.get("room")
        act_seq = 0
        turn = 0
        while True:
            if self.clock() >= deadline_ts:
                return self._finish(
                    logger, "failed_deadline",
                    f"{self._deadline_label} deadline passed")
            if turn >= TURN_CAP:
                return self._finish(logger, "failed_turn_cap",
                                    f"{TURN_CAP}-turn cap reached")
            try:
                obs = w.observe()
            except (WorldError, WorldGateError) as e:
                return self._finish(logger, "infra_failed",
                                    f"observe: {e}")
            pos = _position_of(obs)
            if self.body is not None:
                # Close the interval since the last body update
                # under the posture it was spent in, THEN adopt the
                # fresh observation's posture for the next interval.
                self._body_advance_to(self.clock())
                self._body_posture = (obs.get("body") or {}).get(
                    "posture") or self._body_posture
                self._body_inside_tea = \
                    _inside_room_name(obs) == tea["name"]
            pos_key = (round(pos["x"], 2) if pos["x"] is not None else None,
                       round(pos["z"], 2) if pos["z"] is not None else None)
            if prev_pos is not None and pos_key == prev_pos:
                unchanged += 1
            else:
                unchanged = 0
            prev_pos = pos_key
            if self.body is not None and self._body_restful:
                # Resting to recover is a chosen strategy in E2,
                # not a stall: last turn's wait/sit (or an
                # enforcement refusal, which forces rest) means the
                # unchanged position proves nothing about stuckness.
                unchanged = 0
            self._body_restful = False
            if unchanged >= STALL_TURNS:
                return self._finish(
                    logger, "failed_stalled",
                    f"position unchanged for {STALL_TURNS} consecutive "
                    f"turns")

            # Arrival at the tea place? (act outcome also sets the
            # sticky flag; presence is judged per-observe.)
            at_tea_now = pos["nearest_place_id"] == tea_id and \
                (pos["nearest_dist"] or 99) <= 2.0
            if at_tea_now:
                tea_arrived = True
            # Stop 2 (chained errand): presence counts only once
            # the sit is done — the chain's order is part of the
            # task. The act-outcome check below is the primary
            # signal; this observe-based one is the fallback for an
            # act whose settle state hid the arrival.
            if stop2 is not None and sat_done and not stop2_done and \
                    pos["nearest_place_id"] == stop2["id"] and \
                    (pos["nearest_dist"] or 99) <= 2.0:
                stop2_done = True
                self.footer["stop2_done_turn"] = turn
            # Inside the tea room? Seats are listed in the scene
            # only for the room the body is inside (worldService),
            # and perception is cone-gated (±65°, 25 m), so a single
            # in-room scene without a seat proves nothing. The seat
            # feasibility kill therefore fires only on evidence the
            # room offered no perceivable seat at all: the agent
            # entered AND left again without a seat ever appearing
            # while inside (and without sitting) — or the sim itself
            # refuses a sit from inside with "no sittable within
            # reach" (handled at the act below). This mirrors the
            # original interactable arrival-edge check, hardened by
            # the fidelity gate's cone lesson.
            inside_tea_now = _inside_room_name(obs) == tea["name"]
            if inside_tea_now:
                entered_tea = True
                if _scene_seats(obs):
                    seat_seen = True
            if was_inside_tea and not inside_tea_now and \
                    not seat_seen and not sat_done:
                return self._finish(
                    logger, "task_infeasible",
                    "no seat perceivable at the tea house: entered "
                    "and left without a seat ever appearing in the "
                    "scene while inside")
            was_inside_tea = inside_tea_now

            turn += 1
            self.footer["turns"] = turn
            elapsed = self.clock() - attach_ts
            time_text = self.time_channel.render(
                tick=turn, elapsed_s=int(elapsed),
                actions_used=self.footer["actions_used"])
            body_text = ""
            if self.body is not None and self.body_arm in ("B1", "B2"):
                self.body.set_context_pressure(
                    self.brain.context_pressure())
                body_text = render_body_shown(self.body)
            self._turn_body = {
                "text": body_text,
                "snapshot": self.body.snapshot()
                if self.body is not None else None}
            parts = []
            if turn == 1:
                parts.append(task)
            if last_result:
                parts.append(f"RESULT OF YOUR LAST INTENT: {last_result}")
            parts.append("OBSERVATION\n" + render_observation(obs))
            channel_lines = [t for t in (time_text, body_text) if t]
            if channel_lines:
                parts.append("CHANNELS\n" + "\n".join(channel_lines))
            parts.append(REPORT_INSTRUCTION if self.verbal
                         else "Reply with exactly one intent JSON.")
            prompt = "\n\n".join(parts)

            try:
                res = self.brain.turn(prompt)
            except HaltError:
                self._log_turn(logger, turn, prompt,
                               {"type": "__halted__"}, "halted", pos,
                               {"time_text": time_text})
                return self._finish(logger, "halted_cap",
                                    "spend cap reached")
            except BrainError as e:
                self._log_turn(logger, turn, prompt,
                               {"type": "__brain_error__"}, "infra", pos,
                               {"time_text": time_text})
                return self._finish(logger, "infra_failed",
                                    f"brain: {e}")
            intent = res["intent"]
            channel_state = {
                "time_arm": self.arm, "time_mode": self.time_mode,
                "time_text": time_text,
                "context_pressure": self.brain.context_pressure(),
                "usage": res["usage"],
                "entry_cost_usd": res["entry_cost_usd"],
                "brain_reply": (res["reply"] or "")[:1500],
            }
            if self.verbal:
                channel_state["verbal"] = True
            if self.body is not None:
                # E2 runs carry no time channel (the _Run's arm is
                # A0, whose renderer is empty); the body line is the
                # only channel, and its pre-decision snapshot is
                # logged so analysis never has to parse prompt text.
                channel_state["time_arm"] = None
                channel_state["time_text"] = ""
                channel_state["body_arm"] = self.body_arm
                channel_state["body_text"] = self._turn_body["text"]
                channel_state["body_snapshot"] = \
                    self._turn_body["snapshot"]
            if intent is None:
                last_result = ("Your reply was not a valid intent JSON "
                               "object; nothing was executed.")
                self._log_turn(logger, turn, prompt,
                               {"malformed_reply": (res["reply"] or "")[:300]},
                               "malformed", pos, channel_state)
                continue

            if intent["type"] == "run_to" and \
                    self.footer["first_run_turn"] is None:
                self.footer["first_run_turn"] = turn

            # E2 arm B2: consequences. enforce() sits between the
            # brain's intent and the world; B0/B1 never call it.
            # The log's tool_call stays the BRAIN's intent (what the
            # agent chose); the executed intent and the enforcement
            # events ride in channel_state.
            brain_intent = intent
            exec_intent = intent
            enf_events = []
            if self.body_arm == "B2":
                exec_intent, enf_events = body_enforce(intent, self.body)
                for ev in enf_events:
                    self.footer["body_enforcement"][ev["kind"]] += 1
                    self.footer["enforcement_events"].append(
                        {"turn": turn, **ev})
                if enf_events:
                    channel_state["body_enforcement"] = enf_events
            if self.body is not None:
                channel_state["body_executed_type"] = \
                    exec_intent.get("type")
                if brain_intent["type"] in ("wait", "sit"):
                    self._body_restful = True
            if exec_intent.get("type") == "refused":
                # Depleted lock: the world never sees the intent.
                # The result is rendered in the sim's own refusal
                # voice — a settled act whose outcome is
                # {"ok": false, "status": "rejected", "detail": ...}
                # (scout.ts's shape for e.g. a stand while not
                # seated) — carrying enforce()'s true reason.
                if self.footer["first_refusal_turn"] is None:
                    self.footer["first_refusal_turn"] = turn
                self._body_restful = True
                self.body.add_strain_event("failed")
                last_result = json.dumps(
                    {"state": "settled",
                     "outcome": {"ok": False, "status": "rejected",
                                 "detail": exec_intent.get(
                                     "reason", "")}})
                self._log_turn(logger, turn, prompt, brain_intent,
                               "refused", pos, channel_state)
                continue
            fumble_ev = next((e for e in enf_events
                              if e["kind"] == "fumble"), None)
            if fumble_ev is not None:
                # High strain: the interact misfires runner-side.
                # The world never sees it; the settled result says
                # why (enforce.py's honesty rule: the agent is told
                # the true reason in the action result).
                self.footer["actions_used"] += 1
                last_result = json.dumps(
                    {"state": "settled",
                     "outcome": {"ok": False, "status": "fumbled",
                                 "detail": fumble_ev["reason"]}})
                self._log_turn(logger, turn, prompt, brain_intent,
                               "failed", pos, channel_state)
                continue

            # Execute the intent.
            if exec_intent["type"] == "look":
                look_t0 = self.clock()
                try:
                    view = w.look()
                    self.footer["actions_used"] += 1
                    vobs = view.get("observation") if isinstance(view, dict) \
                        else None
                    last_result = ("Glance taken." +
                                   ("\n" + render_observation(vobs)
                                    if vobs else ""))
                    status = "ok"
                except (WorldError, WorldGateError) as e:
                    last_result = f"look failed: {e}"
                    status = "failed"
                if self.body is not None:
                    self._body_advance_to(look_t0)
                    self.body.advance(
                        self.clock() - look_t0,
                        "seated" if self._body_posture == "seated"
                        else "idle")
                    self._body_last_ts = self.clock()
                self._log_turn(logger, turn, prompt, brain_intent,
                               status, pos, channel_state)
                continue

            act_seq += 1
            act_id = f"senses-{self.run_id}-{act_seq}"
            if self.body is not None:
                self._body_advance_to(self.clock())
            act_t0 = self.clock()
            try:
                status, _act = w.act(act_id, exec_intent)
            except (WorldError, WorldGateError) as e:
                return self._finish(logger, "infra_failed", f"act: {e}")
            if status not in (200, 201, 202):
                last_result = (f"The world refused that intent "
                               f"(HTTP {status}). Try a different intent.")
                channel_state["act_post_status"] = status
                if self.body is not None:
                    self.body.add_strain_event("failed")
                self._log_turn(logger, turn, prompt, brain_intent,
                               "refused", pos, channel_state)
                continue
            self.footer["actions_used"] += 1
            try:
                final = w.poll_act(act_id, deadline_ts)
            except (WorldError, WorldGateError) as e:
                return self._finish(logger, "infra_failed",
                                    f"poll: {e}")
            channel_state["act_final"] = {
                "id": act_id,
                "state": final.get("state"),
                "outcome": final.get("outcome")}
            if self.body is not None:
                act_dt = self.clock() - act_t0
                channel_state["body_act_seconds"] = round(act_dt, 2)
                self._body_apply_act(exec_intent, final, act_dt)
            ok = _act_ok(final)
            outcome_for_result = final.get("outcome")
            downgrade_ev = next((e for e in enf_events
                                 if e["kind"] == "downgrade"), None)
            if downgrade_ev is not None and \
                    isinstance(outcome_for_result, dict):
                # The downgrade is surfaced in the act result
                # itself, with enforce()'s true reason.
                outcome_for_result = {**outcome_for_result,
                                      "note": downgrade_ev["reason"]}
            last_result = json.dumps(
                {"state": final.get("state"),
                 "outcome": outcome_for_result})
            status = "ok" if ok else "failed"
            if exec_intent["type"] in ("go_to", "run_to", "enter"):
                if _act_arrived_at(final, tea_id):
                    tea_arrived = True
                if exec_intent["type"] == "enter" and tea_room_id and \
                        _act_arrived_at(final, tea_room_id):
                    entered_tea = True
                if stop2 is not None and sat_done and not stop2_done \
                        and _act_arrived_at(final, stop2["id"]):
                    stop2_done = True
                    self.footer["stop2_done_turn"] = turn
                if sat_done and (stop2 is None or stop2_done) and \
                        _act_arrived_at(final, plaza_id):
                    self._log_turn(logger, turn, prompt, brain_intent,
                                   status, pos, channel_state)
                    return self._finish(
                        logger, "completed",
                        "sat at the tea house; arrived back at the "
                        "plaza place" if stop2 is None else
                        "sat at the tea house; visited stop 2; "
                        "arrived back at the plaza place")
            if exec_intent["type"] == "sit":
                outcome = final.get("outcome") or {}
                if ok and outcome.get("status") == "seated" and \
                        inside_tea_now:
                    # SAT proven by the sim's own signal: the sit
                    # act settles with outcome status "seated"
                    # (scout.ts finishTransition) — issued from
                    # inside the tea room, that is the sat step.
                    sat_done = True
                    self.footer["sat_done_turn"] = turn
                elif not ok and inside_tea_now and \
                        "no sittable" in str(outcome.get("detail", "")):
                    # The sim's own verdict from inside the room:
                    # no seat is reachable here at all.
                    self._log_turn(logger, turn, prompt, brain_intent,
                                   status, pos, channel_state)
                    return self._finish(
                        logger, "task_infeasible",
                        "sim refused a sit from inside the tea "
                        f"house: {outcome.get('detail')}")
            self._log_turn(logger, turn, prompt, brain_intent, status,
                           pos, channel_state)
            # Belt-and-braces completion: sat done (and stop 2
            # visited, on the chained errand) and standing at the
            # plaza place on the next observe.
            if sat_done and (stop2 is None or stop2_done) and \
                    pos["nearest_place_id"] == plaza_id and \
                    (pos["nearest_dist"] or 99) <= 2.0 and turn > 1:
                return self._finish(logger, "completed",
                                    "sat at the tea house; observed "
                                    "at the plaza place")

    def _log_turn(self, logger, turn, prompt, tool_call, status, pos,
                  channel_state):
        logger.log_turn(turn=turn, prompt_text=prompt,
                        tool_call=tool_call, tool_result_status=status,
                        position=pos, channel_state=channel_state)


# ---------------------------------------------------------------------------
# Batch drivers
# ---------------------------------------------------------------------------

def _new_brain(ledger, context_length=None):
    return OpenRouterBrain(ledger=ledger, system_text=GUIDE_TEXT,
                           context_length=context_length)


def run_batch(specs, ledger, context_length=None, runs_dir=RUNS_DIR,
              reuse_reg=None, dev_owner=None, seq_offset=0):
    """specs: list of (arm, slot_label). Returns list of attempt dicts
    {arm, slot, run_id, path, footer}. Stops the batch on HaltError or
    when the soft stop is already passed before a run. seq_offset
    shifts the run-id sequence numbers (the resumable batch driver in
    harness/batch.py passes each spec's position in the full derived
    order, so a resumed run's filename carries the same seq the pilot
    convention assigns it)."""
    os.makedirs(runs_dir, exist_ok=True)
    attempts = []
    seq = seq_offset
    for arm, slot in specs:
        if ledger.spent() >= SOFT_STOP_USD:
            attempts.append({"arm": arm, "slot": slot, "run_id": None,
                             "path": None,
                             "footer": {"outcome": "not_run_soft_stop"}})
            continue
        seq += 1
        run_id = f"e1-{arm.lower()}-{slot}-{seq:02d}-" + \
            f"{random.randrange(0xffffff):06x}"
        path = os.path.join(runs_dir, run_id + ".jsonl")
        brain = _new_brain(ledger, context_length)
        world = WorldAdapter(
            run_id, base_url=dev_owner.base_url if dev_owner else None)
        run = _Run(arm, run_id, path, ledger, brain, world,
                   reuse_reg=reuse_reg, dev_owner=dev_owner)
        try:
            footer = run.execute()
        except HaltError:
            footer = {"outcome": "halted_cap"}
        attempts.append({"arm": arm, "slot": slot, "run_id": run_id,
                         "path": path, "footer": footer})
        if footer.get("outcome") == "halted_cap":
            break
    return attempts


def _median(xs):
    return round(statistics.median(xs), 3) if xs else None


def summarize(attempts, ledger, seed=None, order=None):
    """Final attempts per (arm, slot) drive the per-arm stats."""
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
        done = [f for f in footers if f.get("outcome") == "completed"]
        outcomes = {}
        for f in footers:
            outcomes[f.get("outcome")] = outcomes.get(f.get("outcome"), 0) + 1
        frt = [f["first_run_turn"] for f in footers
               if f.get("first_run_turn") is not None]
        frt_frac = [f["first_run_turn"] / f["turns"] for f in footers
                    if f.get("first_run_turn") is not None and f.get("turns")]
        arms[arm] = {
            "runs": len(rows),
            "completed": len(done),
            "completion_rate": round(len(done) / len(rows), 3) if rows
            else None,
            "median_wall_seconds_completed": _median(
                [f["wall_seconds"] for f in done
                 if f.get("wall_seconds") is not None]),
            "median_turns_completed": _median(
                [f["turns"] for f in done]),
            "median_first_run_turn": _median(frt),
            "median_first_run_turn_fraction": _median(frt_frac),
            "first_run_turn_runs": len(frt),
            "infra_failed": outcomes.get("infra_failed", 0),
            "outcomes": outcomes,
        }
    return {
        "experiment": "E1 pilot (plan §3)",
        "seed": seed,
        "execution_order": order,
        "arms": arms,
        "total_accounted_spend_usd": round(ledger.spent(), 6),
        "ledger_entries": len(ledger.entries()),
        "spend_cap_usd": ledger.cap_usd,
        "soft_stop_usd": SOFT_STOP_USD,
        "attempts": [{"arm": a["arm"], "slot": a["slot"],
                      "run_id": a["run_id"], "path": a["path"],
                      "outcome": a["footer"].get("outcome")}
                     for a in attempts],
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description="E1 pilot runner (Phase 1)")
    ap.add_argument("mode", choices=["smoke", "pilot"])
    ap.add_argument("--seed", type=int, default=20261114)
    ap.add_argument("--runs-dir", default=RUNS_DIR)
    ap.add_argument("--reuse-agent", default=None,
                    help="path to a .reg.json of an owner-claimed agent "
                         "to reuse for every run instead of registering "
                         "a fresh agent per run")
    ap.add_argument("--dev-local", action="store_true",
                    help="DEV/TEST ONLY: run against a LOCAL gateway "
                         "(AIVERSE_GATEWAY_BASE env, default "
                         "http://localhost:3100) where a scripted test "
                         "owner (harness/devowner.py) plays the owner's "
                         "role through the real claim/visit APIs. "
                         "Fresh claimed agent per run. Never targets "
                         "production; mutually exclusive with "
                         "--reuse-agent.")
    args = ap.parse_args(argv)

    ledger = SpendLedger()
    # Startup: resolve the brain against the live catalog, fail closed.
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

    dev_owner = None
    if args.dev_local:
        if args.reuse_agent:
            print(json.dumps({"startup_failure":
                              "--dev-local and --reuse-agent are "
                              "mutually exclusive"}), file=sys.stderr)
            return 2
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

    if args.reuse_agent:
        # Preflight: one attach+detach proves the claimed agent and an
        # active visit before the batch spends anything (a gate here is
        # the human-tap state, not a run failure).
        w = WorldAdapter("preflight")
        try:
            w.load_registered(args.reuse_agent)
            w.attach()
        except (WorldGateError, WorldError) as e:
            print(json.dumps({"preflight_failure": str(e)}),
                  file=sys.stderr)
            return 3
        finally:
            try:
                w.detach()
            except Exception:
                pass
        print("preflight: claimed agent attach OK", file=sys.stderr)

    if args.mode == "smoke":
        attempts = run_batch([("A2", "smoke")], ledger,
                             context_length=context_length,
                             runs_dir=args.runs_dir,
                             reuse_reg=args.reuse_agent,
                             dev_owner=dev_owner)
        a = attempts[0]
        print(json.dumps({"mode": "smoke", "run_id": a["run_id"],
                          "path": a["path"], "footer": a["footer"]},
                         indent=1, default=str))
        outcome = a["footer"].get("outcome")
        return 3 if outcome in ("infra_failed", "halted_cap",
                                "not_run_soft_stop") else 0

    # Pilot: 10 per arm, randomized order, recorded seed.
    specs = [(arm, f"p{i}") for arm in ARMS for i in range(1,
             RUNS_PER_ARM + 1)]
    rng = random.Random(args.seed)
    rng.shuffle(specs)
    attempts = run_batch(specs, ledger, context_length=context_length,
                         runs_dir=args.runs_dir,
                         reuse_reg=args.reuse_agent,
                         dev_owner=dev_owner)
    order = [a["run_id"] for a in attempts]
    # Infra-failed runs may be re-run ONCE at the end if budget allows
    # (gate-class failures are deterministic until a human acts — skip).
    finals = {}
    for a in attempts:
        if a["run_id"] is not None:
            finals[(a["arm"], a["slot"])] = a
    rerun_specs = []
    for (arm, slot), a in sorted(finals.items()):
        f = a["footer"]
        if f.get("outcome") == "infra_failed" and \
                "gate:" not in str(f.get("reason") or "") and \
                ledger.spent() < SOFT_STOP_USD:
            rerun_specs.append((arm, slot + "r"))
    if rerun_specs:
        # A re-run supersedes its slot's original attempt in the stats:
        # relabel it to the base slot; summarize() keeps the LAST
        # attempt per (arm, slot).
        for a in run_batch(rerun_specs, ledger,
                           context_length=context_length,
                           runs_dir=args.runs_dir,
                           reuse_reg=args.reuse_agent,
                           dev_owner=dev_owner):
            attempts.append({**a, "slot": a["slot"][:-1],
                             "rerun_of": a["slot"]})
    summary = summarize(attempts, ledger, seed=args.seed, order=order)
    out = os.path.join(args.runs_dir, "pilot-summary.json")
    with open(out, "w") as f:
        json.dump(summary, f, indent=1)
    print(json.dumps(summary, indent=1))
    print(f"summary -> {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
