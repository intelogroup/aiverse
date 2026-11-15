#!/usr/bin/env python3
"""E2 runner (plan §4): the body channel — synthetic interoception.

E1/E3/E3-verbal established the clock's fate: read, believed, talked
about — rarely acted on, when it is pure information. E2 asks
whether a BODY signal does better: an energy/strain state the runner
maintains from the agent's own actions (channels.BodyModel — the
Phase 0 physiology integrated over measured act durations: walking
drains slowly, running drains fast and strains, sitting/resting
recovers), rendered into every turn's CHANNELS, in three arms that
differ ONLY in the body line:

  B0 HIDDEN      no body line, no enforcement. The model is tracked
                 silently (its values fill channel_state for
                 analysis) but the agent sees and feels nothing —
                 E1's blind condition plus the verbal contract.
  B1 SHOWN       the true body line every turn ("body: energy 62 ·
                 strain 10 · context 34%"). INFORMATION ONLY:
                 nothing happens at energy 0; acts are never
                 modified.
  B2 CONSEQUENTIAL  the same line PLUS harness/enforce.py between
                 the brain's intent and the world: run_to downgraded
                 to go_to below energy 15, movement refused while
                 depleted (energy hit 0) until recovery to >= 30,
                 the first interact at strain >= 70 fumbles.
                 Enforcement results are rendered in the sim's own
                 refusal voice (settled act, outcome {"ok": false,
                 "status": "rejected"/"fumbled", "detail": reason})
                 carrying enforce()'s true reason.

Same sit errand, same task text, same real 340 s deadline, and the
E3-verbal report contract (status line + intent) in every arm, so
the agent's words about its body are measurable. No time channel in
any arm (the runner's A0 time renderer is empty by construction).

Calibration (scripted, $0, BEFORE the paid batch — dev/e2_rehearsal
.py on the live dev stack + offline timed rehearsals in
tests/test_e2.py): (a) a walk-only B2 errand completes with energy
never entering the enforcement zone; (b) a run-everywhere B2 errand
hits enforcement unless the agent rests; (c) the mandatory sit
recovers a measured, meaningful amount; (d) the same run-everywhere
path in B1 drains to ~0 with no consequence at all.

Batch identity: run files are e2-<arm>-<slot>-<seq>-<rand>.jsonl and
every footer records deadline_s (= 340), body_arm AND verbal=True.
The footer scan counts a file only when all three match the spec it
is filed under, so E1/E3/E3-verbal footers can never satisfy an E2
spec, nor E2's theirs ( disjoint filename prefixes AND disjoint
footer keys). The driver is e3v's resumable/sharded pattern
re-keyed: relaunching the same command resumes from footers, and
runs/e2-summary.json is regenerated from a fresh scan after
every run.

Pre-registered measures (analyze_records — defined here, unit-
tested on scripted traces, BEFORE any live run):
  1. Continuity: outcome, wall, turns, run_to usage per arm.
  2. Pacing: run share of movement decisions (brain's intent) and
     of executed movement acts; per movement-decision turn, the
     displayed energy against the run/walk choice, aggregated into
     energy bands (>= 50, 30-50, 15-30, < 15).
  3. Anticipatory regulation (the homeostatic signature): voluntary
     regulation events while displayed energy is LOW-BUT-NOT-
     CRITICAL (< 40) and BEFORE any enforcement event in the run —
     (i) voluntary rest: a wait of >= 5 s, a non-mandatory sit, or a
     rest intent at displayed energy < 40; (ii) walk-down: a go_to
     chosen at displayed energy in [15, 40) by an agent that has
     already used run_to earlier in the run. Counted per arm; in B0
     the banding uses the silently tracked model, so B0's count is
     the endogenous baseline (regulation with no signal to read).
  4. Enforcement (B2): downgrades / refusals / fumbles per run; the
     brain's intent on the turn after the FIRST refusal, classified
     rested / retried_movement / other / run_ended; runs that were
     enforced against and still completed.
  5. Verbal: body-state references in the status-line reports
     (lexicon over the report with verbatim body-line echoes
     stripped — parroting the channel is not the agent's own
     words): rate per arm, first-mention turn, the displayed
     energy at reference turns vs the run's overall displayed
     energies, verbatim quotes. B0 references are endogenous by
     construction (no body line in its prompts — asserted by the
     purity tests).
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
    import e3v as e3vmod
    from batch import parse_shard, partition_specs, spec_state
    from brain import BrainError, OpenRouterBrain
    from devowner import DevOwner
    from ledger import HaltError, SpendLedger
    from world import WorldAdapter, WorldError, WorldGateError
except ImportError:  # imported as part of the harness package
    from . import e1 as e1mod
    from . import e3v as e3vmod
    from .batch import parse_shard, partition_specs, spec_state
    from .brain import BrainError, OpenRouterBrain
    from .devowner import DevOwner
    from .ledger import HaltError, SpendLedger
    from .world import WorldAdapter, WorldError, WorldGateError

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS_DIR = e1mod.RUNS_DIR
DEADLINE_S = e1mod.DEADLINE_S          # 340, enforced for real
ARMS = ("B0", "B1", "B2")
DEFAULT_SEED = 20261119
DEFAULT_RUNS_PER_ARM = 12
SUMMARY_NAME = "e2-summary.json"
REG_LOW_ENERGY = 40.0                  # "low but not critical" band
                                       # ceiling for measure 3

_RUN_FILE_RE = re.compile(
    r"^e2-(b0|b1|b2)-(p\d+)(r?)-(\d+)-[0-9a-f]{6}\.jsonl$")
_TOKEN_TO_ARM = {"b0": "B0", "b1": "B1", "b2": "B2"}


# ---------------------------------------------------------------------------
# Spec derivation + footer scan (e3v's pattern, body-keyed)
# ---------------------------------------------------------------------------

def derive_specs(seed, runs_per_arm):
    """Arm-major spec list shuffled with random.Random(seed) — the
    construction batch.derive_specs / e3.derive_specs use."""
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
    counts only when its deadline_s equals this batch's, its
    body_arm equals the arm of the filename token, AND it carries
    the verbal=True marker — E1/E3/E3-verbal footers are invisible
    here by construction (different prefixes, no body_arm), and
    vice versa."""
    found = {}
    for path in glob.glob(os.path.join(runs_dir, "e2-*.jsonl")):
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
# Verbal front end: report extraction + body-line echo handling
# ---------------------------------------------------------------------------

