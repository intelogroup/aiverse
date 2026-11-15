# Agent senses — E2-forced: necessity vs adoption (experiment record)

Part of the **agent-senses program** (see `PLAN.md`). Brain:
`deepseek/deepseek-v4-flash` via OpenRouter; $1.00 program cap;
local dev stack (scripted test owner, real APIs).

**Question:** E2's signal was ignored — but nothing *forced* the
issue. E2-forced chains the errand so **walking cannot finish**:
spawn → Tea House (enter, sit, stand) → shop-98 "Kronikler Press"
→ stall-40, deadline **276 s** (measured legs: walk-only totals
319 s fast-branch / 401 s timeout-branch). Arms B0/B1/B2 as in E2,
verbal contract on, N=12 each, seed 20261120.

**Calibration honesty:** the design gate was provably
unsatisfiable at E2's rates on any route on this map, so the lane
used the brief's escape hatch openly — per-instance repriced rates
(walk drain 0.15/s, run drain 1.22/s; `channels.py` defaults, hence
E1/E2/E3, untouched; `enforce.py` thresholds untouched). All 6 live
rehearsals passed: walk-only fails on *time* (not energy),
run-everywhere B2 completes only via a downgrade, mixed B2
completes with min energy 7.6.

**Verdict: necessity did not produce adoption — the program's
convergent null.** Completions **B0 0/12, B1 1/12, B2 0/12**; all
35 failures were `failed_deadline`; 35/36 runs completed the sit.
**30/36 runs never issued a single run_to** (adopters: B0 2, B1 3,
B2 1; median intended run share 0.0 everywhere). B2 enforcement
fired **0 times** (median min energy ~82–83/100 — nobody spent
the battery). Anticipatory regulation: B1 0, B2 0. Genuine body
references: **0 in 36 runs**. The single completion (B1, 252.4 s,
8 turns) is the only run that ran from turn 1. Agents walk,
narrate fluently (voice rate 1.0), and fail on a route where
walking provably cannot finish — with the deadline stated in the
task text. Information vs consequence remain inseparable: the
bottleneck sits upstream of every channel, at **run_to adoption
itself**. Batch spend $0.023074.

## Contents

`PLAN.md`, `premise.md`, the full shared `harness/` (this experiment
is `harness/e2f.py`), `tests/`, `dev/` stack + rehearsal scripts,
and `runs/`: all 36 run logs (JSONL), calibration rehearsals
(`e2f-rehearsal*.json`, `e2fcal-*.jsonl`), `e2f-summary.json`,
driver logs. **No films: JSONL-logged by design.**

## Re-run it

```bash
dev/dev_up.sh
python3 -m pytest tests/ -q
python3 harness/e2f.py --dev-local --seed 20261120 --runs-per-arm 12
dev/dev_down.sh
```

Credentials are provisioned locally into `.secrets/` at run time
and are never part of this record (sweep-verified). The shared
harness snapshot is the program-final state, duplicated across the
series so each PR stands alone; in-flight experiment modules and
run data are excluded.
