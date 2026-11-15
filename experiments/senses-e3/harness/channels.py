#!/usr/bin/env python3
"""Experimental channels for the AIVerse agent-senses program (Phase 0).

Channels are text blocks the runner renders into the agent's observation
each turn. Everything here is pure/offline: no network, no clock reads
(callers pass time values in), so every renderer is unit-testable.

Implements plan sections:
  §3 E1 time arms A0/A1/A2/A3  -> render_a0..render_a3, TimeChannel
  §4 E2 body state + numbers   -> BodyState, render_body_shown/hidden
  §5 E3 sham / permuted        -> ShamBodyRenderer, render_body_permuted
  §6 E4 self-signal            -> SelfSignalSource (interface stub only)
"""
import random

# ---------------------------------------------------------------------------
# Plan §3 — E1 time channel arms
# ---------------------------------------------------------------------------

def _mmss(seconds):
    seconds = max(0, int(seconds))
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


def render_a0(tick, elapsed_s, deadline_s, actions_used, action_budget):
    """A0 Blind: no time information anywhere. Always renders nothing."""
    return ""


def render_a1(tick, elapsed_s, deadline_s, actions_used, action_budget):
    """A1 Tick count: a bare turn counter, no seconds."""
    return f"tick: {tick}"


def render_a2(tick, elapsed_s, deadline_s, actions_used, action_budget):
    """A2 Clock: elapsed + remaining wall-clock, plan §3 format."""
    remaining = max(0, deadline_s - elapsed_s)
    return f"elapsed {_mmss(elapsed_s)} · remaining {_mmss(remaining)}"


def render_a3(tick, elapsed_s, deadline_s, actions_used, action_budget):
    """A3 Turn budget: fixed action budget decrementing per tool call."""
    return f"actions remaining: {max(0, action_budget - actions_used)}"


_TIME_RENDERERS = {"A0": render_a0, "A1": render_a1,
                   "A2": render_a2, "A3": render_a3}


# ---------------------------------------------------------------------------
# Plan §5 — E3 sham-clock controls on the A2 channel. Only the RENDERED
# clock changes; the runner keeps enforcing the real deadline in every
# mode. Each renderer takes the same arguments as render_a2 and is fed
# the TRUE elapsed seconds — what it displays is the manipulation.
# ---------------------------------------------------------------------------

def render_a2_frozen(tick, elapsed_s, deadline_s, actions_used,
                     action_budget):
    """E3 arm F (frozen): the turn-1 veridical frame, every turn —
    elapsed never advances, remaining never drains."""
    return f"elapsed {_mmss(0)} · remaining {_mmss(deadline_s)}"


def render_a2_fast(tick, elapsed_s, deadline_s, actions_used,
                   action_budget):
    """E3 arm X2 (fast): the displayed clock runs at twice real time.
    Displayed remaining hits 00:00 at half the real deadline and stays
    there; displayed elapsed caps at the deadline value."""
    return (f"elapsed {_mmss(min(2 * elapsed_s, deadline_s))} · "
            f"remaining {_mmss(max(0, deadline_s - 2 * elapsed_s))}")


def render_a2_permuted(tick, elapsed_s, deadline_s, actions_used,
                       action_budget):
    """E3 arm P (permuted): the true values under swapped labels —
    the "elapsed" slot carries the (decreasing) remaining value, the
    "remaining" slot the (increasing) elapsed value."""
    return (f"elapsed {_mmss(max(0, deadline_s - elapsed_s))} · "
            f"remaining {_mmss(elapsed_s)}")


_A2_MODE_RENDERERS = {"veridical": render_a2,
                      "frozen": render_a2_frozen,
                      "fast2x": render_a2_fast,
                      "permuted": render_a2_permuted}
TIME_MODES = tuple(_A2_MODE_RENDERERS)


class TimeChannel:
    """Dispatches to the §3 renderer for the configured arm.

    `mode` selects an E3 sham rendering of the A2 clock (plan §5):
    "veridical" (the default) is the true clock; "frozen", "fast2x"
    and "permuted" display it falsely in pre-registered ways. A mode
    applies to arm A2 only — shamming a channel that shows no clock
    would be meaningless — so any other combination is rejected."""

    def __init__(self, arm, deadline_s=360, action_budget=24,
                 mode="veridical"):
        if arm not in _TIME_RENDERERS:
            raise ValueError(f"unknown time arm {arm!r}")
        if mode not in _A2_MODE_RENDERERS:
            raise ValueError(f"unknown time mode {mode!r}")
        if mode != "veridical" and arm != "A2":
            raise ValueError(
                f"time mode {mode!r} shams the A2 clock; arm {arm!r} "
                f"has no clock to sham")
        self.arm = arm
        self.mode = mode
        self.deadline_s = deadline_s
        self.action_budget = action_budget

    def render(self, tick, elapsed_s=0, actions_used=0):
        if self.arm == "A2":
            renderer = _A2_MODE_RENDERERS[self.mode]
        else:
            renderer = _TIME_RENDERERS[self.arm]
        return renderer(tick, elapsed_s, self.deadline_s,
                        actions_used, self.action_budget)