report_of = e3vmod.report_of           # status line = reply minus
                                       # every JSON span (+ say text)

_BODY_TEXT_RE = re.compile(
    r"body: energy \d+ · strain \d+ · context \d+%")


def split_body_echo(report):
    """(cleaned, echoed): remove verbatim renderings of the body
    line. A status line that parrots the channel has echoed prompt
    text, not spoken about its body in its own words; the lexicon
    runs on the cleaned remainder and echoes are counted apart."""
    cleaned, n = _BODY_TEXT_RE.subn(" ", report or "")
    return " ".join(cleaned.split()), n > 0


_BODY_WORD_RE = re.compile(
    r"\b(energy|tired|tiredness|exhausted|exhaustion|exhausting|"
    r"strain|strained|straining|fatigue|fatigued|weary|weariness|"
    r"winded|stamina|breathless|sore|rest|resting|rested|pace|"
    r"pacing|paced)\b",
    re.IGNORECASE)
_BODY_PHRASES = ("my body", "low on energy", "out of energy",
                 "running low", "conserve", "take a break",
                 "catch my breath", "slow down", "slowing down")
_ENERGY_NUM_RE = re.compile(
    r"\benergy (?:is |at |of |: ?)?(\d{1,3})\b", re.IGNORECASE)


def is_body_ref(prose):
    if not prose:
        return False
    if _BODY_WORD_RE.search(prose) or _ENERGY_NUM_RE.search(prose):
        return True
    low = prose.lower()
    return any(p in low for p in _BODY_PHRASES)


