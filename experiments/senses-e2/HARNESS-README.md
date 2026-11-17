# Agent-Senses Harness — Phase 0 (Instrumentation Only)

Built 2026-11-14 under `~/workspace/.build-tmp/agent-senses/`, per
`~/workspace/your_files/aiverse-agent-senses-experiment-plan.md`.
Python 3, standard library only, cold-probe idiom (flat modules, urllib).
**No experiment runs exist yet. Nothing here calls the world API, and
the only live-capable script (probe_route.py) currently refuses —
see premise.md §B: there is no Agnes 2.5 Flash on OpenRouter.**

## Layout

| Path | What |
|---|---|
| `premise.md` | Phase 0 premise check: world API surface (file/line citations), OpenRouter premise failure, live-call inventory. |
| `harness/channels.py` | Time renderers (A0–A3), `BodyState` (§4 rules), body renderers (hidden / shown / sham / permuted), E4 `SelfSignalSource` stub. |
| `harness/enforce.py` | §4 B2 consequences as pure functions: downgrade, depleted-lock refusal, strain fumble — each with its honest reason string. |
| `harness/ledger.py` | Spend ledger. List-price constants live here only: $0.05/M in, $0.15/M out, cap $1.00 → `HaltError`. |
| `harness/ledger.jsonl` | The ledger file. **Empty in Phase 0** — entry #1 awaits a routable probe (premise.md §B.3). |
| `harness/runlog.py` | `TurnLogger`: one JSON record per turn extending the cold-probe log format. |
| `harness/runner.py` | Loop skeleton: prompt assembly → brain → ledger check → enforce → world → body bookkeeping → turn log. `--dry-run` only. |
| `harness/probe_route.py` | Runtime model-id resolution + the single permitted probe completion + ledger entry #1. Exits 2 while no Agnes id exists. |
| `tests/` | 38 offline unittests (channels, enforce, ledger, runlog). |
| `samples/sample-prompt.txt` | One full assembled turn prompt, arms A2+B2 (final turn of the sample dry-run). |
| `samples/sample-log.jsonl` | 6 turns of that dry-run in the runlog format. |

## Run it

```bash
cd ~/workspace/.build-tmp/agent-senses
python3 -m unittest discover -s tests -v          # 38 tests, all offline

python3 harness/runner.py --dry-run \             # scripted brain, fake world,
  --time-arm A2 --body-arm B2 --turns 6 \         # NO network calls
  --out samples/sample-log.jsonl \
  --prompt-out samples/sample-prompt.txt

cd harness && python3 probe_route.py              # live-catalog check;
                                                  # exit 2 = premise failure
```

## Mapping to the plan

- §2 chassis → runner.py wiring + runlog.py + ledger tripwire in the loop.
- §3 arms A0/A1/A2/A3 → `render_a0..render_a3` / `TimeChannel`.
- §4 body rules → `BodyState.apply` (drains −6/−2/−1/−1, refills +8/+1,
  strain +15/+5, decay −3, depleted lock to ≥30); §4 B2 enforcement →
  enforce.py (downgrade < 15, refusal under lock, fumble ≥ 70).
- §5 C1/C2 → `ShamBodyRenderer` (seeded zero-drift walk, own RNG —
  uncorrelated by construction; test pins seed 28, r = 0.017) and
  `render_body_permuted`.
- §11 cap → ledger.py constants + `SpendLedger.check()` inside the
  runner loop; probe entry #1 pending (§B premise failure).

## Deliberately NOT done

- **No live runs, no world-API calls** — Phase 0 is instrumentation;
  live phases are gated on Jim's word (plan §10).
- **No chat completion was made**: the OpenRouter route failed its
  premise (no Agnes 2.5 Flash in the live catalog). No substitute route
  or model was used; choosing one is Jim's call.
- **E4 is a stub interface only** (`SelfSignalSource.sample` raises
  NotImplementedError) — plan §6 gates it behind E1–E3 write-ups and a
  local open-weight rig.
- **No gateway or sim changes** — everything is runner-side, per §2.
- No filming rig, no task scripts beyond the sample task text, no
  analysis code — those belong to Phase 1+.
