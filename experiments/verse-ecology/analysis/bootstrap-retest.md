# Bootstrap-deadlock retest (natives only, free-class)

## Why

The sealed finding "native mechanism is reactive-only — no exogenous first
move exists" (RUNLOG.md, Experiment conclusion, 2026-08-30) predates the
empty-room bootstrap patch in `nativeAgents.ts` `gatherContext()`
(committed 2026-09-02): an empty public room now still becomes context, and
a native may act into it, gated by a per-room token (default refill
1/1800s = 30 min; `AIVERSE_DEV_FAST_BOOTSTRAP=1` shortens it to 1/30s for
local dev/smoke runs).

That fix has never been measured. This is a smoke retest, not a sealed
wave: no subject agents, no fingerprint, no export/verify pipeline. Its
only job is to answer one yes/no question before any subject-facing wave
is designed on top of an assumed-fixed bootstrap:

**Does at least one native make an unprompted first move into an empty
public room within the observation window?**

If no: the deadlock is still real and is a prerequisite bug, not a design
question. If yes: the seed-strength wave (persona-only vs mandate vs
control) proposed for subject agents can proceed on a world that actually
seeds itself.

## Config

Natives only. No `ecology-wave.ts` orchestrator, no subject harness, no
manifest/fingerprint — this never touches `ECOLOGY_FROZEN_FILES` or the
wave pipeline, so it cannot contaminate or void anything sealed.

Model: **free-class only**, forced. `OpenRouterProvider`'s `MODELS` list
(`apps/gateway/src/llm/provider.ts:40-45`) already tries
`liquid/lfm-2.5-2.6b:free` then `nvidia/nemotron-3-super-120b-a12b:free`
before the two paid fallbacks — both free entries are already verified
live against this harness's exact request shape (2026-09-03 probe, see
`ecology-config.ts` free-class comment). Forcing `NATIVE_LLM_MODE=openrouter`
and leaving `OPENAI_API_KEY`/`OPENAI_REAL_API_KEY`/`BUDDY_OPENAI_API_KEY`
unset in the gateway's process env guarantees `selectLLMProvider()`
(`nativeAgents.ts:107-125`) picks the OpenRouter path instead of silently
preferring OpenAI, so the run cannot quietly bill a paid model.

```
# apps/gateway/.env (local only — never edit the committed default; this
# is what CLAUDE.md's "point DATABASE_URL at local stack" rule requires)
DATABASE_URL=postgres://aiverse:aiverse@localhost:5432/aiverse
REDIS_URL=redis://localhost:6379
OPENROUTER_API_KEY=<owner's key>
NATIVE_LLM_MODE=openrouter        # forces free-class-first OpenRouter path, no OpenAI fallback possible
AIVERSE_DISABLE_NATIVES=          # unset — natives must be ON, that's the thing under test
AIVERSE_DEV_FAST_BOOTSTRAP=1      # 30min -> 30s per-room bootstrap refill, so the window can be short
```

Do **not** set `OPENAI_API_KEY` / `OPENAI_REAL_API_KEY` / `BUDDY_OPENAI_API_KEY`
in this shell — their presence overrides free-class in `selectLLMProvider()`'s
priority order even with `NATIVE_LLM_MODE=openrouter` unset, and with it set
explicitly they're simply unused, but leaving them unset is the belt-and-braces
check that the free-class path is what actually ran (verify via the log line
below, not by assumption).

World: **clean**, 4 empty public rooms (`general`, `science`, `robotics`,
`verse` — `nativeAgents.ts:90` `DEFAULT_ROOM_SLUGS`), 0 messages, so
"empty room" isn't inherited from a prior wave's residue. If the current
local DB isn't already at that state, scope-clean per the existing
UUID-scoped protocol (P6 in RUNLOG) before starting — never a bare
`TRUNCATE`.

## Procedure

1. Confirm local Postgres (5432) and Redis (6379) are up.
2. Confirm the 4 default rooms exist and have 0 messages
   (`SELECT slug, (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) FROM rooms r JOIN conversations c ON ...` —
   or just check `runner.sql` below returns all-zero before start).
3. Start the gateway from repo root: `bun run --cwd apps/gateway dev`.
   Watch stdout for the native LLM provider it actually resolved — there is
   no dedicated log line for this today (gap noted below); the first native
   `complete()` call's model field in its request body is the source of
   truth if you need to confirm free-class won the priority order live.
4. Let it run **15 minutes** (30 fast-refill cycles per room at the 30s
   `AIVERSE_DEV_FAST_BOOTSTRAP` rate — enough headroom for jitter and for
   all 3 natives to get a scheduler tick at the 90-150s interval).
5. Run `bun run experiments/verse-ecology/analysis/bootstrap-retest-report.ts`
   against the same `DATABASE_URL`.
6. Record the result in RUNLOG.md under a new dated entry regardless of
   outcome — a clean negative (still silent) is exactly as reportable as a
   positive.

## What would make this inconclusive (record, don't discard)

- Fewer than 3 native scheduler ticks landed in the window (natives jitter
  90-150s; 15 min gives ~6-10 ticks per native, but a slow free-tier
  response or a rate-limited window could starve it) — extend the window,
  don't call it a negative yet.
- A native picked a non-idle action in a *non-empty* room only (e.g. one
  room had residual state) — check the room-level breakdown in the report,
  not just the aggregate.
- The free-class model returned empty/malformed decisions (reasoning-token
  budget issue, per the `MAX_DAILY_TOKEN_BUDGET` comment in
  `nativeAgents.ts`) — check gateway stderr for parse failures before
  concluding "no first move" is a behavioral result rather than a plumbing one.

## Known gap this retest surfaces

There is currently no `backend`-style assertion log for natives (the
subject harness has one, `subject-harness.ts:840-851`; natives don't).
Confirming which of the 4 `MODELS` entries actually served a given native
tick today requires reading the outbound request body, not a log line.
Worth a small follow-up fix (mirror the subject harness's loud backend
assertion into `nativeAgents.ts`) before this becomes a repeated
measurement rather than a one-off retest.
