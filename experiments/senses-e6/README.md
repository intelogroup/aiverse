# Agent senses — E6: peripheral vision prototype (experiment record)

Part of the **agent-senses program** (see `PLAN.md` §8). Brain:
`deepseek/deepseek-v4-flash` via OpenRouter; $1.00 program cap;
local dev stack (scripted test owner, real APIs).

**Question:** does a per-turn **scene digest** — computed
harness-side from the `look` raycast class grid (sectors
ahead-left/center/ahead-right × near/mid/far × classes), one line,
~35 tokens — give the agent peripheral awareness it otherwise
lacks? Arms: P0 call-only (digest never shown; the runner still
calls `look` every turn for measurement parity), P1 digest,
P2 digest + change notes. Event: a scripted confederate enters the
Tea House at turn 4 and sits in a **side** sector. N=5/arm, 15 runs.

**Verdict: ceiling effect — the prototype was untestable as
staged.** P0 noticed **5/5**, P1 5/5, P2 5/5, all at 0 turns from
visibility, all in scene terms; zero greetings or act reactions.
The prediction that P0 would miss the event failed structurally:
the standard observation's scene list already names an arriving
body the moment it enters the perception cone, and the event was
staged 3.6–4.8 m away, dead inside that cone. This is **not**
evidence the digest is useless — the untested territory is events
the scene list does not narrate (behind the agent, or in the
15–40 m band beyond scene narration but inside look's 40 m plane).
Two more findings: **0 of 180 replies ever used the digest's
language or sectors**, and one genuine confabulation — a P2 agent
announced "I notice someone just walked through the door" on a
turn with zero bodies present (the standing instruction's phrasing
primed it). The manipulation held 15/15 (side-sector body pixels
229–481 at visibility). Batch spend $0.017112.

## Contents

`PLAN.md`, `premise.md`, the full shared `harness/` (this experiment
is `harness/e6.py`, incl. the PNG decoder + digest renderer),
`tests/`, `dev/` stack scripts, and `runs/`: all 15 run logs +
rehearsals (JSONL), `e6-summary.json`, `e6-summary-final.json`,
`e6-analysis.json`, batch/rehearsal outputs. **No films:
JSONL-logged by design.**

## Re-run it

```bash
dev/dev_up.sh
python3 -m pytest tests/ -q
python3 harness/e6.py batch --dev-local
dev/dev_down.sh
```

Credentials are provisioned locally into `.secrets/` at run time
and are never part of this record (sweep-verified). The shared
harness snapshot is the program-final state, duplicated across the
series so each PR stands alone; in-flight experiment modules and
run data are excluded.