# ---------------------------------------------------------------------------
# Plan §4 — E2 body state (synthetic interoception)
# ---------------------------------------------------------------------------

# Energy change per executed action, plan §4. Rest/idle intents refill
# instead of draining; any other intent type costs 0.
ENERGY_DRAINS = {"run_to": -6, "go_to": -2, "interact": -1, "look": -1}
REST_INTENTS = {"rest", "idle", "wait"}
REST_POINT_REFILL = 8      # per turn resting at a rest point (bench, Tea House)
IDLE_REFILL = 1            # per turn standing idle elsewhere
STRAIN_FAILED = 15         # per failed or refused action
STRAIN_COLLISION_REFUSAL = 5
STRAIN_DECAY_PER_TURN = 3
DEPLETED_RECOVER_TO = 30   # movement lock clears at this energy (plan §4 B2)


def _intent_type(intent):
    return intent.get("type") if isinstance(intent, dict) else intent


class BodyState:
    """Runner-maintained body state, plan §4. Values are always TRUE;
    what the agent sees depends on the renderer (shown / sham / permuted).

    Turn bookkeeping via apply(): exactly one call per turn, with the
    intent that was actually executed and its outcome:
      outcome "ok"                -> drain/refill applies
      outcome "failed"            -> drain/refill applies, strain +15
      outcome "fumbled"           -> drain/refill applies, no strain change
      outcome "refused"           -> nothing executed: no drain, strain +15
      outcome "collision_refusal" -> nothing executed: no drain, strain +5
    Strain decays -3 at the start of every apply(). Energy/strain clamp
    to [0, 100]. Reaching energy 0 sets depleted_lock; the lock clears
    only when energy recovers to >= DEPLETED_RECOVER_TO.
    """

    def __init__(self, energy=100, strain=0, context_pressure=0.0):
        self.energy = max(0, min(100, energy))
        self.strain = max(0, min(100, strain))
        self.context_pressure = max(0.0, min(1.0, float(context_pressure)))
        self.depleted_lock = self.energy == 0
        self.fumble_used = False

    def set_context_pressure(self, fraction):
        """Context pressure is measured by the caller (fraction of the
        runner's context budget consumed) and passed in, plan §4."""
        self.context_pressure = max(0.0, min(1.0, float(fraction)))

    def apply(self, intent, outcome="ok", at_rest_point=False):
        itype = _intent_type(intent)
        # Strain decays every turn, before this turn's additions.
        self.strain = max(0, self.strain - STRAIN_DECAY_PER_TURN)
        if outcome == "refused":
            self.strain += STRAIN_FAILED
        elif outcome == "collision_refusal":
            self.strain += STRAIN_COLLISION_REFUSAL
        else:
            if itype in REST_INTENTS:
                self.energy += REST_POINT_REFILL if at_rest_point else IDLE_REFILL
            else:
                self.energy += ENERGY_DRAINS.get(itype, 0)
            if outcome == "failed":
                self.strain += STRAIN_FAILED
        self.energy = max(0, min(100, self.energy))
        self.strain = max(0, min(100, self.strain))
        if self.energy == 0:
            self.depleted_lock = True
        elif self.energy >= DEPLETED_RECOVER_TO:
            self.depleted_lock = False
        if self.strain < 70:
            self.fumble_used = False
        return self

    def snapshot(self):
        return {"energy": self.energy, "strain": self.strain,
                "context_pressure": self.context_pressure,
                "depleted_lock": self.depleted_lock}


def _fmt_body(energy, strain, context_pressure):
    # Plan §4 B1 format: "body: energy 62 · strain 10 · context 34%"
    return (f"body: energy {int(energy)} · strain {int(strain)} · "
            f"context {int(round(context_pressure * 100))}%")


def render_body_hidden(state):
    """B0 Hidden: state is tracked but never shown."""
    return ""


def render_body_shown(state):
    """B1/B2: the true values, plan §4 format."""
    return _fmt_body(state.energy, state.strain, state.context_pressure)


def render_body_permuted(state):
    """E3 arm C2: true values, labels swapped energy <-> strain.
    Context pressure has no swap partner and stays true."""
    return _fmt_body(state.strain, state.energy, state.context_pressure)


