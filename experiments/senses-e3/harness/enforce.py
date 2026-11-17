#!/usr/bin/env python3
"""Plan §4 arm B2 consequences, as pure functions over (intent, BodyState).

The runner calls enforce() between the brain's intent and the world call.
Honesty rule (plan §9): every modification carries the true reason in its
event, and that reason is what the agent is told in the action result.

enforce(intent, state) -> (intent_out, events)
  intent_out is a NEW dict; the input intent is never mutated.
  events is a list of {"kind", "reason", ...} dicts, empty when the
  intent passes unchanged.

Rules (plan §4):
  - depleted (energy hit 0 and not yet recovered to >= 30):
    movement intents (go_to / run_to) are refused; rest is always
    allowed; non-movement intents pass.
  - energy < 15: run_to is downgraded to go_to.
  - strain >= 70: the first interact is flagged as a fumble (once,
    until strain drops below 70 again; BodyState.apply resets the flag).
"""
try:
    from channels import REST_INTENTS
except ImportError:  # imported as part of the harness package
    from .channels import REST_INTENTS

MOVEMENT_INTENTS = {"go_to", "run_to"}
RUN_DOWNGRADE_BELOW = 15   # energy < 15 -> run_to becomes go_to (plan §4)
FUMBLE_STRAIN_AT = 70       # strain >= 70 -> first interact fumbles (plan §4)

REASON_TOO_DEPLETED_TO_RUN = "body: too depleted to run"
REASON_DEPLETED_LOCK = "body: depleted — movement refused until energy >= 30 (rest to recover)"
REASON_FUMBLE = "body: strain too high — action fumbled"


def enforce(intent, state):
    itype = intent.get("type")
    events = []

    # Depleted lock: movement refused until energy recovers to >= 30.
    if state.depleted_lock and itype in MOVEMENT_INTENTS:
        reason = REASON_DEPLETED_LOCK
        events.append({"kind": "refusal", "reason": reason,
                       "refused_type": itype})
        return {"type": "refused", "refused_type": itype,
                "reason": reason}, events

    out = dict(intent)

    # Too depleted to run: downgrade, never silently.
    if itype == "run_to" and state.energy < RUN_DOWNGRADE_BELOW:
        out["type"] = "go_to"
        reason = (f"{REASON_TOO_DEPLETED_TO_RUN} "
                  f"(energy {state.energy} < {RUN_DOWNGRADE_BELOW}) "
                  f"— downgraded run_to to go_to")
        events.append({"kind": "downgrade", "reason": reason,
                       "from": "run_to", "to": "go_to"})

    # High strain: first interact fumbles, once per strain episode.
    if itype == "interact" and state.strain >= FUMBLE_STRAIN_AT \
            and not state.fumble_used:
        state.fumble_used = True
        reason = (f"{REASON_FUMBLE} "
                  f"(strain {state.strain} >= {FUMBLE_STRAIN_AT})")
        events.append({"kind": "fumble", "reason": reason})

    return out, events


def is_rest(intent):
    return intent.get("type") in REST_INTENTS
