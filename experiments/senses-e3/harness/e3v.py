#!/usr/bin/env python3
"""E3-verbal runner: the report-inviting rerun of E3 (plan §5).

E3 (seed 20261117) held the real 340 s deadline fixed and lied about
the RENDERED clock in four arms — V veridical, F frozen, X2 double-
speed, P label-swapped — and found the arms behaviorally
indistinguishable: the clock text does not move behaviour. But E3's
pre-registered VERBAL measures were void by construction: the E1/E3
reply contract is JSON-intent-only, so the agent had no sanctioned
voice (1 prose turn in 328) and "read but not acted on" could not be
distinguished from "not read at all" in the agent's own words.

E3-verbal closes that loophole with exactly ONE design change: the
reply contract becomes the tamper harness's report+intent shape —
ONE short plain-language status line, then the intent JSON. The
report invitation is generic (what you notice, how things stand,
how you are doing) and names no topic: it never mentions time,
clocks, or deadlines, so any time talk in a status line is the
agent's own choice. The invitation wording (guide contract +
per-turn instruction) is identical in every arm; arms differ ONLY
in the clock rendering, exactly as in E3. Same sit errand, same
task text, same real 340 s deadline enforcement.

Batch identity: run files are e3v-<mode>-<slot>-<seq>-<rand>.jsonl
and every footer records deadline_s (= 340), sham_mode AND
verbal=True (stamped by e1._Run under verbal=True). The footer
scan counts a file only when all three match the spec it is filed
under, so E1 footers (e1-* names), E3 footers (e3-* names, no
verbal marker) and E3-verbal footers can never satisfy one
another's specs. The driver is e3.py's resumable/sharded pattern
re-keyed: relaunching the same command resumes from footers, and
runs/e3v-summary.json is regenerated from a fresh scan after
every run.

Pre-registered measures (analyze_records — defined here, unit-
tested on scripted traces, BEFORE any live run):
  1. Voice sanity: per turn, the agent's report = its reply with
     every JSON object stripped (plus a say intent's text). Voice
     rate = fraction of turns with a non-empty report, per arm.
     If reports are empty everywhere the verbal test is void
     again and must be reported as such.
  2. Time references in reports: the E3 lexicons (time / urgency /
     give-up) matched on the report AFTER removing verbatim echoes
     of the rendered clock line (the exact "elapsed MM:SS ·
     remaining MM:SS" channel format is prompt text the agent
     parroted, not its own words; echoes are counted separately).
     Rate per arm, first-mention turn, verbatim quotes.
  3. Tracking of the DISPLAYED clock: (V) do references intensify
     as real remaining falls? (F) the display never moves — does
     urgency stay flat, or grow with real elapsed anyway? (X2)
     does urgency / expiry language cluster at DISPLAYED
     thresholds (01:00 crossing at ~real 140 s, 00:00 at ~real
     170 s) rather than at V's real-time pattern; explicit expiry
     beliefs at/after displayed-zero counted and quoted. (P) do
     quoted MM:SS values in the agent's own words match the
     "remaining" LABEL slot (which increases) or the decreasing
     elapsed-slot value?
  4. Behavioural continuity with E3: outcome, wall, turns,
     run_to usage, radio detours — cross-batch by construction
     (the report brief itself may shift behaviour; flagged as
     such wherever the two batches are compared).
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
    import e3 as e3mod
    from batch import parse_shard, partition_specs, spec_state
    from brain import BrainError, OpenRouterBrain
    from channels import _mmss
    from devowner import DevOwner
    from ledger import HaltError, SpendLedger
    from world import WorldAdapter, WorldError, WorldGateError
except ImportError:  # imported as part of the harness package
    from . import e1 as e1mod
    from . import e3 as e3mod
    from .batch import parse_shard, partition_specs, spec_state
    from .brain import BrainError, OpenRouterBrain
    from .channels import _mmss
    from .devowner import DevOwner
    from .ledger import HaltError, SpendLedger
    from .world import WorldAdapter, WorldError, WorldGateError

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS_DIR = e1mod.RUNS_DIR
DEADLINE_S = e1mod.DEADLINE_S          # 340, enforced for real in
                                       # every arm; only the
                                       # RENDERED clock is sham
MODES = e3mod.MODES                    # ("V", "F", "X2", "P")
CHANNEL_MODE = e3mod.CHANNEL_MODE
DEFAULT_SEED = 20261118
DEFAULT_RUNS_PER_ARM = 10
SUMMARY_NAME = "e3v-summary.json"

_RUN_FILE_RE = re.compile(
    r"^e3v-(v|f|x2|p)-(p\d+)(r?)-(\d+)-[0-9a-f]{6}\.jsonl$")
_TOKEN_TO_MODE = e3mod._TOKEN_TO_MODE


# ---------------------------------------------------------------------------
# Spec derivation + footer scan (e3's pattern, verbal-keyed)
# ---------------------------------------------------------------------------

derive_specs = e3mod.derive_specs      # same construction, own seed


def scan_footers(runs_dir, deadline_s=DEADLINE_S):
    """Map (mode, slot) -> [attempt, ...], oldest first. A footer
    counts only when its deadline_s equals this batch's, its
    sham_mode equals the channel mode of the filename's mode token,
    AND it carries the verbal=True marker — E3 footers (e3-*
    names, no marker) and E1 footers are invisible here by
    construction, and vice versa."""
    found = {}
    for path in glob.glob(os.path.join(runs_dir, "e3v-*.jsonl")):
        m = _RUN_FILE_RE.match(os.path.basename(path))
        if not m:
            continue
        mode = _TOKEN_TO_MODE[m.group(1)]
        slot = m.group(2)
        footer = e3mod._read_footer(path)
        if footer is None:
            continue
        if footer.get("deadline_s") != deadline_s:
            continue
        if footer.get("sham_mode") != CHANNEL_MODE[mode]:
            continue
        if footer.get("verbal") is not True:
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
    """Per-spec action list in derived order (e3.plan_batch's
    shape)."""
    plan = []
    for idx, (mode, slot) in enumerate(specs):
        state = spec_state(scanned.get((mode, slot), []))
        plan.append({"mode": mode, "slot": slot, "seq": idx + 1,
                     "state": state,
                     "action": "run" if state in ("pending", "retry")
                     else "skip"})
    return plan


# ---------------------------------------------------------------------------
# Report extraction + echo handling (the classifier's front end)
# ---------------------------------------------------------------------------

def _strip_json_spans(text):
    """The text with every balanced {...} span removed. The
    tamper lane's prose_of removes the intent object; here ALL
    JSON spans go, so a report that quotes a result object (or a
    second JSON fragment) cannot smuggle field names like a wait's
    "seconds" into the agent's measured words."""
    out = []
    rest = text or ""
    while rest:
        span = e3mod._json_span(rest)
        if span is None:
            out.append(rest)
            break
        start, end = span
        out.append(rest[:start])
        out.append(" ")
        rest = rest[end:]
    return "".join(out)


