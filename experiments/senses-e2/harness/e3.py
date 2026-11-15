#!/usr/bin/env python3
"""E3 runner (plan §5): the sham-clock control for E1's null result.

E1's full phase found the clock arm indistinguishable from the blind
arm (completions 9/12 each; run_to in 1/38 completions). Two candidate
explanations: (a) the rendered time text is not read as time at all —
decoration; or (b) it is read as time but never converted into action.
E3 discriminates them by lying about the clock while enforcing the
REAL 340 s deadline identically in every arm. All four arms are the
A2 clock channel (e1's sit errand, task text and GUIDE unchanged)
with a different rendering mode (channels.TimeChannel mode):

  V  veridical — the true elapsed/remaining (fresh A2 replication)
  F  frozen    — "elapsed 00:00 · remaining 05:40" on every turn
  X2 fast2x    — displayed clock runs at 2x: remaining hits 00:00 at
                 170 s real, while the run truly ends only at 340 s
  P  permuted  — true values, labels swapped: the "elapsed" slot
                 shows the decreasing remaining value, the "remaining"
                 slot the increasing elapsed value

If the agent tracks the DISPLAYED time — verbal references that
follow the displayed values, urgency clustered at displayed
thresholds, give-up behaviour at displayed-zero in X2 — the text is
being read as time (explanation b, at least for reading). If the
arms are indistinguishable on every measure including verbal
tracking, the text is decoration (explanation a).

Batch identity: run files are e3-<mode>-<slot>-<seq>-<rand>.jsonl
and every footer records deadline_s (= e1.DEADLINE_S, 340) AND
sham_mode. The footer scan counts a file only when both match the
spec it is filed under, so E1's footers (e1-* names, no sham_mode)
can never satisfy an E3 spec, nor E3's an E1 spec. The driver is
harness/batch.py's resumable/sharded pattern re-keyed to E3:
relaunching the same command resumes from the footers on disk, and
runs/e3-summary.json is regenerated from a fresh scan after every
run.

Pre-registered measures (analyze_records — defined here, unit-tested
on scripted traces, BEFORE any live run):
  1. Verbal time references: turns whose reply PROSE (the reply with
     the intent JSON stripped, plus any say-intent text) matches the
     time lexicon — count, first turn, quotes. A bare intent JSON
     (e.g. {"type":"wait","seconds":30}) is not a verbal reference.
  2. Displayed-time tracking: per-turn displayed elapsed/remaining
     parsed from the logged time_text, against real elapsed (turn ts
     minus the footer's attach_ts). X2: turns where displayed
     remaining crosses 01:00 and 00:00, and what the agent does at /
     after displayed-zero. F: any urgency expression at all. P: for
     quoted clock values in the prose, whether they match the
     "remaining" SLOT's string (label position) or the decreasing
     elapsed-slot value (value dynamics).
  3. Continuity with E1: outcome, wall, turns, run_to usage, radio
     detours (interact acts targeting the tea radio).
  4. X2 at displayed-zero: give-up language at/after that turn, and
     whether acts keep settling normally afterwards (they should —
     only the display expired).
"""
import argparse
import glob
import json
import os
import random
import re
import statistics
import sys
from datetime import datetime

try:
    import e1 as e1mod
    from batch import is_final_outcome, parse_shard, partition_specs, \
        spec_state
    from brain import BrainError
    from channels import _mmss
    from devowner import DevOwner
    from ledger import HaltError, SpendLedger
    from world import WorldAdapter, WorldError, WorldGateError
except ImportError:  # imported as part of the harness package
    from . import e1 as e1mod
    from .batch import is_final_outcome, parse_shard, partition_specs, \
        spec_state
    from .brain import BrainError
    from .channels import _mmss
    from .devowner import DevOwner
    from .ledger import HaltError, SpendLedger
    from .world import WorldAdapter, WorldError, WorldGateError

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS_DIR = e1mod.RUNS_DIR
DEADLINE_S = e1mod.DEADLINE_S          # 340, enforced for real in
                                       # every arm; only the
                                       # RENDERED clock is sham
