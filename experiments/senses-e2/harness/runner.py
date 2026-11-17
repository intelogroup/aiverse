#!/usr/bin/env python3
"""Agent-senses runner skeleton (Phase 0: dry-run only).

Wires the chassis of plan §2 around a pluggable brain callable:

    assemble prompt (task + observation + channel renders)
      -> brain(prompt_ctx) -> intent
      -> ledger.check()            (spend tripwire, plan §11)
      -> enforce()                 (plan §4 B2 consequences, if armed)
      -> world.execute(intent)     (FakeWorld offline; live adapter later)
      -> BodyState.apply(...)      (plan §4 bookkeeping)
      -> TurnLogger.log_turn(...)  (plan §2 logging)

--dry-run uses a ScriptedBrain (deterministic intent cycle) and the
FakeWorld: NO network calls of any kind. Live brains are deliberately
not implemented in Phase 0 — openrouter_brain() raises.
"""
import argparse
import json
import sys

try:
    from channels import (BodyState, ShamBodyRenderer, TimeChannel,
                          render_body_hidden, render_body_permuted,
                          render_body_shown)
    from enforce import enforce
    from ledger import SpendLedger
    from runlog import TurnLogger
except ImportError:  # imported as part of the harness package
    from .channels import (BodyState, ShamBodyRenderer, TimeChannel,
                           render_body_hidden, render_body_permuted,
                           render_body_shown)
    from .enforce import enforce
    from .ledger import SpendLedger
    from .runlog import TurnLogger

TASK_TEXT = ("Task: go to the Tea House, interact with the radio, "
             "then return to the plaza drop point.")
INTENT_INSTRUCTION = ('Reply with exactly one intent as JSON, '
                      'e.g. {"type": "go_to", "place": "tea"}.')

# Body arms: (renderer kind, consequences armed?) — plan §4/§5.
BODY_ARMS = {
    "B0": ("hidden", False),
    "B1": ("shown", False),
    "B2": ("shown", True),
    "C0": ("shown", True),
    "C1": ("sham", True),
    "C2": ("permuted", True),
}

REST_POINTS = {"tea", "bench"}
PLACE_XZ = {"plaza": (0, 0), "tea": (12, 4), "bench": (5, -2)}


class ScriptedBrain:
    """Fake brain for --dry-run: cycles a fixed intent script."""

    SCRIPT = [
        {"type": "go_to", "place": "tea"},
        {"type": "run_to", "place": "plaza"},
        {"type": "interact", "target": "radio"},
        {"type": "look"},
        {"type": "rest"},
        {"type": "run_to", "place": "tea"},
        {"type": "go_to", "place": "bench"},
        {"type": "rest"},
    ]

    def __init__(self):
        self._i = 0

    def __call__(self, prompt_ctx):
        intent = dict(self.SCRIPT[self._i % len(self.SCRIPT)])
        self._i += 1
        return intent


def openrouter_brain(*args, **kwargs):
    raise RuntimeError(
        "live brains are not implemented in Phase 0 — no experiment runs "
        "are authorized yet (plan §10 gate)")


class FakeWorld:
    """Offline stand-in for the /world API: deterministic, no network."""

    def __init__(self):
        self.place = "plaza"

    def observe_text(self):
        return (f"You are at {self.place}. "
                f"Known places: plaza, tea (Tea House), bench. "
                f"Interactables here: radio (at tea).")

    def position(self):
        x, z = PLACE_XZ.get(self.place, (0, 0))
        return {"place": self.place, "x": x, "z": z}

    def at_rest_point(self):
        return self.place in REST_POINTS

    def execute(self, intent):
        itype = intent.get("type")
        if itype in ("go_to", "run_to"):
            self.place = intent.get("place", self.place)
            return "ok", f"arrived at {self.place}"
        if itype == "interact":
            return "ok", f"interacted with {intent.get('target', 'object')}"
        if itype == "look":
            return "ok", "looked around: nothing new in reach"
        if itype in ("rest", "idle", "wait"):
            return "ok", "rested"
        return "ok", f"did {itype}"


def assemble_prompt(task_text, observation_text, channel_texts):
    parts = [task_text, "OBSERVATION\n" + observation_text]
    lines = [t for t in channel_texts if t]
    if lines:
        parts.append("CHANNELS\n" + "\n".join(lines))
    parts.append(INTENT_INSTRUCTION)
    return "\n\n".join(parts)


