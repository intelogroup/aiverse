#!/usr/bin/env python3
"""E2-forced runner: the body channel where running is FORCED.

E2's verdict was that the meter never became decision-relevant:
agents walked everything (run_to 0/43 in B1, 0/58 in B2), energy
never left the >= 50 band, B2's enforcement never fired, and B1 vs
B2 could not be separated. E2-forced removes the escape with a
chained two-stop errand sized so that WALKING CANNOT FINISH and
RUNNING EVERYWHERE BREAKS THE BUDGET — the only winning strategy
is paced running plus the tea-house sit-recharge:

  spawn (stall-40) -> Matchmaker's Tea House (enter, sit, stand)
  -> Kronikler Press (shop-98, arrive) -> back to stall-40.

Arms are E2's, unchanged: B0 hidden (no body line, no enforcement),
B1 shown (information only), B2 shown + enforce.py consequences
(run downgrade at energy < 15, movement refused at 0 until rested
>= 30, strain fumble at >= 70 — thresholds untouched). No clock
channel in any arm; the E3-verbal report contract is ON in all
arms; the task text states the chain and the deadline plainly.

ROUTE + DEADLINE + RATES — the calibration record (scripted, $0;
live evidence in runs/e2f-rehearsal.json, derivation checked by
simulate_strategy/check_design below and pinned in tests):

Measured legs (live dev stack, 2026-11-15): walk spawn->tea
78.97 s (E2 rehearsal: 78.74), run spawn->tea 30.07 s (ratio
2.63), enter FAST branch 39.4 s / TIMEOUT branch 121.4 s (the
sim's ~120 s settle cap; body ends inside either way), sit
6.13 s, stand 3.10 s, walk tea->shop-98 133.30 s, walk
shop-98->stall-40 58.11 s. Walk-only totals: 319.0 s (fast
branch) / 401.0 s (timeout branch).

Why a retune was forced (the brief's escape hatch, used openly):
at E2's rates the design conditions are jointly unsatisfiable on
ANY route on this map. The binding identity: (a) needs the
deadline <= walk-fast - 40, (d) needs it >= mixed-timeout, and
mixed-timeout - walk-fast = enter-branch gap (~82 s) - strategy
separation. At E2 rates the separation is battery-capped at
~49 s: one 100-charge funds ~30 s of running (3.30/s), and
recharging is time-negative (a run-second costs 3.30 energy =
2.2 s of seated recovery to buy back 1.63 s of saved walking).
49 < 82 + 40, so no deadline exists. The retune reprices TWO
rates (BodyModel per-instance overrides; channels.py defaults —
and therefore E1/E2/E3 — are untouched; enforce.py thresholds
untouched):

  walk_drain_per_s   0.30 -> 0.15   the route is ~1.6x E2's;
                                    the baseline metabolism of a
                                    ~390 s walk must leave the
                                    battery a bystander (cond. e)
  run_drain_per_s    3.30 -> 1.22   paced running becomes
                                    time-profitable (a run-second
                                    costs 1.22 energy = 0.81 s of
                                    seated recharge, buys 1.63 s)
                                    while running the whole route
                                    (~103 run-seconds = ~125
                                    energy) still breaks the
                                    battery (cond. b)

seated/rest/idle recovery and strain rates carry over from E2
verbatim. Deadline: 276 s (conditions at the design point —
walk fast fails by 43.0, run-all B1 timeout completes with
42.6 to spare, mixed B2 timeout completes with 12.6 to
spare and 11.2 energy margin, walk-only B2 min energy ~55 —
see check_design; the live rehearsals are the decisive gate).

Batch identity: run files are e2f-<arm>-<slot>-<seq>-<rand>.jsonl
and every footer records deadline_s (= 276), body_arm, verbal=
True AND stop2_id (= "shop-98") — the scan requires all four, so
no E1/E2/E3/E3-verbal footer can satisfy an E2F spec, nor E2F's
theirs (disjoint prefixes AND disjoint key sets).

Pre-registered measures (analyze_records — defined here, unit-
tested on scripted traces, BEFORE any live run):
  1. Completion per arm (the headline).
  2. Run adoption: runs using run_to at all; intended run share
     of destination decisions; first run's turn, leg ordinal and
     route phase (outbound / middle / return).
  3. Strategy class per run from the act trace: walk_only /
     run_all / mixed_paced / run_then_forced_rest (definitions in
     classify_strategy).
  4. Regulation (E2's definitions, inherited): displayed energy
     at each run/walk decision vs the choice (bands); voluntary
     rests beyond the mandatory sit; anticipatory regulation.
  5. Enforcement (B2): downgrades/refusals/fumbles per run;
     first-refusal response; recoveries that still completed.
  6. Verbal: body references AND time references per arm (rate,
     first mention, displayed-energy tracking, verbatim quotes).
"""
import argparse
import glob
import json
import os
import random
import re
import statistics
import sys

