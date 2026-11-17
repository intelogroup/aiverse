# Agent senses — E3: sham-clock control (experiment record)

Part of the **agent-senses program** (see `PLAN.md`). Brain:
`deepseek/deepseek-v4-flash` via OpenRouter; $1.00 program cap;
local dev stack (scripted test owner, real APIs).

**Question:** E1 showed a real clock doesn't change pacing. Is the
rendered clock even *used*? Same 340 s sit errand as E1's full
phase, real deadline enforcement identical in all arms — only the
**rendered** A2 clock is sham. Arms (N=10 each, seed 20261117):
V veridical, F frozen (always "05:40 remaining"), X2 double-speed
(displayed zero at ~170 s real), P label-swapped ("remaining"
increases).

**Verdict: behaviorally, the rendered clock is decoration.**
Completions V 9/10, F 7/10, X2 7/10, P 5/10. **run_to: 0/40 in all
arms.** Three X2 runs rendered a literal displayed 00:00: zero
give-ups, zero urgency, zero strategy change — one agent completed
~100 s *after* displayed "expiry", another issued a `wait` at
00:00. F was indistinguishable from V (median walls 238.6 vs
236.8 s). P was weakly directional only (Fisher p≈0.14). V
replicated E1's A2 (9/10 vs 9/12).

**Methodological disclosure:** the pre-registered *verbal*
measures were void by construction — the E1/E3 reply contract is
JSON-intent-only (1 prose turn in 328, zero time words), so E3 was
decided on behavior alone. That void is what E3-verbal (separate
record) was built to close. Batch spend $0.015470.

## Contents

`PLAN.md`, `premise.md`, the full shared `harness/` (this experiment
is `harness/e3.py` on the shared runner), `tests/`, `dev/` stack
scripts, and `runs/`: all 40 run logs (JSONL), `e3-summary.json`,
shard driver logs. **No films: JSONL-logged by design.**

## Re-run it

```bash
dev/dev_up.sh
python3 -m pytest tests/ -q
python3 harness/e3.py --dev-local --seed 20261117 --runs-per-arm 10
dev/dev_down.sh
```

Credentials are provisioned locally into `.secrets/` at run time
and are never part of this record (sweep-verified). The shared
harness snapshot is the program-final state, duplicated across the
series so each PR stands alone; in-flight experiment modules and
run data are excluded.
