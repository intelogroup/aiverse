# Agent senses — E3-verbal: does the agent *talk* about the sham clock? (experiment record)

Part of the **agent-senses program** (see `PLAN.md`). Brain:
`deepseek/deepseek-v4-flash` via OpenRouter; $1.00 program cap;
local dev stack (scripted test owner, real APIs).

**Question:** E3's verbal measures were void — its reply contract
was JSON-only, so nobody ever mentioned time. E3-verbal reruns
E3's four sham-clock arms (V veridical / F frozen / X2
double-speed / P label-swapped; N=10 each, seed 20261118) with
**one change**: a report-inviting brief (a one-line status report
alongside the JSON intent; the invitation is generic and never
mentions time or clocks — test-pinned).

**Verdict: this SPLITS E3's verdict. The agent reads the clock,
believes the clock, and talks about the clock accurately — and
rarely runs for it.**

- Voice rate **1.00** (399/399 turns carried reports; zero verbatim
  clock echoes).
- Genuine time references (hand-audited; 7 of 21 classifier flags
  struck as idioms): **V 4** (all at true remaining ≤72 s —
  "hurry back to stall-40 before time runs out" at 5 s left),
  **F 0** (frozen display → zero time talk even at 285 s real),
  **X2 10** (urgency from displayed 110 s with 218 real seconds
  left; explicit *false* expiry beliefs at displayed 00:00 with
  158 real seconds left — "Time ran out and I never found the tea
  house — this task was impossible with the given world layout";
  3 X2 runs completed after displayed-zero), **P 0** (silence —
  the label-vs-value test is void, reported as such).
- Action: the veridical arm never ran despite spoken urgency;
  only X2's doubled display produced running (3/10 runs) vs 0/40
  in E3.

So E1/E3's null is an **action-conversion failure, not a reading
failure** — the same belief pattern as the tamper test (the feed
wins over the world), here applied to time. Batch spend $0.026215.

## Contents

`PLAN.md`, `premise.md`, the full shared `harness/` (this experiment
is `harness/e3v.py`), `tests/`, `dev/` stack scripts, and `runs/`:
all 40 run logs (JSONL, reports included), `e3v-summary.json`,
shard driver logs. **No films: JSONL-logged by design.**

## Re-run it

```bash
dev/dev_up.sh
python3 -m pytest tests/ -q
python3 harness/e3v.py --dev-local --seed 20261118 --runs-per-arm 10
dev/dev_down.sh
```

Credentials are provisioned locally into `.secrets/` at run time
and are never part of this record (sweep-verified). The shared
harness snapshot is the program-final state, duplicated across the
series so each PR stands alone; in-flight experiment modules and
run data are excluded.