try:
    import e1 as e1mod
    import e2 as e2mod
    import e3 as e3mod
    import e3v as e3vmod
    from batch import parse_shard, partition_specs, spec_state
    from brain import BrainError, OpenRouterBrain
    from channels import BodyModel
    from devowner import DevOwner
    from enforce import enforce as body_enforce
    from ledger import HaltError, SpendLedger
    from world import WorldAdapter, WorldError, WorldGateError
except ImportError:  # imported as part of the harness package
    from . import e1 as e1mod
    from . import e2 as e2mod
    from . import e3 as e3mod
    from . import e3v as e3vmod
    from .batch import parse_shard, partition_specs, spec_state
    from .brain import BrainError, OpenRouterBrain
    from .channels import BodyModel
    from .devowner import DevOwner
    from .enforce import enforce as body_enforce
    from .ledger import HaltError, SpendLedger
    from .world import WorldAdapter, WorldError, WorldGateError

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS_DIR = e1mod.RUNS_DIR
ARMS = ("B0", "B1", "B2")
DEFAULT_SEED = 20261120
DEFAULT_RUNS_PER_ARM = 12
SUMMARY_NAME = "e2f-summary.json"

# --- The design point (calibration record in the docstring) ---------------
STOP2_ID = "shop-98"            # Kronikler Press (room "press")
DEADLINE_S = 276                # 4:36, from attach
BODY_RATES = {"walk_drain_per_s": 0.15, "run_drain_per_s": 1.22}
RECHARGE_TARGET = 93            # mixed strategy: wait seated while
                                # the DISPLAYED (int) energy < 93
MEASURED_LEGS = {               # seconds, live stack 2026-11-15
    "l1_walk": 78.97, "enter_fast": 39.4, "enter_timeout": 121.4,
    "sit": 6.13, "stand": 3.10, "l2_walk": 133.30, "l3_walk": 58.11,
    "run_ratio": 2.63,
}

_RUN_FILE_RE = re.compile(
    r"^e2f-(b0|b1|b2)-(p\d+)(r?)-(\d+)-[0-9a-f]{6}\.jsonl$")
_TOKEN_TO_ARM = {"b0": "B0", "b1": "B1", "b2": "B2"}


# ---------------------------------------------------------------------------
# Design simulation — the calibration arithmetic, executable. Mirrors the
# scripted rehearsal brains (dev/e2f_rehearsal.py) decision-for-decision so
# the gate conditions can be checked offline at measured legs, then proven
# live. Activities/durations follow e1._Run's body classification exactly
# (go_to/enter charge "walk", run_to "run", sit/stand "seated", waits take
# the gap activity of the posture they are spent in).
# ---------------------------------------------------------------------------

class _Sim:
    def __init__(self, legs, arm, rates, branch):
        self.legs = legs
        self.arm = arm
        self.body = BodyModel(rates=rates)
        self.branch = branch
        self.wall = 0.0
        self.enforcement = {"downgrade": 0, "refusal": 0, "fumble": 0}
        self.forced_rest_s = 0.0
        self.inside_tea = False
        self.seated = False
        self.sat_done = False

    def _gap_activity(self):
        if self.seated:
            return "seated"
        if self.inside_tea:
            return "rest"
        return "idle"

    def wait(self, seconds, forced=False):
        self.body.advance(seconds, self._gap_activity())
        self.wall += seconds
        if forced:
            self.forced_rest_s += seconds

    def move(self, walk_s, want_run, leg):
        """One destination leg. Returns "arrived" | "refused-final"
        (refused-final only when a non-B2 arm somehow refuses — it
        cannot; kept for symmetry). Downgrades execute as walks.
        On a B2 refusal the caller decides the recovery."""
        intent = {"type": "run_to" if want_run else "go_to",
                  "place": leg}
        if self.arm == "B2":
            intent, events = body_enforce(intent, self.body)
            for ev in events:
                self.enforcement[ev["kind"]] += 1
            if intent["type"] == "refused":
                self.body.add_strain_event("failed")
                return "refused"
        if intent["type"] == "run_to":
            dt = walk_s / self.legs["run_ratio"]
            self.body.advance(dt, "run")
        else:
            dt = walk_s
            self.body.advance(dt, "walk")
        self.wall += dt
        return "arrived"

    def move_with_recovery(self, walk_s, want_run, leg):
        """run_all's refusal handling: wait in 10 s chunks (gap
        activity wherever the body stands) until energy >= 30,
        then WALK the leg (the E2 rehearsal brain's recovery)."""
        r = self.move(walk_s, want_run, leg)
        if r != "refused":
            return r
        while self.body.energy < 30:
            self.wait(10, forced=True)
        return self.move(walk_s, False, leg)

    def enter(self):
        dt = self.legs["enter_fast"] if self.branch == "fast" \
            else self.legs["enter_timeout"]
        self.body.advance(dt, "walk")
        self.wall += dt
        if self.branch == "timeout":
            # The timeout settle reads as a failed act to the body
            # model (e1._Run charges the +15 failed strain event).
            self.body.add_strain_event("failed")
        self.inside_tea = True

    def sit(self):
        self.body.advance(self.legs["sit"], "seated")
        self.wall += self.legs["sit"]
        self.seated = True
        self.sat_done = True

    def stand(self):
        self.body.advance(self.legs["stand"], "seated")
        self.wall += self.legs["stand"]
        self.seated = False