def _quote_for_body(prose):
    """The sentence of the prose carrying the body reference,
    trimmed — the verbatim evidence the report quotes."""
    for sentence in re.split(r"(?<=[.!?])\s+|\n", prose):
        s = sentence.strip()
        if s and is_body_ref(s):
            return s[:220]
    return prose.strip()[:220]


def _energy_band(energy):
    if energy is None:
        return None
    if energy >= 50:
        return "ge50"
    if energy >= 30:
        return "30_50"
    if energy >= 15:
        return "15_30"
    return "lt15"


_REST_CLASS = {"wait", "sit", "rest"}
_MOVE_CLASS = {"go_to", "run_to", "enter"}


# ---------------------------------------------------------------------------
# Pre-registered classifier (measure definitions — see docstring)
# ---------------------------------------------------------------------------

def analyze_records(records, arm):
    """Classify one E2 run from its log records."""
    turns = [r for r in records if not r.get("footer")]
    footer = {}
    for r in records:
        if r.get("footer"):
            footer = r
    sat_turn = footer.get("sat_done_turn")
    enf_by_turn = {}
    for ev in footer.get("enforcement_events") or []:
        enf_by_turn.setdefault(ev.get("turn"), []).append(ev)
    first_enf_turn = min(enf_by_turn) if enf_by_turn else None

    feats = []
    ran_before = False
    for r in turns:
        cs = r.get("channel_state") or {}
        call = r.get("tool_call") or {}
        intent = call if isinstance(call, dict) \
            and "type" in call else None
        itype = intent.get("type") if intent else None
        report = report_of(cs.get("brain_reply") or "", intent)
        cleaned, echoed = split_body_echo(report)
        snap = cs.get("body_snapshot") or {}
        disp_energy = snap.get("energy")
        turn_no = r.get("turn")
        enf_kinds = [e.get("kind") for e in
                     enf_by_turn.get(turn_no, [])]
        feat = {
            "turn": turn_no,
            "report": report,
            "voice": bool(report),
            "echo": echoed,
            "cleaned": cleaned,
            "body_ref": is_body_ref(cleaned),
            "disp_energy": disp_energy,
            "disp_strain": snap.get("strain"),
            "intent_type": itype,
            "executed_type": cs.get("body_executed_type"),
            "enforcement": enf_kinds,
            "status": r.get("tool_result_status"),
            "wait_seconds": (intent.get("seconds")
                             if itype == "wait" else None),
        }
        # Measure 3 — anticipatory regulation, judged on the state
        # the agent faced at THIS turn, before this run's first
        # enforcement event (a B2 agent bullied by a refusal into
        # resting is reacting, not regulating).
        before_enf = first_enf_turn is None \
            or (turn_no is not None and turn_no < first_enf_turn)
        reg = None
        if disp_energy is not None and disp_energy < REG_LOW_ENERGY \
                and before_enf:
            if itype == "wait" and \
                    (feat["wait_seconds"] or 0) >= 5:
                reg = "voluntary_rest"
            elif itype == "rest":
                reg = "voluntary_rest"
            elif itype == "sit" and turn_no != sat_turn:
                reg = "voluntary_rest"
            elif itype == "go_to" and ran_before \
                    and disp_energy >= 15:
                reg = "walk_down"
        feat["regulation"] = reg
        if itype == "run_to":
            ran_before = True
        feats.append(feat)

    refs = [f for f in feats if f["body_ref"]]
    moves = [f for f in feats
             if f["intent_type"] in ("go_to", "run_to")]
    exec_moves = [f for f in feats
                  if f["executed_type"] in ("go_to", "run_to")]
    bands = {}
    for f in moves:
        band = _energy_band(f["disp_energy"])
        if band is None:
            continue
        b = bands.setdefault(band, {"decisions": 0, "run_chosen": 0})
        b["decisions"] += 1
        if f["intent_type"] == "run_to":
            b["run_chosen"] += 1
    for b in bands.values():
        b["run_fraction"] = round(b["run_chosen"] / b["decisions"], 3) \
            if b["decisions"] else None
    regs = [f for f in feats if f["regulation"]]
    enf_counts = {"downgrade": 0, "refusal": 0, "fumble": 0}
    for evs in enf_by_turn.values():
        for ev in evs:
            if ev.get("kind") in enf_counts:
                enf_counts[ev["kind"]] += 1
    # Measure 4 — the response to the FIRST refusal (B2).
    first_refusal_turn = footer.get("first_refusal_turn")
    refusal_response = None
    if first_refusal_turn is not None:
        nxt = next((f for f in feats
                    if f["turn"] is not None
                    and f["turn"] > first_refusal_turn), None)
        if nxt is None:
            refusal_response = "run_ended"
        elif nxt["intent_type"] in _REST_CLASS:
            refusal_response = "rested"
        elif nxt["intent_type"] in _MOVE_CLASS:
            refusal_response = "retried_movement"
        else:
            refusal_response = "other"
    voiced = [f for f in feats if f["voice"]]
    return {
        "arm": arm,
        "outcome": footer.get("outcome"),
        "wall_seconds": footer.get("wall_seconds"),
        "turns": footer.get("turns"),
        "total_turns": len(feats),
        "voice_turns": len(voiced),
        "voice_rate": (round(len(voiced) / len(feats), 3)
                       if feats else None),
        "echo_turns": [f["turn"] for f in feats if f["echo"]],
        "first_run_turn": footer.get("first_run_turn"),
        "sat_done_turn": sat_turn,
        "intended_run_share": (
            round(sum(1 for f in moves
                      if f["intent_type"] == "run_to") / len(moves), 3)
            if moves else None),
        "executed_run_share": (
            round(sum(1 for f in exec_moves
                      if f["executed_type"] == "run_to")
                  / len(exec_moves), 3) if exec_moves else None),
        "movement_bands": bands,
        "regulation_events": [{"turn": f["turn"], "kind": f["regulation"],
                               "disp_energy": f["disp_energy"]}
                              for f in regs],
        "regulation_count": len(regs),
        "voluntary_rest_count": sum(1 for f in regs
                                    if f["regulation"]
                                    == "voluntary_rest"),
        "walk_down_count": sum(1 for f in regs
                               if f["regulation"] == "walk_down"),
        "body_ref_turns": [f["turn"] for f in refs],
        "body_ref_count": len(refs),
        "first_ref_turn": refs[0]["turn"] if refs else None,
        "ref_events": [{"turn": f["turn"],
                        "disp_energy": f["disp_energy"],
                        "quote": _quote_for_body(f["cleaned"])}
                       for f in refs],
        "ref_quotes": [{"turn": f["turn"],
                        "quote": _quote_for_body(f["cleaned"])}
                       for f in refs[:3]],
        "median_disp_energy_at_refs": _median_or_none(
            [f["disp_energy"] for f in refs
             if f["disp_energy"] is not None]),
        "median_disp_energy_all": _median_or_none(
            [f["disp_energy"] for f in feats
             if f["disp_energy"] is not None]),
        "enforcement": enf_counts,
        "enforcement_total": sum(enf_counts.values()),
        "first_refusal_turn": first_refusal_turn,
        "first_refusal_response": refusal_response,
        "completed_after_refusal": bool(
            first_refusal_turn is not None
            and footer.get("outcome") == "completed"),
        "completed_after_enforcement": bool(
            enf_counts and sum(enf_counts.values()) > 0
            and footer.get("outcome") == "completed"),
        "body_min_energy": footer.get("body_min_energy"),
        "body_final": footer.get("body_final"),
        "radio_acts": sum(1 for f in feats
                          if f["intent_type"] == "interact"),
    }


