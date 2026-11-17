#!/usr/bin/env python3
"""E1 full-phase resumable batch driver (plan §3).

The pilot batch (harness/e1.py mode "pilot") was killed three times
by runtime/VM restarts and had to be harvested by hand: e1.run_batch
keeps all state in memory and writes its summary only at the very
end. This driver wraps the same run machinery with disk-first state
so the full phase (120 runs, ~7 h) survives restarts — relaunching
the same command resumes where the last process died:

- The spec list is derived deterministically from (seed,
  runs_per_arm) with the exact construction e1.py's pilot main used,
  so a relaunch derives the identical order.
- Before each spec, the runs dir is consulted: a spec whose latest
  state is FINAL (a completed or failed_* footer — task data, never
  re-run) is skipped; a spec with one infra_failed footer is re-run
  once (two infra failures, or a gate-class infra failure, exhaust
  it); a spec with no footer at this batch's deadline runs normally.
- runs/batch-summary.json is regenerated from a fresh disk scan
  after EVERY run, so a summary exists even if the process dies
  mid-batch.

Batch identity on disk: a footer counts toward this batch only when
its recorded deadline_s equals the current e1.DEADLINE_S. Footers
written before deadline_s was recorded (the 420 s pilot's) are
legacy and never satisfy a later batch's specs — the pilot's data
stays the pilot's, even where slot labels overlap.

Sharding (--shard I/N): the derived spec list is partitioned by
list index modulo N and each shard process runs only its subset, so
N processes execute one batch concurrently (run walls are real-time
movement waits, not CPU — parallelism does not stretch them). A
shard's skip-scan still reads ALL footers, and every summary
regeneration re-scans the runs dir from disk before the global
atomic write, so concurrent writers converge on the same global
summary instead of overwriting each other's progress.
"""
import argparse
import glob
import json
import os
import random
import re
import sys

try:
    import e1 as e1mod
    from brain import BrainError
    from devowner import DevOwner
    from ledger import SpendLedger
    from world import WorldAdapter, WorldError, WorldGateError
except ImportError:  # imported as part of the harness package
    from . import e1 as e1mod
    from .brain import BrainError
    from .devowner import DevOwner
    from .ledger import SpendLedger
    from .world import WorldAdapter, WorldError, WorldGateError

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS_DIR = e1mod.RUNS_DIR
ARMS = e1mod.ARMS
DEADLINE_S = e1mod.DEADLINE_S
LEGACY_DEADLINE_S = 420   # footers without deadline_s are the pilot's
DEFAULT_SEED = 20261115   # fresh seed: the full phase's order is its
                          # own, independent of the pilot's
DEFAULT_RUNS_PER_ARM = 30

_RUN_FILE_RE = re.compile(
    r"^e1-(a\d)-(p\d+)(r?)-(\d+)-[0-9a-f]{6}\.jsonl$")


def derive_specs(seed, runs_per_arm):
    """The pilot's spec derivation, verbatim: arm-major spec list,
    shuffled with random.Random(seed). Seed 20261114 at 10/arm
    reproduces the pilot's 40 slots in order (pinned by tests)."""
    specs = [(arm, f"p{i}") for arm in ARMS
             for i in range(1, runs_per_arm + 1)]
    rng = random.Random(seed)
    rng.shuffle(specs)
    return specs


def parse_shard(text):
    """Parse a --shard value "I/N" into (index, count): this
    process is shard I of N. Raises ValueError on anything else."""
    try:
        idx_s, count_s = str(text).split("/")
        idx, count = int(idx_s), int(count_s)
    except (ValueError, AttributeError):
        raise ValueError(
            f"invalid --shard {text!r}: expected I/N, e.g. 0/4")
    if count < 1 or not 0 <= idx < count:
        raise ValueError(
            f"invalid --shard {text!r}: need 0 <= I < N, N >= 1")
    return idx, count


def partition_specs(specs, shard_index, shard_count):
    """This shard's work: [(global_idx, arm, slot), ...] for the
    specs whose position in the derived list is congruent to
    shard_index modulo shard_count. Disjoint across shards and
    complete over the list; global indices are kept so run
    filenames carry the same seq the unsharded batch assigns."""
    return [(idx, arm, slot) for idx, (arm, slot)
            in enumerate(specs) if idx % shard_count == shard_index]


def is_final_outcome(outcome):
    """Final = task data: completed, any failed_* outcome, or
    task_infeasible (the sim's own deterministic verdict). infra /
    halted / not-run outcomes are not data and never final."""
    return bool(outcome) and (outcome == "completed"
                              or outcome.startswith("failed_")
                              or outcome == "task_infeasible")