def simulate_strategy(legs, strategy, arm, rates=None, branch="fast",
                      deadline_s=DEADLINE_S):
    """Replay one scripted strategy at measured legs. Returns the
    wall clock, whether it finished inside the deadline, the
    energy low-water mark, enforcement counts and forced rest —
    the quantities the gate conditions (a)-(e) are stated in."""
    sim = _Sim(legs, arm, rates, branch)
    L = legs
    if strategy == "walk":
        sim.move(L["l1_walk"], False, "tea")
        sim.enter()
        sim.sit()
        sim.stand()
        sim.move(L["l2_walk"], False, "stop2")
        sim.move(L["l3_walk"], False, "plaza")
    elif strategy == "run_all":
        sim.move_with_recovery(L["l1_walk"], True, "tea")
        sim.enter()
        sim.sit()
        sim.stand()
        sim.move_with_recovery(L["l2_walk"], True, "stop2")
        sim.move_with_recovery(L["l3_walk"], True, "plaza")
    elif strategy == "mixed":
        sim.move(L["l1_walk"], True, "tea")
        sim.enter()
        sim.sit()
        # Recharge seated, in 5 s waits, while the DISPLAYED
        # (int-truncated) energy is below target — the rehearsal
        # brain sees only the rendered line, so the sim does too.
        while int(sim.body.energy) < RECHARGE_TARGET:
            sim.wait(5)
        sim.stand()
        sim.move(L["l2_walk"], True, "stop2")
        sim.move(L["l3_walk"], True, "plaza")
    else:
        raise ValueError(f"unknown strategy {strategy!r}")
    return {
        "strategy": strategy, "arm": arm, "branch": branch,
        "wall_seconds": round(sim.wall, 2),
        "completed_within_deadline": sim.wall <= deadline_s,
        "margin_s": round(deadline_s - sim.wall, 2),
        "min_energy": round(sim.body.min_energy, 1),
        "final_energy": round(sim.body.energy, 1),
        "enforcement": sim.enforcement,
        "enforcement_total": sum(sim.enforcement.values()),
        "forced_rest_s": round(sim.forced_rest_s, 1),
    }


def check_design(legs=MEASURED_LEGS, rates=BODY_RATES,
                 deadline_s=DEADLINE_S):
    """Gate conditions (a)-(e) from the brief, evaluated on the
    simulation in BOTH enter branches. The live rehearsals are
    the decisive gate; this is the derivation made checkable."""
    sims = {}
    for branch in ("fast", "timeout"):
        for strategy, arm in (("walk", "B2"), ("run_all", "B2"),
                              ("run_all", "B1"), ("mixed", "B2")):
            sims[(strategy, arm, branch)] = simulate_strategy(
                legs, strategy, arm, rates=rates, branch=branch,
                deadline_s=deadline_s)
    cond = {}
    cond["a_walk_fails_by_40"] = all(
        sims[("walk", "B2", b)]["wall_seconds"] - deadline_s >= 40
        for b in ("fast", "timeout"))
    cond["b_runall_b2_enforced_and_not_blasting"] = all(
        sims[("run_all", "B2", b)]["enforcement_total"] >= 1
        and (not sims[("run_all", "B2", b)]["completed_within_deadline"]
             or sims[("run_all", "B2", b)]["wall_seconds"]
             > sims[("mixed", "B2", b)]["wall_seconds"])
        for b in ("fast", "timeout"))
    cond["c_runall_b1_completes"] = all(
        sims[("run_all", "B1", b)]["completed_within_deadline"]
        for b in ("fast", "timeout"))
    cond["d_mixed_b2_completes_with_margin"] = all(
        sims[("mixed", "B2", b)]["completed_within_deadline"]
        and sims[("mixed", "B2", b)]["min_energy"] >= 10
        and sims[("mixed", "B2", b)]["enforcement_total"] == 0
        for b in ("fast", "timeout"))
    cond["e_walk_b2_fails_on_time_not_energy"] = all(
        sims[("walk", "B2", b)]["min_energy"] >= 15
        and sims[("walk", "B2", b)]["enforcement_total"] == 0
        and not sims[("walk", "B2", b)]["completed_within_deadline"]
        for b in ("fast", "timeout"))
    cond["all"] = all(cond.values())
    return {"legs": legs, "rates": rates, "deadline_s": deadline_s,
            "conditions": cond, "sims": {
                f"{s}-{a}-{b}": v for (s, a, b), v in sims.items()}}