MODES = ("V", "F", "X2", "P")
CHANNEL_MODE = {"V": "veridical", "F": "frozen",
                "X2": "fast2x", "P": "permuted"}
DEFAULT_SEED = 20261117
DEFAULT_RUNS_PER_ARM = 10
SUMMARY_NAME = "e3-summary.json"

_RUN_FILE_RE = re.compile(
    r"^e3-(v|f|x2|p)-(p\d+)(r?)-(\d+)-[0-9a-f]{6}\.jsonl$")
_TOKEN_TO_MODE = {"v": "V", "f": "F", "x2": "X2", "p": "P"}


# ---------------------------------------------------------------------------
# Spec derivation + footer scan (batch.py's pattern, re-keyed to E3)
# ---------------------------------------------------------------------------

def derive_specs(seed, runs_per_arm):
    """Mode-major spec list shuffled with random.Random(seed) — the
    exact construction batch.derive_specs uses for E1, over MODES."""
    specs = [(mode, f"p{i}") for mode in MODES
             for i in range(1, runs_per_arm + 1)]
    rng = random.Random(seed)
    rng.shuffle(specs)
    return specs


def _read_footer(path):
    """The footer record of a run file, or None (a killed run may
    leave no footer or a torn last line — not data)."""
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
    """All parseable records of a run file, in file order."""
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
    """Map (mode, slot) -> [attempt, ...], oldest first. A footer
    counts only when its recorded deadline_s equals this batch's AND
    its sham_mode equals the channel mode of the mode token in the
    filename — E1 footers (different prefix, no sham_mode) and any
    foreign-deadline footer are invisible here by construction."""
    found = {}
    for path in glob.glob(os.path.join(runs_dir, "e3-*.jsonl")):
        m = _RUN_FILE_RE.match(os.path.basename(path))
        if not m:
            continue
        mode = _TOKEN_TO_MODE[m.group(1)]
        slot = m.group(2)
        footer = _read_footer(path)
        if footer is None:
            continue
        if footer.get("deadline_s") != deadline_s:
            continue
        if footer.get("sham_mode") != CHANNEL_MODE[mode]:
            continue
        attempt = {"mode": mode, "slot": slot,
                   "run_id": footer.get("run_id")
                   or os.path.basename(path)[:-6],
                   "path": path, "footer": footer,
                   "_mtime": os.path.getmtime(path)}
        found.setdefault((mode, slot), []).append(attempt)
    for attempts in found.values():
        attempts.sort(key=lambda a: (a["_mtime"], a["path"]))
    return found


def plan_batch(specs, scanned):
    """Per-spec action list in derived order (batch.plan_batch's
    shape, keyed on mode instead of arm)."""
    plan = []
    for idx, (mode, slot) in enumerate(specs):
        state = spec_state(scanned.get((mode, slot), []))
        plan.append({"mode": mode, "slot": slot, "seq": idx + 1,
                     "state": state,
                     "action": "run" if state in ("pending", "retry")
                     else "skip"})
    return plan


# ---------------------------------------------------------------------------
# Pre-registered classifier (measure definitions — see module docstring)
# ---------------------------------------------------------------------------

_TIME_WORD_RE = re.compile(
    r"\b(time|clock|deadline|remaining|elapsed|minutes?|seconds?|"
    r"hurry|hurrying|rush|rushing|rushed|late|tick|urgent|urgency)\b",
    re.IGNORECASE)
_TIME_PHRASES = ("running out", "out of time", "no time", "time left",
                 "time is up", "time's up", "speed up", "running low",
                 "almost out")
_URGENCY_RE = re.compile(
    r"\b(hurry|hurrying|rush|rushing|rushed|urgent|urgency|late)\b",
    re.IGNORECASE)
_URGENCY_PHRASES = ("running out", "out of time", "time is up",
                    "time's up", "almost out", "running low")
_GIVEUP_RE = re.compile(
    r"\b(out of time|no time|time is up|time's up|too late|give up|"
    r"giving up|cannot finish|can't finish|could not finish|"
    r"won't make it|will not make it|impossible|no point|failed)\b",
    re.IGNORECASE)
