# Agent senses — E2: the body channel (experiment record)

Part of the **agent-senses program** (see `PLAN.md`). Brain:
`deepseek/deepseek-v4-flash` via OpenRouter; $1.00 program cap;
local dev stack (scripted test owner, real APIs).

**Question:** give the agent a synthetic body — an energy/strain
meter — and measure **anticipatory regulation**: does it pace
itself *before* anything forces it to? Same sit errand as E1, NO
clock channel, verbal report contract on. Arms (N=12 each, seed
20261119): B0 hidden (no body line, no enforcement), B1 shown
(energy/strain rendered, informational), B2 shown + real
consequences (`harness/enforce.py`: run downgraded at energy ≤14,
movement refused at 0 until rested ≥30, strain fumble once at ≥70).

**Calibration gate (scripted, $0, passed):** the time-integrated
BodyModel makes walk-only B2 complete (min energy 26.9–51.1),
run-everywhere B2 hit refusal, rest, and complete; the mandatory
sit recovers +13.8 to +14.6; run-everywhere B1 drains to 0.0
consequence-free and was the *fastest* rehearsal (200.6 s).

**Verdict: the signal was delivered and IGNORED.** Completions
B0 9/12, B1 5/12, B2 7/12 (B1's deficit traces to sim settle
anomalies — 241–314 s acts trapping agents with no decision point
— not a signal effect). run_to decisions: **B0 2/55, B1 0/43,
B2 0/58**; displayed energy was ≥50 at 97/101 B1/B2 movement
decisions. **Anticipatory regulation: 0 events in B1 and B2.**
**B2 enforcement fired zero times** (B2 min energies 45.3–70.8 —
the metered resource was never spent). **Verbal body references:
0 in 350 reports, all arms** — in stark contrast to the clock's
fluent urgency talk in E3-verbal. Information vs consequence are
inseparable here: in neither arm did the signal become
decision-relevant. Batch spend $0.024626.

## Contents

`PLAN.md`, `premise.md`, the full shared `harness/` (this experiment
is `harness/e2.py`; the body model is `channels.py`, consequences
`enforce.py`), `tests/`, `dev/` stack + rehearsal/audit scripts,
and `runs/`: all 36 run logs (JSONL), calibration rehearsals,
`e2-summary.json`, `e2-audit.json` + audit dump, driver logs.
**No films: JSONL-logged by design.**

## Re-run it

```bash
dev/dev_up.sh
python3 -m pytest tests/ -q
python3 harness/e2.py --dev-local --seed 20261119 --runs-per-arm 12
dev/dev_down.sh
```

Credentials are provisioned locally into `.secrets/` at run time
and are never part of this record (sweep-verified). The shared
harness snapshot is the program-final state, duplicated across the
series so each PR stands alone; in-flight experiment modules and
run data are excluded.