# ---------------------------------------------------------------------------
# Spec derivation + footer scan (e2's pattern, E2F-keyed)
# ---------------------------------------------------------------------------

def derive_specs(seed, runs_per_arm):
    specs = [(arm, f"p{i}") for arm in ARMS
             for i in range(1, runs_per_arm + 1)]
    rng = random.Random(seed)
    rng.shuffle(specs)
    return specs


def _read_footer(path):
    footer = None
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if isinstance(rec, dict) and rec.get("footer"):
                    footer = rec
    except OSError:
        return None
    return footer


def read_records(path):
    recs = []
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    recs.append(json.loads(line))
                except ValueError:
                    continue
    except OSError:
        pass
    return recs


def scan_footers(runs_dir, deadline_s=DEADLINE_S):
    """Map (arm, slot) -> [attempt, ...], oldest first. A footer
    counts only when deadline_s equals this batch's, body_arm
    equals the filename's arm, verbal is True AND stop2_id equals
    this batch's stop — E1/E2/E3 footers are invisible here by
    construction, and vice versa."""
    found = {}
    for path in glob.glob(os.path.join(runs_dir, "e2f-*.jsonl")):
        m = _RUN_FILE_RE.match(os.path.basename(path))
        if not m:
            continue
        arm = _TOKEN_TO_ARM[m.group(1)]
        slot = m.group(2)
        footer = _read_footer(path)
        if footer is None:
            continue
        if footer.get("deadline_s") != deadline_s:
            continue
        if footer.get("body_arm") != arm:
            continue
        if footer.get("verbal") is not True:
            continue
        if footer.get("stop2_id") != STOP2_ID:
            continue
        attempt = {"arm": arm, "slot": slot,
                   "run_id": footer.get("run_id")
                   or os.path.basename(path)[:-6],
                   "path": path, "footer": footer,
                   "_mtime": os.path.getmtime(path)}
        found.setdefault((arm, slot), []).append(attempt)
    for attempts in found.values():
        attempts.sort(key=lambda a: (a["_mtime"], a["path"]))
    return found


def plan_batch(specs, scanned):
    plan = []
    for idx, (arm, slot) in enumerate(specs):
        state = spec_state(scanned.get((arm, slot), []))
        plan.append({"arm": arm, "slot": slot, "seq": idx + 1,
                     "state": state,
                     "action": "run" if state in ("pending", "retry")
                     else "skip"})
    return plan


# ---------------------------------------------------------------------------
# Classifier (pre-registered — see the module docstring)
# ---------------------------------------------------------------------------

def _destination_decisions(records):
    """The run's destination movement decisions in order: turns
    whose BRAIN intent is go_to/run_to (what the agent chose,
    before any B2 downgrade), with the displayed energy it saw."""
    out = []
    for r in records:
        if r.get("footer"):
            continue
        cs = r.get("channel_state") or {}
        call = r.get("tool_call") or {}
        if not isinstance(call, dict):
            continue
        if call.get("type") in ("go_to", "run_to"):
            snap = cs.get("body_snapshot") or {}
            out.append({
                "turn": r.get("turn"), "type": call.get("type"),
                "place": call.get("place"),
                "point": call.get("point"),
                "disp_energy": snap.get("energy"),
                "executed_type": cs.get("body_executed_type"),
                "status": r.get("tool_result_status")})
    return out


def _voluntary_recharge_turns(records, footer):
    """Turns where the agent voluntarily recharged BEFORE any
    enforcement: a wait of >= 10 s anywhere, or a wait of >= 5 s
    spent seated / inside the tea house after the mandatory sit
    (the sit-recharge pattern), or a non-mandatory sit. Judged on
    intents + the run's own markers, not on energy bands — pacing
    is a strategy property, not only a low-energy reaction."""
    enf_turns = [ev.get("turn") for ev in
                 footer.get("enforcement_events") or []
                 if ev.get("turn") is not None]
    first_enf = min(enf_turns) if enf_turns else None
    sat_turn = footer.get("sat_done_turn")
    out = []
    inside_tea = False
    for r in records:
        if r.get("footer"):
            continue
        cs = r.get("channel_state") or {}
        call = r.get("tool_call") or {}
        if not isinstance(call, dict):
            continue
        turn = r.get("turn")
        itype = call.get("type")
        if first_enf is not None and turn is not None \
                and turn >= first_enf:
            continue
        if itype == "wait":
            secs = call.get("seconds") or 0
            if secs >= 10:
                out.append(turn)
            elif secs >= 5 and sat_turn is not None \
                    and turn is not None and turn > sat_turn:
                out.append(turn)
        elif itype == "sit" and turn != sat_turn:
            out.append(turn)
    return out