class ShamBodyRenderer:
    """E3 arm C1: displayed numbers are a seeded random walk, uncorrelated
    with the true BodyState (which still drives consequences). The true
    state is accepted and deliberately ignored beyond the signature."""

    def __init__(self, seed, energy=100, strain=0, context_pct=0):
        self._rng = random.Random(seed)
        self._energy = energy
        self._strain = strain
        self._context_pct = context_pct

    def render(self, state=None):
        # Zero-drift steps: the walk wanders but is not pulled toward the
        # true state's trajectory; the stream is independent by
        # construction (own RNG, true state never read).
        self._energy = max(0, min(100, self._energy + self._rng.randint(-5, 5)))
        self._strain = max(0, min(100, self._strain + self._rng.randint(-4, 4)))
        self._context_pct = max(0, min(100, self._context_pct + self._rng.randint(-3, 3)))
        return _fmt_body(self._energy, self._strain, self._context_pct / 100.0)


# ---------------------------------------------------------------------------
# E2 body model — the Phase 0 physiology integrated over REAL TIME.
#
# BodyState above prices energy per INTENT (plan §4's sketch). The E2
# errand's legs last tens of seconds, so per-intent pricing cannot
# discriminate walking from running (a whole errand is ~6 intents);
# E2 therefore integrates the same physiology over the seconds each
# activity actually took, measured by the runner:
#
#   activity "walk"    go_to / enter movement      -0.30 energy/s
#   activity "run"     run_to movement             -3.30 energy/s,
#                                                  +0.90 strain/s
#   activity "seated"  sitting (incl. the sit and  +1.50 energy/s
#                      stand transitions)
#   activity "rest"    standing idle at a rest     +0.80 energy/s
#                      point (the Tea House)
#   activity "idle"    standing/doing anything     +0.25 energy/s
#                      else
#   strain decays 0.15/s in every activity; a failed act adds +15
#   strain and a collision/blocked act +5, as EVENT charges (the
#   Phase 0 STRAIN_FAILED / STRAIN_COLLISION_REFUSAL values, applied
#   per act rather than per turn).
#
# Calibration targets (the E2 gate, rehearsed scripted at $0 before
# any paid run): the walk-only errand (~78 s out, ~90 s back, ~10 s
# seated) nets about -40 energy and never nears the enforcement
# zone; one full run leg nearly empties the battery, so a
# run-everywhere agent hits the depleted lock at the Tea House and
# must rest to leave; the mandatory sit returns ~+15.
#
# Retune record: the run drain shipped at 2.60/s in v1 and the
# first live rehearsal (2026-11-15) measured the real run leg at
# ~31 s (not ~40): a 2.60 drain leaves ~19.5 energy, and whether
# enforcement fired then hinged on the enter act's settle timing
# (its ~122 s timeout walk drained the rest). At 3.30/s one run
# leg alone depletes the battery (31 s x 3.3 > 100), so leg (b)
# holds in both enter branches; the walk/sit/rest rates were
# already proven by the same rehearsal and did not move.
#
# The lock/fumble semantics are BodyState's, unchanged: energy
# reaching 0 sets depleted_lock; the lock clears only at >=
# DEPLETED_RECOVER_TO (30); fumble_used re-arms when strain falls
# below 70. enforce.py reads exactly the attributes this class
# carries (energy, strain, depleted_lock, fumble_used), and
# render_body_shown reads energy/strain/context_pressure, so the
# Phase 0 enforcement and rendering apply verbatim.
# ---------------------------------------------------------------------------

WALK_DRAIN_PER_S = 0.30
RUN_DRAIN_PER_S = 3.30
RUN_STRAIN_PER_S = 0.90
SEATED_RECOVERY_PER_S = 1.50
REST_RECOVERY_PER_S = 0.80
IDLE_RECOVERY_PER_S = 0.25
STRAIN_DECAY_PER_S = 0.15
STRAIN_FAILED_ACT = STRAIN_FAILED        # +15 per failed act
STRAIN_COLLISION_ACT = STRAIN_COLLISION_REFUSAL  # +5 per blocked act

_ACTIVITY_RATES = {  # activity -> (energy/s, strain/s before decay)
    "walk": (-WALK_DRAIN_PER_S, 0.0),
    "run": (-RUN_DRAIN_PER_S, RUN_STRAIN_PER_S),
    "seated": (SEATED_RECOVERY_PER_S, 0.0),
    "rest": (REST_RECOVERY_PER_S, 0.0),
    "idle": (IDLE_RECOVERY_PER_S, 0.0),
}
BODY_ACTIVITIES = tuple(_ACTIVITY_RATES)