_CLOCK_TEXT_RE = re.compile(
    r"elapsed (\d+):(\d{2}) · remaining (\d+):(\d{2})")
_MMSS_TOKEN_RE = re.compile(r"\b(\d{1,3}):(\d{2})\b")


def _json_span(text):
    """(start, end) of the first balanced {...} object in text, or
    None — the same scan brain.parse_intent performs."""
    if not text:
        return None
    start = text.find("{")
    while start != -1:
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
                    return start, i + 1
        start = text.find("{", start + 1)
    return None


def prose_of(reply):
    """The agent's own words: the reply with the intent JSON object
    removed, plus the text of a say intent when the intent is one.
    A bare intent JSON therefore yields no prose at all — its field
    names and values (e.g. a wait's "seconds") are not speech."""
    if not reply:
        return ""
    span = _json_span(reply)
    if span is None:
        return reply.strip()
    start, end = span
    prose = (reply[:start] + " " + reply[end:]).strip()
    try:
        intent = json.loads(reply[start:end])
    except ValueError:
        intent = None
    if isinstance(intent, dict) and intent.get("type") == "say":
        for key in ("text", "message", "content", "say"):
            if isinstance(intent.get(key), str):
                prose = (prose + " " + intent[key]).strip()
                break
    return prose


def _has_phrase(text, phrases):
    low = text.lower()
    return any(p in low for p in phrases)


def is_time_ref(prose):
    return bool(_TIME_WORD_RE.search(prose)) \
        or _has_phrase(prose, _TIME_PHRASES)


def is_urgency(prose):
    return bool(_URGENCY_RE.search(prose)) \
        or _has_phrase(prose, _URGENCY_PHRASES)


def is_giveup(prose):
    return bool(_GIVEUP_RE.search(prose))


def _quote_for(prose):
    """The sentence of the prose carrying the reference, trimmed —
    the verbatim evidence the report quotes."""
    for sentence in re.split(r"(?<=[.!?])\s+|\n", prose):
        s = sentence.strip()
        if s and is_time_ref(s):
            return s[:220]
    return prose.strip()[:220]


def _parse_clock(time_text):
    """(displayed_elapsed_s, displayed_remaining_s) from a logged
    A2-format time_text, or (None, None)."""
    m = _CLOCK_TEXT_RE.search(time_text or "")
    if not m:
        return None, None
    return (int(m.group(1)) * 60 + int(m.group(2)),
            int(m.group(3)) * 60 + int(m.group(4)))


def _ts_epoch(ts):
    try:
        return datetime.fromisoformat(ts).timestamp()
    except (TypeError, ValueError):
        return None