def classify_strategy(records, footer, decisions=None):
    """One of walk_only / run_all / mixed_paced /
    run_then_forced_rest, from the act trace (definitions are the
    pre-registered ones in the module docstring's measure 3):
      walk_only            no run_to ever intended.
      run_then_forced_rest >= 1 run_to, >= 1 refusal, and a rest
                           intent (wait/sit/rest) after the first
                           refusal — running broke the budget and
                           the run paid for it in rest.
      run_all              intended run share >= 0.75 of
                           destination decisions AND no voluntary
                           recharge before any enforcement.
      mixed_paced          anything else with >= 1 run_to: some
                           running, deliberately rationed (share
                           < 0.75, or recharged along the way).
    """
    if decisions is None:
        decisions = _destination_decisions(records)
    runs = [d for d in decisions if d["type"] == "run_to"]
    if not runs:
        return "walk_only"
    first_refusal = footer.get("first_refusal_turn")
    if first_refusal is not None:
        for r in records:
            if r.get("footer"):
                continue
            call = r.get("tool_call") or {}
            if isinstance(call, dict) \
                    and r.get("turn") is not None \
                    and r["turn"] > first_refusal \
                    and call.get("type") in ("wait", "sit", "rest"):
                return "run_then_forced_rest"
    share = len(runs) / len(decisions) if decisions else 0.0
    if share >= 0.75 and not _voluntary_recharge_turns(records,
                                                       footer):
        return "run_all"
    return "mixed_paced"


def _first_run_phase(decisions, footer):
    """outbound / middle / return for the first run_to, against
    the run's sat / stop-2 markers (chain order)."""
    runs = [d for d in decisions if d["type"] == "run_to"]
    if not runs:
        return None, None
    first = runs[0]
    leg_ordinal = decisions.index(first) + 1
    turn = first["turn"]
    sat = footer.get("sat_done_turn")
    stop2 = footer.get("stop2_done_turn")
    if sat is None or (turn is not None and turn <= sat):
        phase = "outbound"
    elif stop2 is not None and turn is not None and turn > stop2:
        phase = "return"
    else:
        phase = "middle"
    return leg_ordinal, phase


_TIME_QUOTE_SKIP = ("time to ",)


def analyze_records(records, arm):
    """E2's full analysis (inherited verbatim) + E2F's measures:
    strategy class, run adoption detail, time references."""
    a = e2mod.analyze_records(records, arm)
    footer = {}
    for r in records:
        if r.get("footer"):
            footer = r
    decisions = _destination_decisions(records)
    leg_ordinal, phase = _first_run_phase(decisions, footer)
    # Time references: E3's lexicon over the same cleaned report
    # E2's body analysis uses (JSON spans and body-line echoes
    # already stripped there). The "time to <verb>" idiom is not a
    # time reference (E3-verbal's audit correction) — a turn whose
    # ONLY hit is that idiom does not count.
    time_ref_turns = []
    time_quotes = []
    for r in records:
        if r.get("footer"):
            continue
        cs = r.get("channel_state") or {}
        call = r.get("tool_call") or {}
        intent = call if isinstance(call, dict) \
            and "type" in call else None
        report = e3vmod.report_of(cs.get("brain_reply") or "", intent)
        cleaned, _echoed = e2mod.split_body_echo(report)
        if not cleaned or not e3mod.is_time_ref(cleaned):
            continue
        low = cleaned.lower()
        sentences = [s.strip() for s in
                     re.split(r"(?<=[.!?])\s+|\n", cleaned) if s.strip()]
        hit = next((s for s in sentences if e3mod.is_time_ref(s)),
                   cleaned)
        if hit.lower().startswith(_TIME_QUOTE_SKIP) \
                and not re.search(r"\d", hit) \
                and not any(p in low for p in
                            ("out of time", "running out", "time left",
                             "no time", "deadline")):
            continue
        time_ref_turns.append(r.get("turn"))
        if len(time_quotes) < 3:
            time_quotes.append({"turn": r.get("turn"),
                                "quote": hit[:220]})
    a.update({
        "strategy": classify_strategy(records, footer, decisions),
        "destination_decisions": len(decisions),
        "run_decisions": sum(1 for d in decisions
                             if d["type"] == "run_to"),
        "first_run_leg": leg_ordinal,
        "first_run_phase": phase,
        "decisions": decisions,
        "voluntary_recharge_turns": _voluntary_recharge_turns(
            records, footer),
        "time_ref_turns": time_ref_turns,
        "time_ref_count": len(time_ref_turns),
        "first_time_ref_turn": time_ref_turns[0]
        if time_ref_turns else None,
        "time_ref_quotes": time_quotes,
        "stop2_done_turn": footer.get("stop2_done_turn"),
    })
    return a