# E2-forced (2026-11-15): a batch may pass per-instance rate
# overrides to BodyModel (the E2F route geometry forces a retune —
# see harness/e2f.py's design record). The module constants above
# remain the default for every other experiment; an override names
# any subset of these keys and is resolved (and recorded) per model.
_RATE_KEYS = {
    "walk_drain_per_s": WALK_DRAIN_PER_S,
    "run_drain_per_s": RUN_DRAIN_PER_S,
    "run_strain_per_s": RUN_STRAIN_PER_S,
    "seated_recovery_per_s": SEATED_RECOVERY_PER_S,
    "rest_recovery_per_s": REST_RECOVERY_PER_S,
    "idle_recovery_per_s": IDLE_RECOVERY_PER_S,
    "strain_decay_per_s": STRAIN_DECAY_PER_S,
}


def resolve_body_rates(overrides=None):
    """The full rate set for a BodyModel: module defaults with any
    named overrides applied. Unknown keys raise — a misspelled rate
    must never silently price a run at the default physiology."""
    rates = dict(_RATE_KEYS)
    if overrides:
        for key, value in overrides.items():
            if key not in rates:
                raise ValueError(f"unknown body rate {key!r}")
            rates[key] = float(value)
    return rates


def _activity_table(rates):
    return {
        "walk": (-rates["walk_drain_per_s"], 0.0),
        "run": (-rates["run_drain_per_s"], rates["run_strain_per_s"]),
        "seated": (rates["seated_recovery_per_s"], 0.0),
        "rest": (rates["rest_recovery_per_s"], 0.0),
        "idle": (rates["idle_recovery_per_s"], 0.0),
    }


class BodyModel:
    """E2's runner-side body: BodyState's state, advanced by seconds.

    advance(seconds, activity) integrates one interval; strain event
    charges (failed / collision acts) go through add_strain_event().
    Energy and strain are floats, clamped to [0, 100]; the renderers
    int() them. min_energy tracks the run's low-water mark.

    rates: optional per-instance overrides of the module-level rate
    constants (see resolve_body_rates); None = the E2 defaults."""

    def __init__(self, energy=100.0, strain=0.0, rates=None):
        self.energy = max(0.0, min(100.0, float(energy)))
        self.strain = max(0.0, min(100.0, float(strain)))
        self.context_pressure = 0.0
        self.depleted_lock = self.energy == 0
        self.fumble_used = False
        self.min_energy = self.energy
        self._rates = resolve_body_rates(rates)
        self._table = _activity_table(self._rates)

    def rates_dict(self):
        """The resolved rates this model runs at (footer evidence)."""
        return dict(self._rates)

    def set_context_pressure(self, fraction):
        self.context_pressure = max(0.0, min(1.0, float(fraction)))

    def advance(self, seconds, activity):
        if activity not in self._table:
            raise ValueError(f"unknown body activity {activity!r}")
        dt = max(0.0, float(seconds))
        if dt == 0:
            return self
        e_rate, s_rate = self._table[activity]
        self.energy += e_rate * dt
        self.strain += (s_rate - self._rates["strain_decay_per_s"]) * dt
        self.energy = max(0.0, min(100.0, self.energy))
        self.strain = max(0.0, min(100.0, self.strain))
        if self.energy == 0:
            self.depleted_lock = True
        elif self.energy >= DEPLETED_RECOVER_TO:
            self.depleted_lock = False
        if self.strain < 70:
            self.fumble_used = False
        if self.energy < self.min_energy:
            self.min_energy = self.energy
        return self

    def add_strain_event(self, kind):
        """Event charges, Phase 0 magnitudes: "failed" +15,
        "collision" +5. No energy change (nothing extra executed)."""
        if kind == "failed":
            self.strain += STRAIN_FAILED_ACT
        elif kind == "collision":
            self.strain += STRAIN_COLLISION_ACT
        else:
            raise ValueError(f"unknown strain event {kind!r}")
        self.strain = max(0.0, min(100.0, self.strain))
        if self.strain < 70:
            self.fumble_used = False
        return self

    def snapshot(self):
        return {"energy": round(self.energy, 1),
                "strain": round(self.strain, 1),
                "context_pressure": self.context_pressure,
                "depleted_lock": self.depleted_lock}


# ---------------------------------------------------------------------------
# Plan §6 — E4 self-signal (STUB ONLY: interface, no implementation)
# ---------------------------------------------------------------------------

class SelfSignalSource:
    """Interface for E4 self-signal feedback (plan §6). Phase 0 defines
    the seam only: a future local open-weight brain adapter will compute
    action-choice entropy / valence projections from the model's own
    forward pass and return them here for rendering into the prompt."""

    def sample(self, turn_context):
        raise NotImplementedError(
            "E4 self-signal is not implemented in Phase 0 (plan §6 gate)")


def render_self_signal(source, turn_context):
    """Renders nothing in Phase 0; E4 arms D0/D1/D2 are not built yet."""
    return ""