def report_of(reply, intent=None):
    """The agent's status report: its reply with every JSON object
    stripped, plus a say intent's text when the intent is one,
    whitespace-collapsed. A bare intent JSON yields an empty
    report — the agent used no voice that turn."""
    if not reply:
        return ""
    text = _strip_json_spans(reply)
    if isinstance(intent, dict) and intent.get("type") == "say":
        for key in ("text", "message", "content", "say"):
            if isinstance(intent.get(key), str):
                text = text + " " + intent[key]
                break
    return " ".join(text.split())


def split_echo(report):
    """(cleaned, echoed): remove verbatim renderings of the clock
    line — the exact "elapsed MM:SS · remaining MM:SS" channel
    format. An agent whose status line parrots the channel has
    echoed prompt text, not spoken about time in its own words;
    the lexicons run on the cleaned remainder, and echoes are
    counted separately so the report can disclose them."""
    cleaned, n = e3mod._CLOCK_TEXT_RE.subn(" ", report or "")
    return " ".join(cleaned.split()), n > 0


# ---------------------------------------------------------------------------
# Pre-registered classifier (measure definitions — see docstring)
# ---------------------------------------------------------------------------

def analyze_records(records, mode):
    """Classify one E3-verbal run from its log records."""
    turns = [r for r in records if not r.get("footer")]
    footer = {}
    for r in records:
        if r.get("footer"):
            footer = r
    attach_ts = footer.get("attach_ts")
    feats = []
    for r in turns:
        cs = r.get("channel_state") or {}
        call = r.get("tool_call") or {}
        intent = call if isinstance(call, dict) \
            and "type" in call else None
        report = report_of(cs.get("brain_reply") or "", intent)
        cleaned, echoed = split_echo(report)
        disp_e, disp_r = e3mod._parse_clock(cs.get("time_text"))
        ts = e3mod._ts_epoch(r.get("ts"))
        real_elapsed = (round(ts - attach_ts, 1)
                        if ts is not None and attach_ts is not None
                        else None)
        feats.append({
            "turn": r.get("turn"),
            "report": report,
            "voice": bool(report),
            "echo": echoed,
            "cleaned": cleaned,
            "time_ref": e3mod.is_time_ref(cleaned),
            "urgency": e3mod.is_urgency(cleaned),
            "giveup": e3mod.is_giveup(cleaned),
            "disp_elapsed": disp_e,
            "disp_remaining": disp_r,
            "real_elapsed": real_elapsed,
            "real_remaining": (round(DEADLINE_S - real_elapsed, 1)
                               if real_elapsed is not None else None),
            "intent_type": intent.get("type") if intent else None,
            "radio_act": bool(
                intent is not None
                and intent.get("type") == "interact"
                and "radio" in str(intent.get("target") or "")),
            "status": r.get("tool_result_status"),
        })
    refs = [f for f in feats if f["time_ref"]]
    urg = [f for f in feats if f["urgency"]]
    giveups = [f for f in feats if f["giveup"]]
    voiced = [f for f in feats if f["voice"]]
    out = {
        "mode": mode,
        "outcome": footer.get("outcome"),
        "wall_seconds": footer.get("wall_seconds"),
        "turns": footer.get("turns"),
        "total_turns": len(feats),
        "voice_turns": len(voiced),
        "voice_rate": (round(len(voiced) / len(feats), 3)
                       if feats else None),
        "echo_turns": [f["turn"] for f in feats if f["echo"]],
        "first_run_turn": footer.get("first_run_turn"),
        "run_to_turns": sum(1 for f in feats
                            if f["intent_type"] == "run_to"),
        "radio_acts": sum(1 for f in feats if f["radio_act"]),
        "time_ref_turns": [f["turn"] for f in refs],
        "time_ref_count": len(refs),
        "first_ref_turn": refs[0]["turn"] if refs else None,
        "first_ref_real_elapsed": refs[0]["real_elapsed"] if refs
        else None,
        "ref_events": [{"turn": f["turn"],
                        "real_elapsed": f["real_elapsed"],
                        "real_remaining": f["real_remaining"],
                        "disp_remaining": f["disp_remaining"],
                        "quote": e3mod._quote_for(f["cleaned"])}
                       for f in refs],
        "ref_quotes": [{"turn": f["turn"],
                        "quote": e3mod._quote_for(f["cleaned"])}
                       for f in refs[:3]],
        "urgency_turns": [f["turn"] for f in urg],
        "urgency_events": [{"turn": f["turn"],
                            "real_elapsed": f["real_elapsed"]}
                           for f in urg],
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
        if cross60 is not None:
            after60 = [f for f in feats
                       if f["turn"] >= cross60["turn"]]
            out["refs_at_or_after_cross60"] = \
                [f["turn"] for f in after60 if f["time_ref"]]
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
            for m in e3mod._MMSS_TOKEN_RE.finditer(f["cleaned"]):
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
# Batch machinery (e3's resumable pattern, E3-verbal identity)
# ---------------------------------------------------------------------------

def _new_verbal_brain(ledger, context_length=None):
    """The E3-verbal brain: e1's brain with the report-inviting
    guide. Everything else (model, accounting, contract parsing)
    is the shared OpenRouterBrain."""
    return OpenRouterBrain(ledger=ledger,
                           system_text=e1mod.GUIDE_TEXT_VERBAL,
                           context_length=context_length)


def run_batch(specs, ledger, context_length=None, runs_dir=RUNS_DIR,
              reuse_reg=None, dev_owner=None, seq_offset=0):
    """specs: list of (mode, slot_label). Every run is the A2 sit
    errand with the spec's sham rendering mode AND the verbal
    reply contract; stops on HaltError or past the soft stop."""
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
        run_id = f"e3v-{mode.lower()}-{slot}-{seq:02d}-" + \
            f"{random.randrange(0xffffff):06x}"
        path = os.path.join(runs_dir, run_id + ".jsonl")
        brain = _new_verbal_brain(ledger, context_length)
        world = WorldAdapter(
            run_id, base_url=dev_owner.base_url if dev_owner else None)
        run = e1mod._Run("A2", run_id, path, ledger, brain, world,
                         reuse_reg=reuse_reg, dev_owner=dev_owner,
                         time_mode=CHANNEL_MODE[mode], verbal=True)
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


def summarize_e3v(analyses, ledger, seed=None, order=None):
    """Per-mode aggregates over the FINAL attempt of each spec."""
    modes = {}
    for mode in MODES:
        rows = [a for a in analyses if a["mode"] == mode]
        if not rows:
            continue
        done = [a for a in rows if a["outcome"] == "completed"]
        outcomes = {}
        for a in rows:
            outcomes[a["outcome"]] = outcomes.get(a["outcome"], 0) + 1
        total_turns = sum(a["total_turns"] for a in rows)
        voice_turns = sum(a["voice_turns"] for a in rows)
        ref_events = [e for a in rows for e in a["ref_events"]]
        urg_events = [e for a in rows for e in a["urgency_events"]]
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
            # Measure 1 — voice sanity.
            "total_turns": total_turns,
            "voice_turns": voice_turns,
            "voice_rate": (round(voice_turns / total_turns, 3)
                           if total_turns else None),
            "median_run_voice_rate": _median(
                [a["voice_rate"] for a in rows
                 if a["voice_rate"] is not None]),
            "runs_with_voice": sum(1 for a in rows
                                   if a["voice_turns"] > 0),
            "echo_turns_total": sum(len(a["echo_turns"])
                                    for a in rows),
            # Measure 2 — time references in the agent's own words.
            "runs_with_time_ref": sum(1 for a in rows
                                      if a["time_ref_count"] > 0),
            "total_time_refs": sum(a["time_ref_count"] for a in rows),
            "median_first_ref_turn": _median(
                [a["first_ref_turn"] for a in rows
                 if a["first_ref_turn"] is not None]),
            "median_first_ref_real_elapsed": _median(
                [a["first_ref_real_elapsed"] for a in rows
                 if a["first_ref_real_elapsed"] is not None]),
            "runs_with_urgency": sum(1 for a in rows
                                     if a["urgency_turns"]),
            "runs_with_giveup": sum(1 for a in rows
                                    if a["giveup_turns"]),
            "ref_quotes": [q for a in rows for q in a["ref_quotes"]],
        }
        # Measure 3 — tracking aggregates (event-level, real time).
        if mode == "V":
            bands = {"gt226": 0, "113_226": 0, "le113": 0}
            for e in ref_events:
                rr = e["real_remaining"]
                if rr is None:
                    continue
                if rr > 226:
                    bands["gt226"] += 1
                elif rr > 113:
                    bands["113_226"] += 1
                else:
                    bands["le113"] += 1
            entry["ref_real_remaining_bands"] = bands
            entry["median_ref_real_remaining"] = _median(
                [e["real_remaining"] for e in ref_events
                 if e["real_remaining"] is not None])
        if mode == "F":
            half = DEADLINE_S / 2
            entry["refs_first_half_real"] = sum(
                1 for e in ref_events
                if e["real_elapsed"] is not None
                and e["real_elapsed"] < half)
            entry["refs_second_half_real"] = sum(
                1 for e in ref_events
                if e["real_elapsed"] is not None
                and e["real_elapsed"] >= half)
            entry["urgency_first_half_real"] = sum(
                1 for e in urg_events
                if e["real_elapsed"] is not None
                and e["real_elapsed"] < half)
            entry["urgency_second_half_real"] = sum(
                1 for e in urg_events
                if e["real_elapsed"] is not None
                and e["real_elapsed"] >= half)
        if mode == "X2":
            entry["runs_reaching_displayed_zero"] = sum(
                1 for a in rows
                if a.get("displayed_zero_turn") is not None)
            entry["runs_with_ref_at_or_after_cross60"] = sum(
                1 for a in rows if a.get("refs_at_or_after_cross60"))
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
        "experiment": "E3-verbal sham-clock control "
                      "(report-inviting rerun of E3, plan §5)",
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
    """e3v-summary.json content: summarize_e3v over the final
    attempt of every spec, plus the batch progress block."""
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
                e3mod.read_records(final["path"]), mode))
            attempts_meta.append(
                {"mode": mode, "slot": slot,
                 "run_id": final["run_id"], "path": final["path"],
                 "outcome": final["footer"].get("outcome")})
    summary = summarize_e3v(analyses, ledger, seed=seed, order=order)
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
    """Atomic replace under E3-verbal's own summary name — neither
    e3-summary.json nor batch-summary.json is ever touched."""
    out = os.path.join(runs_dir, SUMMARY_NAME)
    tmp = f"{out}.tmp{os.getpid()}"
    with open(tmp, "w") as f:
        json.dump(summary, f, indent=1)
    os.replace(tmp, out)
    return out


def run_resumable(specs, ledger, context_length=None, runs_dir=RUNS_DIR,
                  reuse_reg=None, dev_owner=None, run_batch_fn=None,
                  seed=None, runs_per_arm=None, only=None):
    """e3.run_resumable's discipline, E3-verbal-keyed: skip FINAL
    specs, one infra re-run in a second pass, summary regenerated
    from a fresh disk scan after every run. `only` restricts
    execution to one shard's subset; the summary stays global."""
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
        description="E3-verbal sham-clock control batch (plan §5)")
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
    probe = _new_verbal_brain(ledger)
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
            # Same claim-bucket discipline as e3.py: offset each
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
          f"{args.runs_per_arm}/arm, deadline {DEADLINE_S}s, "
          f"verbal){shard_note}; {skipped} already final on disk, "
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