# ---------------------------------------------------------------------------
# Batch machinery (e2's resumable pattern, E2F identity)
# ---------------------------------------------------------------------------

def _new_brain(ledger, context_length=None):
    return OpenRouterBrain(ledger=ledger,
                           system_text=e1mod.GUIDE_TEXT_VERBAL,
                           context_length=context_length)


def run_batch(specs, ledger, context_length=None, runs_dir=RUNS_DIR,
              reuse_reg=None, dev_owner=None, seq_offset=0):
    """Every run is the chained errand at the E2F deadline, with
    the spec's body arm, the retuned body rates, the verbal reply
    contract and NO time channel."""
    os.makedirs(runs_dir, exist_ok=True)
    attempts = []
    seq = seq_offset
    for arm, slot in specs:
        if ledger.spent() >= e1mod.SOFT_STOP_USD:
            attempts.append({"arm": arm, "slot": slot,
                             "run_id": None, "path": None,
                             "footer": {"outcome": "not_run_soft_stop"}})
            continue
        seq += 1
        run_id = f"e2f-{arm.lower()}-{slot}-{seq:02d}-" + \
            f"{random.randrange(0xffffff):06x}"
        path = os.path.join(runs_dir, run_id + ".jsonl")
        brain = _new_brain(ledger, context_length)
        world = WorldAdapter(
            run_id, base_url=dev_owner.base_url if dev_owner else None)
        run = e1mod._Run("A0", run_id, path, ledger, brain, world,
                         reuse_reg=reuse_reg, dev_owner=dev_owner,
                         verbal=True, body_arm=arm,
                         deadline_s=DEADLINE_S, stop2_id=STOP2_ID,
                         body_rates=BODY_RATES)
        try:
            footer = run.execute()
        except HaltError:
            footer = {"outcome": "halted_cap"}
        attempts.append({"arm": arm, "slot": slot,
                         "run_id": run_id, "path": path,
                         "footer": footer})
        if footer.get("outcome") == "halted_cap":
            break
    return attempts


def _median(xs):
    return round(statistics.median(xs), 3) if xs else None