def _median_or_none(xs):
    return round(statistics.median(xs), 3) if xs else None


# ---------------------------------------------------------------------------
# Batch machinery (e3v's resumable pattern, E2 identity)
# ---------------------------------------------------------------------------

def _new_body_brain(ledger, context_length=None):
    """The E2 brain: e1's brain with the report-inviting (verbal)
    guide — the words are a pre-registered measure in every arm."""
    return OpenRouterBrain(ledger=ledger,
                           system_text=e1mod.GUIDE_TEXT_VERBAL,
                           context_length=context_length)


def run_batch(specs, ledger, context_length=None, runs_dir=RUNS_DIR,
              reuse_reg=None, dev_owner=None, seq_offset=0):
    """specs: list of (arm, slot_label). Every run is the sit
    errand with NO time channel, the verbal reply contract, and the
    spec's body arm; stops on HaltError or past the soft stop."""
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
        run_id = f"e2-{arm.lower()}-{slot}-{seq:02d}-" + \
            f"{random.randrange(0xffffff):06x}"
        path = os.path.join(runs_dir, run_id + ".jsonl")
        brain = _new_body_brain(ledger, context_length)
        world = WorldAdapter(
            run_id, base_url=dev_owner.base_url if dev_owner else None)
        run = e1mod._Run("A0", run_id, path, ledger, brain, world,
                         reuse_reg=reuse_reg, dev_owner=dev_owner,
                         verbal=True, body_arm=arm)
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