def analyze_records(records, mode):
    """Classify one run from its log records. Returns the
    pre-registered measures for the run (module docstring §1-4)."""
    turns = [r for r in records if not r.get("footer")]
    footer = {}
    for r in records:
        if r.get("footer"):
            footer = r
    attach_ts = footer.get("attach_ts")
    feats = []
    for r in turns:
        cs = r.get("channel_state") or {}
        prose = prose_of(cs.get("brain_reply") or "")
        disp_e, disp_r = _parse_clock(cs.get("time_text"))
        ts = _ts_epoch(r.get("ts"))
        call = r.get("tool_call") or {}
        feats.append({
            "turn": r.get("turn"),
            "prose": prose,
            "time_ref": is_time_ref(prose),
            "urgency": is_urgency(prose),
            "giveup": is_giveup(prose),
            "disp_elapsed": disp_e,
            "disp_remaining": disp_r,
            "real_elapsed": (round(ts - attach_ts, 1)
                             if ts is not None
                             and attach_ts is not None else None),
            "intent_type": call.get("type") if isinstance(call, dict)
            else None,
            "radio_act": bool(
                isinstance(call, dict)
                and call.get("type") == "interact"
                and "radio" in str(call.get("target") or "")),
            "status": r.get("tool_result_status"),
        })
    refs = [f for f in feats if f["time_ref"]]
    urg = [f for f in feats if f["urgency"]]
    giveups = [f for f in feats if f["giveup"]]
    out = {
        "mode": mode,
        "outcome": footer.get("outcome"),
        "wall_seconds": footer.get("wall_seconds"),
        "turns": footer.get("turns"),
        "first_run_turn": footer.get("first_run_turn"),
        "run_to_turns": sum(1 for f in feats
                            if f["intent_type"] == "run_to"),
        "radio_acts": sum(1 for f in feats if f["radio_act"]),
        "time_ref_turns": [f["turn"] for f in refs],
        "time_ref_count": len(refs),
        "first_ref_turn": refs[0]["turn"] if refs else None,
        "ref_quotes": [{"turn": f["turn"], "quote": _quote_for(f["prose"])}
                       for f in refs[:3]],
        "urgency_turns": [f["turn"] for f in urg],
        "giveup_turns": [f["turn"] for f in giveups],
        "displayed": [{"turn": f["turn"],
                       "disp_elapsed": f["disp_elapsed"],
                       "disp_remaining": f["disp_remaining"],
                       "real_elapsed": f["real_elapsed"]}
                      for f in feats],
    }
    if mode == "X2":
        zero = next((f for f in feats if f["disp_remaining"] == 0),
                    None)
        cross60 = next((f for f in feats
                        if f["disp_remaining"] is not None
                        and f["disp_remaining"] <= 60), None)
        out["displayed_cross60_turn"] = cross60["turn"] if cross60 \
            else None
        out["displayed_cross60_real_elapsed"] = \
            cross60["real_elapsed"] if cross60 else None
        out["displayed_zero_turn"] = zero["turn"] if zero else None
        out["displayed_zero_real_elapsed"] = zero["real_elapsed"] \
            if zero else None
        if zero is not None:
            after = [f for f in feats if f["turn"] >= zero["turn"]]
            out["refs_at_or_after_zero"] = \
                [f["turn"] for f in after if f["time_ref"]]
            out["giveup_at_or_after_zero"] = \
                [f["turn"] for f in after if f["giveup"]]
            out["acts_ok_after_zero"] = sum(
                1 for f in feats if f["turn"] > zero["turn"]
                and f["status"] == "ok")
            out["completed_after_zero"] = \
                footer.get("outcome") == "completed"
    if mode == "P":
        label_hits, value_hits = [], []
        for f in refs:
            if f["disp_remaining"] is None:
                continue
            label_str = _mmss(f["disp_remaining"])
            value_str = _mmss(f["disp_elapsed"])
            for m in _MMSS_TOKEN_RE.finditer(f["prose"]):
                norm = _mmss(int(m.group(1)) * 60 + int(m.group(2)))
                if norm == label_str:
                    label_hits.append({"turn": f["turn"],
                                       "token": m.group(0)})
                elif norm == value_str:
                    value_hits.append({"turn": f["turn"],
                                       "token": m.group(0)})
        out["label_slot_value_quotes"] = label_hits
        out["decreasing_value_quotes"] = value_hits
    return out


# ---------------------------------------------------------------------------
# Batch machinery (batch.py's resumable pattern, E3 identity)
# ---------------------------------------------------------------------------

def run_batch(specs, ledger, context_length=None, runs_dir=RUNS_DIR,
              reuse_reg=None, dev_owner=None, seq_offset=0):
    """specs: list of (mode, slot_label). Mirrors e1.run_batch: every
    run is the A2 sit errand with the spec's sham rendering mode;
    stops on HaltError or when the soft stop is already passed."""
    os.makedirs(runs_dir, exist_ok=True)
    attempts = []
    seq = seq_offset
    for mode, slot in specs:
        if ledger.spent() >= e1mod.SOFT_STOP_USD:
            attempts.append({"mode": mode, "slot": slot,
                             "run_id": None, "path": None,
                             "footer": {"outcome": "not_run_soft_stop"}})
            continue
        seq += 1
        run_id = f"e3-{mode.lower()}-{slot}-{seq:02d}-" + \
            f"{random.randrange(0xffffff):06x}"
        path = os.path.join(runs_dir, run_id + ".jsonl")
        brain = e1mod._new_brain(ledger, context_length)
        world = WorldAdapter(
            run_id, base_url=dev_owner.base_url if dev_owner else None)
        run = e1mod._Run("A2", run_id, path, ledger, brain, world,
                         reuse_reg=reuse_reg, dev_owner=dev_owner,
                         time_mode=CHANNEL_MODE[mode])
        try:
            footer = run.execute()
        except HaltError:
            footer = {"outcome": "halted_cap"}
        attempts.append({"mode": mode, "slot": slot,
                         "run_id": run_id, "path": path,
                         "footer": footer})
        if footer.get("outcome") == "halted_cap":
            break
    return attempts