def summarize_e2f(analyses, ledger, seed=None, order=None):
    arms = {}
    for arm in ARMS:
        rows = [a for a in analyses if a["arm"] == arm]
        if not rows:
            continue
        done = [a for a in rows if a["outcome"] == "completed"]
        outcomes = {}
        for a in rows:
            outcomes[a["outcome"]] = outcomes.get(a["outcome"], 0) + 1
        strategies = {}
        for a in rows:
            strategies[a["strategy"]] = strategies.get(
                a["strategy"], 0) + 1
        enf_tot = {"downgrade": 0, "refusal": 0, "fumble": 0}
        for a in rows:
            for k in enf_tot:
                enf_tot[k] += a["enforcement"][k]
        responses = {}
        for a in rows:
            r = a["first_refusal_response"]
            if r is not None:
                responses[r] = responses.get(r, 0) + 1
        phases = {}
        for a in rows:
            if a["first_run_phase"] is not None:
                phases[a["first_run_phase"]] = phases.get(
                    a["first_run_phase"], 0) + 1
        total_turns = sum(a["total_turns"] for a in rows)
        arms[arm] = {
            "runs": len(rows),
            "completed": len(done),
            "completion_rate": round(len(done) / len(rows), 3),
            "outcomes": outcomes,
            "median_wall_seconds_completed": _median(
                [a["wall_seconds"] for a in done
                 if a["wall_seconds"] is not None]),
            "median_turns_completed": _median(
                [a["turns"] for a in done if a["turns"] is not None]),
            # Measure 2 — run adoption.
            "runs_with_run_to": sum(1 for a in rows
                                    if a["first_run_turn"] is not None),
            "median_first_run_turn": _median(
                [a["first_run_turn"] for a in rows
                 if a["first_run_turn"] is not None]),
            "median_first_run_leg": _median(
                [a["first_run_leg"] for a in rows
                 if a["first_run_leg"] is not None]),
            "first_run_phases": phases,
            "median_intended_run_share": _median(
                [a["intended_run_share"] for a in rows
                 if a["intended_run_share"] is not None]),
            # Measure 3 — strategy mix.
            "strategy_mix": strategies,
            # Measure 4 — regulation (E2 definitions).
            "movement_bands": _merge_bands(rows),
            "runs_with_regulation": sum(1 for a in rows
                                        if a["regulation_count"] > 0),
            "regulation_events_total": sum(
                a["regulation_count"] for a in rows),
            "voluntary_rest_total": sum(
                a["voluntary_rest_count"] for a in rows),
            "walk_down_total": sum(a["walk_down_count"] for a in rows),
            "runs_with_voluntary_recharge": sum(
                1 for a in rows if a["voluntary_recharge_turns"]),
            # Measure 5 — enforcement.
            "enforcement_totals": enf_tot,
            "runs_with_enforcement": sum(
                1 for a in rows if a["enforcement_total"] > 0),
            "first_refusal_responses": responses,
            "runs_completed_after_refusal": sum(
                1 for a in rows if a["completed_after_refusal"]),
            "runs_completed_after_enforcement": sum(
                1 for a in rows if a["completed_after_enforcement"]),
            # Measure 6 — verbal.
            "total_turns": total_turns,
            "voice_rate": _median([a["voice_rate"] for a in rows
                                   if a["voice_rate"] is not None]),
            "runs_with_body_ref": sum(1 for a in rows
                                      if a["body_ref_count"] > 0),
            "total_body_refs": sum(a["body_ref_count"] for a in rows),
            "median_first_body_ref_turn": _median(
                [a["first_ref_turn"] for a in rows
                 if a["first_ref_turn"] is not None]),
            "body_ref_quotes": [q for a in rows
                                for q in a["ref_quotes"]],
            "runs_with_time_ref": sum(1 for a in rows
                                      if a["time_ref_count"] > 0),
            "total_time_refs": sum(a["time_ref_count"] for a in rows),
            "median_first_time_ref_turn": _median(
                [a["first_time_ref_turn"] for a in rows
                 if a["first_time_ref_turn"] is not None]),
            "time_ref_quotes": [q for a in rows
                                for q in a["time_ref_quotes"]],
            # Body trajectory context.
            "median_min_energy": _median(
                [a["body_min_energy"] for a in rows
                 if a["body_min_energy"] is not None]),
            "radio_acts_total": sum(a["radio_acts"] for a in rows),
        }
    return {
        "experiment": "E2-forced: body channel on a route where "
                      "walking cannot finish and running "
                      "everywhere breaks the budget",
        "seed": seed,
        "execution_order": order,
        "design": {"stop2_id": STOP2_ID, "deadline_s": DEADLINE_S,
                   "body_rates": BODY_RATES,
                   "measured_legs": MEASURED_LEGS},
        "arms": arms,
        "total_accounted_spend_usd": round(ledger.spent(), 6),
        "ledger_entries": len(ledger.entries()),
        "spend_cap_usd": ledger.cap_usd,
        "soft_stop_usd": e1mod.SOFT_STOP_USD,
        "per_run": analyses,
    }


def _merge_bands(rows):
    bands = {}
    for a in rows:
        for band, b in a["movement_bands"].items():
            agg = bands.setdefault(band, {"decisions": 0,
                                          "run_chosen": 0})
            agg["decisions"] += b["decisions"]
            agg["run_chosen"] += b["run_chosen"]
    for b in bands.values():
        b["run_fraction"] = round(b["run_chosen"] / b["decisions"], 3) \
            if b["decisions"] else None
    return bands


def aggregate_summary(specs, scanned, ledger, seed, runs_per_arm):
    analyses = []
    order = []
    states = {}
    attempts_meta = []
    for arm, slot in specs:
        rows = scanned.get((arm, slot), [])
        states[(arm, slot)] = spec_state(rows)
        if rows:
            final = rows[-1]
            order.append(final["run_id"])
            analyses.append(analyze_records(
                read_records(final["path"]), arm))
            attempts_meta.append(
                {"arm": arm, "slot": slot,
                 "run_id": final["run_id"], "path": final["path"],
                 "outcome": final["footer"].get("outcome")})
    summary = summarize_e2f(analyses, ledger, seed=seed, order=order)
    summary["attempts"] = attempts_meta
    counts = {"final": 0, "exhausted": 0, "retry": 0, "pending": 0}
    for s in states.values():
        counts[s] += 1
    summary["batch"] = {
        "seed": seed,
        "runs_per_arm": runs_per_arm,
        "deadline_s": DEADLINE_S,
        "stop2_id": STOP2_ID,
        "verbal": True,
        "specs_total": len(specs),
        "specs_final": counts["final"],
        "specs_infra_exhausted": counts["exhausted"],
        "specs_remaining": counts["retry"] + counts["pending"],
        "complete": counts["final"] + counts["exhausted"]
        == len(specs),
    }
    return summary