def summarize_e2(analyses, ledger, seed=None, order=None):
    """Per-arm aggregates over the FINAL attempt of each spec."""
    arms = {}
    for arm in ARMS:
        rows = [a for a in analyses if a["arm"] == arm]
        if not rows:
            continue
        done = [a for a in rows if a["outcome"] == "completed"]
        outcomes = {}
        for a in rows:
            outcomes[a["outcome"]] = outcomes.get(a["outcome"], 0) + 1
        total_turns = sum(a["total_turns"] for a in rows)
        voice_turns = sum(a["voice_turns"] for a in rows)
        bands = {}
        for a in rows:
            for band, b in a["movement_bands"].items():
                agg = bands.setdefault(
                    band, {"decisions": 0, "run_chosen": 0})
                agg["decisions"] += b["decisions"]
                agg["run_chosen"] += b["run_chosen"]
        for b in bands.values():
            b["run_fraction"] = round(
                b["run_chosen"] / b["decisions"], 3) \
                if b["decisions"] else None
        enf_tot = {"downgrade": 0, "refusal": 0, "fumble": 0}
        for a in rows:
            for k in enf_tot:
                enf_tot[k] += a["enforcement"][k]
        responses = {}
        for a in rows:
            r = a["first_refusal_response"]
            if r is not None:
                responses[r] = responses.get(r, 0) + 1
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
            "runs_with_run_to": sum(1 for a in rows
                                    if a["first_run_turn"] is not None),
            "median_intended_run_share": _median(
                [a["intended_run_share"] for a in rows
                 if a["intended_run_share"] is not None]),
            "median_executed_run_share": _median(
                [a["executed_run_share"] for a in rows
                 if a["executed_run_share"] is not None]),
            "movement_bands": bands,
            # Measure 3 — anticipatory regulation.
            "runs_with_regulation": sum(1 for a in rows
                                        if a["regulation_count"] > 0),
            "regulation_events_total": sum(
                a["regulation_count"] for a in rows),
            "voluntary_rest_total": sum(
                a["voluntary_rest_count"] for a in rows),
            "walk_down_total": sum(a["walk_down_count"] for a in rows),
            # Measure 5 — verbal body references.
            "total_turns": total_turns,
            "voice_rate": (round(voice_turns / total_turns, 3)
                           if total_turns else None),
            "runs_with_body_ref": sum(1 for a in rows
                                      if a["body_ref_count"] > 0),
            "total_body_refs": sum(a["body_ref_count"] for a in rows),
            "median_first_ref_turn": _median(
                [a["first_ref_turn"] for a in rows
                 if a["first_ref_turn"] is not None]),
            "median_disp_energy_at_refs": _median(
                [a["median_disp_energy_at_refs"] for a in rows
                 if a["median_disp_energy_at_refs"] is not None]),
            "echo_turns_total": sum(len(a["echo_turns"])
                                    for a in rows),
            "ref_quotes": [q for a in rows for q in a["ref_quotes"]],
            # Body trajectory context.
            "median_min_energy": _median(
                [a["body_min_energy"] for a in rows
                 if a["body_min_energy"] is not None]),
            "runs_min_energy_le5": sum(
                1 for a in rows
                if a["body_min_energy"] is not None
                and a["body_min_energy"] <= 5),
            "runs_min_energy_lt15": sum(
                1 for a in rows
                if a["body_min_energy"] is not None
                and a["body_min_energy"] < 15),
            "radio_acts_total": sum(a["radio_acts"] for a in rows),
            # Measure 4 — enforcement (nonzero only in B2).
            "enforcement_totals": enf_tot,
            "runs_with_enforcement": sum(
                1 for a in rows if a["enforcement_total"] > 0),
            "first_refusal_responses": responses,
            "runs_completed_after_refusal": sum(
                1 for a in rows if a["completed_after_refusal"]),
            "runs_completed_after_enforcement": sum(
                1 for a in rows if a["completed_after_enforcement"]),
        }
    return {
        "experiment": "E2 body channel (plan §4): hidden / shown / "
                      "shown+consequential energy-strain signal",
        "seed": seed,
        "execution_order": order,
        "arms": arms,
        "total_accounted_spend_usd": round(ledger.spent(), 6),
        "ledger_entries": len(ledger.entries()),
        "spend_cap_usd": ledger.cap_usd,
        "soft_stop_usd": e1mod.SOFT_STOP_USD,
        "per_run": analyses,
    }


