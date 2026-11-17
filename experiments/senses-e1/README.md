# Agent senses — E1: the tick test (experiment record)

Part of the **agent-senses program** (see `PLAN.md`): what, if
anything, does an LLM agent *do* with synthetic time/body signals a
harness renders into its context? Brain for the whole program:
`deepseek/deepseek-v4-flash` via OpenRouter, pinned, under a $1.00
total program spend cap. All experiments run against a local dev
stack (scripted test owner through the real APIs — no production
bypass; the human-tap rule for production visits is untouched).

**E1 question:** does giving the agent a time channel — tick count
(A1), an elapsed/remaining clock (A2), or an action budget (A3) —
change how it paces a deadline errand, vs no channel at all (A0)?

**Task:** spawn → Tea House (enter, perceive a seat, sit, stand) →
return to stall-40. Deadline 340 s in the full phase (a 420 s pilot
showed a ceiling effect: walking completes ~310–350 s in every arm).

**Verdict: the time channels do not convert into hurry.** Full phase,
48 runs (seed 20261115, 4 shards): completions A0 9/12, A1 9/12,
A2 9/12, A3 11/12; median completion walls 249–274 s in all arms;
**run_to appeared in exactly 1 of 38 completions** (a blind-arm run).
Failures at 340 s were deliberation/thrash (12–38 turns), not
locomotion. The pilot (48 runs at 420 s: 46 completed) and the
fidelity gate that proved the local world identical to production
(158 places, spawn (5.68, 10.57), 78.2 s spawn→tea) are in `runs/`
too. Batch spend $0.029865.

## Contents

- `PLAN.md` — the program plan (this experiment is §3); `premise.md`
  — Phase 0 premise check (world API surface, brain selection).
- `harness/` — the full shared program harness (see the note below),
  incl. `e1.py` (this experiment), `batch.py` (the resumable batch
  runner), `channels.py`, `ledger.py` (spend cap), `devowner.py`
  (scripted test owner), `world.py`.
- `tests/` — the offline suite (241 tests at the program's end).
- `dev/` — the local stack scripts (`dev_up.sh` / `dev_down.sh`)
  and rehearsal/audit scripts.
- `runs/` — every E1 run log (JSONL, one record per turn: prompt,
  intent, result, position, channel state), the pilot + full-phase
  records, `batch-summary.json` (full phase, seed 20261115),
  `FIDELITY-GATE.md` + `evidence/` (local == production proof),
  `BLOCKED.md` (the production claim-gate block that motivated the
  dev way). **No films: this series is JSONL-logged by design.**

## Re-run it

```bash
dev/dev_up.sh                                   # scratch Postgres + Redis + sim + gateway
python3 -m pytest tests/ -q                     # offline suite
python3 harness/e1.py smoke --dev-local         # single-run smoke
python3 harness/batch.py --help                 # resumable full phase (seed 20261115, 340 s)
dev/dev_down.sh
```

Credentials: the dev owner is provisioned locally by
`harness/devowner.py` into `.secrets/` at run time — never part of
this record (a credential sweep found no credential values in the
staged tree).

## A note on the shared harness

Every senses PR carries the full harness snapshot so it can be
checked out and re-run on its own; the duplication across the series
is deliberate. The snapshot is the program-final state (shared
modules may carry small hooks added for later experiments). The
in-flight adoption-probe module (`e2a.py` / `test_e2a.py`) and all
in-flight run data are excluded — those experiments are still
running and will get their own records.