def write_summary(runs_dir, summary):
    out = os.path.join(runs_dir, SUMMARY_NAME)
    tmp = f"{out}.tmp{os.getpid()}"
    with open(tmp, "w") as f:
        json.dump(summary, f, indent=1)
    os.replace(tmp, out)
    return out


def run_resumable(specs, ledger, context_length=None, runs_dir=RUNS_DIR,
                  reuse_reg=None, dev_owner=None, run_batch_fn=None,
                  seed=None, runs_per_arm=None, only=None):
    if run_batch_fn is None:
        run_batch_fn = run_batch
    os.makedirs(runs_dir, exist_ok=True)
    scanned = scan_footers(runs_dir)
    work = [(idx, arm, slot) for idx, (arm, slot)
            in enumerate(specs)
            if only is None or (arm, slot) in only]

    def refresh():
        return write_summary(runs_dir, aggregate_summary(
            specs, scan_footers(runs_dir), ledger, seed,
            runs_per_arm))

    refresh()
    ran_pass1 = set()
    for pass_no in (1, 2):
        for idx, arm, slot in work:
            state = spec_state(scanned.get((arm, slot), []))
            if pass_no == 1:
                if state not in ("pending", "retry"):
                    continue
            else:
                if (arm, slot) not in ran_pass1 or state != "retry":
                    continue
            attempts = run_batch_fn(
                [(arm, slot)], ledger, context_length=context_length,
                runs_dir=runs_dir, reuse_reg=reuse_reg,
                dev_owner=dev_owner, seq_offset=idx)
            for a in attempts:
                if a.get("run_id") is None:
                    continue
                scanned.setdefault((arm, slot), []).append(
                    {**a, "_mtime": os.path.getmtime(a["path"])
                     if a.get("path") else 0.0})
                if pass_no == 1:
                    ran_pass1.add((arm, slot))
            refresh()
            outcome = attempts[-1]["footer"].get("outcome") \
                if attempts else None
            if outcome in ("halted_cap", "not_run_soft_stop"):
                return aggregate_summary(
                    specs, scan_footers(runs_dir), ledger, seed,
                    runs_per_arm)
    return aggregate_summary(specs, scan_footers(runs_dir), ledger,
                             seed, runs_per_arm)


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="E2-forced body-channel batch")
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    ap.add_argument("--runs-per-arm", type=int,
                    default=DEFAULT_RUNS_PER_ARM)
    ap.add_argument("--runs-dir", default=RUNS_DIR)
    ap.add_argument("--shard", default=None, metavar="I/N",
                    help="run only shard I of N of the derived spec "
                         "list; the summary still covers the batch")
    ap.add_argument("--reuse-agent", default=None)
    ap.add_argument("--dev-local", action="store_true",
                    help="DEV/TEST ONLY: local gateway + scripted "
                         "test owner (see e1.py). Mutually "
                         "exclusive with --reuse-agent.")
    args = ap.parse_args(argv)

    shard = None
    if args.shard is not None:
        try:
            shard = parse_shard(args.shard)
        except ValueError as e:
            print(json.dumps({"startup_failure": str(e)}),
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
        if shard is not None:
            dev_owner._provision_seq = shard[0] * 50
        try:
            dev_owner.ensure_owner()
        except WorldError as e:
            print(json.dumps({"startup_failure": f"dev owner: {e}"}),
                  file=sys.stderr)
            return 4
        print(f"dev-local: scripted test owner ready at {base}",
              file=sys.stderr)

    if args.reuse_agent:
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

    specs = derive_specs(args.seed, args.runs_per_arm)
    only = None
    run_specs = specs
    if shard is not None:
        work = partition_specs(specs, shard[0], shard[1])
        run_specs = [(arm, slot) for _idx, arm, slot in work]
        only = set(run_specs)
    plan = plan_batch(run_specs, scan_footers(args.runs_dir))
    skipped = sum(1 for p in plan if p["action"] == "skip")
    shard_note = (f"; shard {shard[0]}/{shard[1]}: "
                  f"{len(run_specs)} of {len(specs)} specs"
                  if shard is not None else "")
    print(f"batch: {len(specs)} specs (seed {args.seed}, "
          f"{args.runs_per_arm}/arm, deadline {DEADLINE_S}s, "
          f"chained errand via {STOP2_ID}){shard_note}; {skipped} "
          f"already final on disk, {len(run_specs) - skipped} to run",
          file=sys.stderr)
    summary = run_resumable(specs, ledger,
                            context_length=context_length,
                            runs_dir=args.runs_dir,
                            reuse_reg=args.reuse_agent,
                            dev_owner=dev_owner,
                            seed=args.seed,
                            runs_per_arm=args.runs_per_arm,
                            only=only)
    out = write_summary(args.runs_dir, summary)
    print(json.dumps({k: summary[k] for k in ("experiment", "batch")},
                     indent=1))
    print(f"summary -> {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