def aggregate_summary(specs, scanned, ledger, seed, runs_per_arm):
    """e2-summary.json content: summarize_e2 over the final attempt
    of every spec, plus the batch progress block."""
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
    summary = summarize_e2(analyses, ledger, seed=seed, order=order)
    summary["attempts"] = attempts_meta
    counts = {"final": 0, "exhausted": 0, "retry": 0, "pending": 0}
    for s in states.values():
        counts[s] += 1
    summary["batch"] = {
        "seed": seed,
        "runs_per_arm": runs_per_arm,
        "deadline_s": DEADLINE_S,
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
    """Atomic replace under E2's own summary name."""
    out = os.path.join(runs_dir, SUMMARY_NAME)
    tmp = f"{out}.tmp{os.getpid()}"
    with open(tmp, "w") as f:
        json.dump(summary, f, indent=1)
    os.replace(tmp, out)
    return out


def run_resumable(specs, ledger, context_length=None, runs_dir=RUNS_DIR,
                  reuse_reg=None, dev_owner=None, run_batch_fn=None,
                  seed=None, runs_per_arm=None, only=None):
    """e3v.run_resumable's discipline, E2-keyed: skip FINAL specs,
    one infra re-run in a second pass, summary regenerated from a
    fresh disk scan after every run. `only` restricts execution to
    one shard's subset; the summary stays global."""
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
        description="E2 body-channel batch (plan §4)")
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    ap.add_argument("--runs-per-arm", type=int,
                    default=DEFAULT_RUNS_PER_ARM)
    ap.add_argument("--runs-dir", default=RUNS_DIR)
    ap.add_argument("--shard", default=None, metavar="I/N",
                    help="run only shard I of N of the derived spec "
                         "list (partition by list index modulo N); "
                         "the summary still covers the whole batch")
    ap.add_argument("--reuse-agent", default=None,
                    help="path to a .reg.json of an owner-claimed "
                         "agent to reuse for every run (see e1.py)")
    ap.add_argument("--dev-local", action="store_true",
                    help="DEV/TEST ONLY: run against a LOCAL gateway "
                         "with the scripted test owner provisioning "
                         "a fresh claimed agent per run (see e1.py). "
                         "Mutually exclusive with --reuse-agent.")
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
    probe = _new_body_brain(ledger)
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
            # Same claim-bucket discipline as e3/e3v: offset each
            # shard's TEST-NET-2 sequence so shards don't exhaust
            # each other's per-address claim buckets in lockstep.
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
          f"body channel){shard_note}; {skipped} already final on "
          f"disk, {len(run_specs) - skipped} to run", file=sys.stderr)
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
