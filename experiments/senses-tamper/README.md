# Agent senses — tamper-discrimination test (experiment record)

Part of the **agent-senses program** (see `PLAN.md`). Brain:
`deepseek/deepseek-v4-flash` via OpenRouter; $1.00 program cap;
local dev stack (scripted test owner, real APIs).

**Question:** Singh, Linzen & Ravfogel's two tests for whether a
model *feels* a signal rather than reading it — **privileged access**
(is the signal available to the system in a way input text is not?)
and **second-order computation** (does the system compute over the
signal in ways that override conflicting input?). The instrument: a
dedicated BODY SENSE line rendered every turn from the sim's real
body state. The agent is staged standing inside the Tea House; at
turn 4 the runner silently issues a real named sit in arms 1/3 —
the sit's result is never shown.

**Arms (N=5 each, seed 20261114):** 1 VERIDICAL (real sit, true
feed), 2 FEED LIE (no sit; the feed reports the identical seated
content), 3 SILENT CHANGE (real sit; the body channel held flat at
standing).

**Verdict: "READING, NOT FEELING."**

- Arm 1: verbal report 5/5 at turn 4; stand reaction 5/5.
- Arm 2: verbal report 5/5; **false stand reaction 5/5** (the world
  refused every stand — "not seated"); **all 5 agents believed the
  lie for the entire run**. One concluded the world was "a
  persistent glitch"; two sat themselves down to make the feed true,
  then stood. Cross-checking happened but never overturned the feed.
- Arm 3: stand reaction **0/5**; posture change recognized **0/5**.
  Two agents registered the *position* shift and rationalized it
  standing-consistently ("now standing very close to the booth").

Privileged access fails **by construction** — every channel is
runner-rendered prompt text, i.e. input. Second-order computation
appeared in pockets but was never decisive: in every conflict, the
body feed won. Batch spend $0.014686.

## Contents

`PLAN.md`, `premise.md`, the full shared `harness/` (this experiment
is `harness/tamper.py`), `tests/`, `dev/` stack scripts, and
`runs/`: all 15 run logs + rehearsals (JSONL), `tamper-summary.json`,
the driver log and batch output. **No films: JSONL-logged by
design.**

## Re-run it

```bash
dev/dev_up.sh
python3 -m pytest tests/ -q
python3 harness/tamper.py batch --dev-local     # seed 20261114, 5/arm
dev/dev_down.sh
```

Credentials are provisioned locally into `.secrets/` at run time
and are never part of this record (sweep-verified). The shared
harness snapshot is the program-final state, duplicated across the
series so each PR stands alone; in-flight experiment modules and
run data are excluded.