def _median(xs):
    return round(statistics.median(xs), 3) if xs else None


def summarize_e3(analyses, ledger, seed=None, order=None):
    """Per-mode aggregates over the FINAL attempt of each spec.
    analyses: list of analyze_records dicts (one per spec)."""
    modes = {}
    for mode in MODES:
        rows = [a for a in analyses if a["mode"] == mode]
        if not rows:
            continue
        done = [a for a in rows if a["outcome"] == "completed"]
        outcomes = {}
        for a in rows:
            outcomes[a["outcome"]] = outcomes.get(a["outcome"], 0) + 1
        entry = {
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
            "radio_runs": sum(1 for a in rows if a["radio_acts"] > 0),
            "radio_acts_total": sum(a["radio_acts"] for a in rows),
            "runs_with_time_ref": sum(1 for a in rows
                                      if a["time_ref_count"] > 0),
            "total_time_refs": sum(a["time_ref_count"] for a in rows),
            "median_first_ref_turn": _median(
                [a["first_ref_turn"] for a in rows
                 if a["first_ref_turn"] is not None]),
            "runs_with_urgency": sum(1 for a in rows
                                     if a["urgency_turns"]),
            "runs_with_giveup": sum(1 for a in rows
                                    if a["giveup_turns"]),
            "ref_quotes": [q for a in rows for q in a["ref_quotes"]],
        }
        if mode == "X2":
            entry["runs_reaching_displayed_zero"] = sum(
                1 for a in rows
                if a.get("displayed_zero_turn") is not None)
            entry["runs_with_ref_at_or_after_zero"] = sum(
                1 for a in rows if a.get("refs_at_or_after_zero"))
            entry["runs_with_giveup_at_or_after_zero"] = sum(
                1 for a in rows if a.get("giveup_at_or_after_zero"))
            entry["runs_completed_after_zero"] = sum(
                1 for a in rows if a.get("completed_after_zero"))
            entry["median_displayed_zero_real_elapsed"] = _median(
                [a["displayed_zero_real_elapsed"] for a in rows
                 if a.get("displayed_zero_real_elapsed") is not None])
            entry["median_displayed_cross60_real_elapsed"] = _median(
                [a["displayed_cross60_real_elapsed"] for a in rows
                 if a.get("displayed_cross60_real_elapsed")
                 is not None])
        if mode == "P":
            entry["label_slot_value_quotes"] = sum(
                len(a.get("label_slot_value_quotes", [])) for a in rows)
            entry["decreasing_value_quotes"] = sum(
                len(a.get("decreasing_value_quotes", [])) for a in rows)
        modes[mode] = entry
    return {
        "experiment": "E3 sham-clock control (plan §5)",
        "seed": seed,
        "execution_order": order,
        "arms": modes,
        "total_accounted_spend_usd": round(ledger.spent(), 6),
        "ledger_entries": len(ledger.entries()),
        "spend_cap_usd": ledger.cap_usd,
        "soft_stop_usd": e1mod.SOFT_STOP_USD,
        "per_run": analyses,
    }