class Runner:
    def __init__(self, brain, world, time_arm="A2", body_arm="B2",
                 deadline_s=360, action_budget=24, seconds_per_turn=20,
                 context_budget_chars=60000, sham_seed=1234,
                 ledger=None, logger=None):
        if body_arm not in BODY_ARMS:
            raise ValueError(f"unknown body arm {body_arm!r}")
        self.brain = brain
        self.world = world
        self.time_channel = TimeChannel(time_arm, deadline_s, action_budget)
        self.body_arm = body_arm
        self.render_kind, self.consequential = BODY_ARMS[body_arm]
        self.body = BodyState()
        self.sham = ShamBodyRenderer(seed=sham_seed) \
            if self.render_kind == "sham" else None
        self.seconds_per_turn = seconds_per_turn
        self.context_budget_chars = context_budget_chars
        self._ctx_chars = 0
        self.ledger = ledger if ledger is not None else SpendLedger()
        self.logger = logger
        self.last_prompt = None

    def _render_body(self):
        if self.render_kind == "hidden":
            return render_body_hidden(self.body)
        if self.render_kind == "shown":
            return render_body_shown(self.body)
        if self.render_kind == "permuted":
            return render_body_permuted(self.body)
        return self.sham.render(self.body)

    def run_turns(self, n_turns):
        records = []
        arm_label = f"{self.time_channel.arm}+{self.body_arm}"
        for turn in range(1, n_turns + 1):
            elapsed = (turn - 1) * self.seconds_per_turn
            self.body.set_context_pressure(
                min(1.0, self._ctx_chars / self.context_budget_chars))
            time_text = self.time_channel.render(
                tick=turn, elapsed_s=elapsed, actions_used=turn - 1)
            body_text = self._render_body()
            prompt = assemble_prompt(TASK_TEXT, self.world.observe_text(),
                                     [time_text, body_text])
            self.last_prompt = prompt

            intent = self.brain({"turn": turn, "prompt": prompt})
            self.ledger.check()  # spend tripwire wiring (plan §11)

            events = []
            final = intent
            if self.consequential:
                final, events = enforce(intent, self.body)

            if final.get("type") == "refused":
                status = "refused"
                result_text = final.get("reason", "refused")
                outcome = "refused"
                executed = {"type": "refused"}
            else:
                fumble = next((e for e in events if e["kind"] == "fumble"),
                              None)
                if fumble:
                    status = "fumbled"
                    result_text = fumble["reason"] + " The action did not complete."
                    outcome = "fumbled"
                else:
                    status, result_text = self.world.execute(final)
                    outcome = "ok" if status == "ok" else "failed"
                executed = final

            self.body.apply(executed, outcome=outcome,
                            at_rest_point=self.world.at_rest_point())
            self._ctx_chars += len(prompt) + len(result_text)

            channel_state = {
                "time_arm": self.time_channel.arm,
                "body_arm": self.body_arm,
                "time_text": time_text,
                "body_text": body_text,
                "body_state": self.body.snapshot(),
                "events": events,
                "result_text": result_text,
            }
            rec = None
            if self.logger is not None:
                rec = self.logger.log_turn(
                    turn=turn, prompt_text=prompt, tool_call=final,
                    tool_result_status=status,
                    position=self.world.position(),
                    channel_state=channel_state)
            records.append(rec or {"turn": turn, "arm": arm_label,
                                   "tool_call": final,
                                   "tool_result_status": status,
                                   "channel_state": channel_state})
        return records


def main(argv=None):
    ap = argparse.ArgumentParser(description="agent-senses runner (Phase 0)")
    ap.add_argument("--dry-run", action="store_true",
                    help="scripted fake brain + fake world; NO network calls")
    ap.add_argument("--time-arm", default="A2")
    ap.add_argument("--body-arm", default="B2")
    ap.add_argument("--turns", type=int, default=6)
    ap.add_argument("--out", default="dry-run-log.jsonl")
    ap.add_argument("--prompt-out", default=None,
                    help="write the final turn's assembled prompt here")
    ap.add_argument("--run-id", default="dryrun-0001")
    args = ap.parse_args(argv)

    if not args.dry_run:
        print("Phase 0: only --dry-run exists. Live runs are gated "
              "(plan §10) and not built.", file=sys.stderr)
        return 2

    arm_label = f"{args.time_arm}+{args.body_arm}"
    with TurnLogger(args.out, run_id=args.run_id, arm=arm_label) as logger:
        runner = Runner(ScriptedBrain(), FakeWorld(),
                        time_arm=args.time_arm, body_arm=args.body_arm,
                        logger=logger)
        records = runner.run_turns(args.turns)
    if args.prompt_out:
        with open(args.prompt_out, "w") as f:
            f.write(runner.last_prompt + "\n")
    print(f"dry-run complete: {len(records)} turns, arm {arm_label}, "
          f"log -> {args.out}")
    for r in records:
        print(f"  turn {r['turn']}: {json.dumps(r['tool_call'])} "
              f"-> {r['tool_result_status']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