def _read_footer(path):
    """The footer record of a run file, or None. A file left by a
    killed process may have no footer (or a torn last line) — that
    run is not data and the spec stays eligible."""
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


def scan_footers(runs_dir, deadline_s=DEADLINE_S):
    """Map (arm, slot) -> [attempt, ...] from the run files on disk,
    oldest first. Only footers recorded at deadline_s count (legacy
    footers without the field are LEGACY_DEADLINE_S). Attempt dicts
    carry the same shape e1.run_batch returns."""
    found = {}
    for path in glob.glob(os.path.join(runs_dir, "e1-*.jsonl")):
        m = _RUN_FILE_RE.match(os.path.basename(path))
        if not m:
            continue
        arm = m.group(1).upper()
        slot = m.group(2)          # a trailing "r" (pilot-era re-run
                                   # label) folds into the base slot
        footer = _read_footer(path)
        if footer is None:
            continue
        if footer.get("deadline_s", LEGACY_DEADLINE_S) != deadline_s:
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


def spec_state(attempts):
    """One spec's resume state from its footers (oldest first):
    final | exhausted | retry | pending."""
    infra = 0
    for a in attempts:
        outcome = a["footer"].get("outcome")
        if is_final_outcome(outcome):
            return "final"
        if outcome == "infra_failed":
            infra += 1
            if "gate:" in str(a["footer"].get("reason") or ""):
                # Gate-class infra is deterministic until a human
                # acts (the pilot never re-ran these either).
                return "exhausted"
    if infra >= 2:
        return "exhausted"
    if infra == 1:
        return "retry"
    return "pending"


def plan_batch(specs, scanned):
    """Per-spec action list in derived order."""
    plan = []
    for idx, (arm, slot) in enumerate(specs):
        state = spec_state(scanned.get((arm, slot), []))
        plan.append({"arm": arm, "slot": slot, "seq": idx + 1,
                     "state": state,
                     "action": "run" if state in ("pending", "retry")
                     else "skip"})
    return plan


def aggregate_summary(specs, scanned, ledger, seed, runs_per_arm):
    """batch-summary.json content: e1.summarize over ALL footers on
    disk for this batch's specs (its final-attempt-per-spec stats),
    plus the batch progress block."""
    attempts = []
    order = []
    states = {}
    for arm, slot in specs:
        rows = scanned.get((arm, slot), [])
        states[(arm, slot)] = spec_state(rows)
        attempts.extend(rows)
        if rows:
            order.append(rows[-1]["run_id"])
    attempts.sort(key=lambda a: (a["_mtime"], a["path"]))
    clean = [{k: a[k] for k in ("arm", "slot", "run_id", "path",
                                "footer")} for a in attempts]
    summary = e1mod.summarize(clean, ledger, seed=seed, order=order)
    summary["experiment"] = "E1 full phase (plan §3) — resumable batch"
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
    """Atomic replace: a kill mid-write must not tear the summary.
    The tmp name carries the writer's pid so concurrent shard
    writers never share (and tear) one tmp file; os.replace makes
    each full-scan snapshot land atomically, last writer wins."""
    out = os.path.join(runs_dir, "batch-summary.json")
    tmp = f"{out}.tmp{os.getpid()}"
    with open(tmp, "w") as f:
        json.dump(summary, f, indent=1)
    os.replace(tmp, out)
    return out


def run_resumable(specs, ledger, context_length=None, runs_dir=RUNS_DIR,
                  reuse_reg=None, dev_owner=None, run_batch_fn=None,
                  seed=None, runs_per_arm=None, only=None):
    """Run every non-final spec in derived order, regenerating
    batch-summary.json from disk after every run. Infra failures get
    one re-run in a second pass (the pilot's end-of-batch rule).
    Returns the final summary dict.

    `only` (a set of (arm, slot)) restricts execution to one
    shard's subset; the summary still aggregates over the full
    `specs`. Every refresh re-scans the runs dir from disk, so a
    shard's summary reflects the other shards' footers too and
    concurrent writers converge."""
    if run_batch_fn is None:
        run_batch_fn = e1mod.run_batch
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
                # Second pass: only this invocation's own infra
                # failures get their one re-run.
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
        description="E1 full-phase resumable batch (plan §3)")
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
            # The claim route is bucketed per source address (5 per
            # 15 min) and each provision presents the next TEST-NET-2
            # address from the owner's sequence. Shards would
            # otherwise present the SAME addresses in lockstep and
            # exhaust each other's buckets; offsetting the sequence
            # gives every shard a disjoint address range.
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
    print(json.dumps(summary, indent=1))
    print(f"summary -> {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