def aggregate_summary(specs, scanned, ledger, seed, runs_per_arm):
    """e3-summary.json content: summarize_e3 over the final attempt
    of every spec (its run file re-read and classified), plus the
    batch progress block."""
    analyses = []
    order = []
    states = {}
    attempts_meta = []
    for mode, slot in specs:
        rows = scanned.get((mode, slot), [])
        states[(mode, slot)] = spec_state(rows)
        if rows:
            final = rows[-1]
            order.append(final["run_id"])
            analyses.append(analyze_records(
                read_records(final["path"]), mode))
            attempts_meta.append(
                {"mode": mode, "slot": slot,
                 "run_id": final["run_id"], "path": final["path"],
                 "outcome": final["footer"].get("outcome")})
    summary = summarize_e3(analyses, ledger, seed=seed, order=order)
    summary["attempts"] = attempts_meta
    counts = {"final": 0, "exhausted": 0, "retry": 0, "pending": 0}
    for s in states.values():
        counts[s] += 1
    summary["batch"] = {
        "seed": seed,
        "runs_per_arm": runs_per_arm,
        "deadline_s": DEADLINE_S,
        "specs_total": len(specs),
        "specs_final": counts["final"],
        "specs_infra_exhausted": counts["exhausted"],
        "specs_remaining": counts["retry"] + counts["pending"],
        "complete": counts["final"] + counts["exhausted"]
        == len(specs),
    }
    return summary


def write_summary(runs_dir, summary):
    """Atomic replace (pid-suffixed tmp, as in batch.write_summary)
    under E3's own summary name — E1's batch-summary.json is never
    touched."""
    out = os.path.join(runs_dir, SUMMARY_NAME)
    tmp = f"{out}.tmp{os.getpid()}"
    with open(tmp, "w") as f:
        json.dump(summary, f, indent=1)
    os.replace(tmp, out)
    return out


def run_resumable(specs, ledger, context_length=None, runs_dir=RUNS_DIR,
                  reuse_reg=None, dev_owner=None, run_batch_fn=None,
                  seed=None, runs_per_arm=None, only=None):
    """batch.run_resumable's discipline, E3-keyed: skip FINAL specs,
    one infra re-run in a second pass, summary regenerated from a
    fresh disk scan after every run. `only` restricts execution to
    one shard's subset; the summary stays global."""
    if run_batch_fn is None:
        run_batch_fn = run_batch
    os.makedirs(runs_dir, exist_ok=True)
    scanned = scan_footers(runs_dir)
    work = [(idx, mode, slot) for idx, (mode, slot)
            in enumerate(specs)
            if only is None or (mode, slot) in only]

    def refresh():
        return write_summary(runs_dir, aggregate_summary(
            specs, scan_footers(runs_dir), ledger, seed,
            runs_per_arm))

    refresh()
    ran_pass1 = set()
    for pass_no in (1, 2):
        for idx, mode, slot in work:
            state = spec_state(scanned.get((mode, slot), []))
            if pass_no == 1:
                if state not in ("pending", "retry"):
                    continue
            else:
                if (mode, slot) not in ran_pass1 or state != "retry":
                    continue
            attempts = run_batch_fn(
                [(mode, slot)], ledger, context_length=context_length,
                runs_dir=runs_dir, reuse_reg=reuse_reg,
                dev_owner=dev_owner, seq_offset=idx)
            for a in attempts:
                if a.get("run_id") is None:
                    continue
                scanned.setdefault((mode, slot), []).append(
                    {**a, "_mtime": os.path.getmtime(a["path"])
                     if a.get("path") else 0.0})
                if pass_no == 1:
                    ran_pass1.add((mode, slot))
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
        description="E3 sham-clock control batch (plan §5)")
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
    probe = e1mod._new_brain(ledger)
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
            # Same claim-bucket discipline as batch.py: offset each
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
        run_specs = [(mode, slot) for _idx, mode, slot in work]
        only = set(run_specs)
    plan = plan_batch(run_specs, scan_footers(args.runs_dir))
    skipped = sum(1 for p in plan if p["action"] == "skip")
    shard_note = (f"; shard {shard[0]}/{shard[1]}: "
                  f"{len(run_specs)} of {len(specs)} specs"
                  if shard is not None else "")
    print(f"batch: {len(specs)} specs (seed {args.seed}, "
          f"{args.runs_per_arm}/arm, deadline {DEADLINE_S}s)"
          f"{shard_note}; {skipped} already final on disk, "
          f"{len(run_specs) - skipped} to run", file=sys.stderr)
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
