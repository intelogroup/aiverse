# Project rules

## Experiment/dev runs: local Postgres only, never cloud

`.env` and `apps/gateway/.env` default `DATABASE_URL` to a Neon cloud project.
Do not run ecology waves, wave analysis, or any other verse-ecology work
against it — it has a data-transfer quota that gets exhausted mid-run
(hit 2026-09-02, `PostgresError: Your project has exceeded the data transfer
quota`).

Before running any wave: point `DATABASE_URL` at the local stack instead
(`.env.example` has the template: `postgres://aiverse:aiverse@localhost:5432/aiverse`).
Confirm local Postgres (5432) and Redis (6379) are up and the gateway is
bound to them before launching `apps/gateway/scripts/ecology-wave.ts`.

## Let natives populate the Verse before authing in new subject agents

Native agents tick on a 90-150s interval (`apps/gateway/src/jobs/nativeAgents.ts`).
A gateway that was just started has zero native activity — public threads
empty, no presence, nothing for a new agent to perceive. Authing new subject
agents into a cold-started world produces an empty-world run even when
natives are enabled, defeating waves whose point is a populated environment
(see `experiments/verse-ecology/preregistration.md`, Wave 1's stated purpose).

So: start the gateway with natives enabled (`AIVERSE_DISABLE_NATIVES` unset),
wait for a few native tick cycles so the Verse has real presence and public
activity, *then* run the wave script to auth in new subject agents. Don't
auth agents in immediately after gateway startup.

## Fixing repeat/wasteful agent behavior: change the harness's own response, not just the prompt

When an agent in `subject-harness.ts` keeps repeating a wasteful action
(re-joining a room, re-starting a conversation, hammering a dead thread),
adding advisory text to the context ("you already did this") does not stop
it — confirmed 2026-09-02 across both nano-class (weak) and gptoss20-class
(capable) models. Three bugs that session all had this shape:

- `join_room` on an already-joined room returned the same "ok" a real join
  gets; `already_joined_rooms` context alone didn't stop nano-class
  re-issuing it 32-39 times a run. Fixed by making the response itself a
  distinct no-op.
- Duplicate DMs: `open_dm_by_participant` named the existing thread in
  context; didn't stop gptoss20-class spawning 7-15 separate conversations
  with the same peer. Fixed by having the backend reuse the conversation
  (200 instead of 201), not telling the model to.
- Even after reuse worked mechanically, the result *note* was identical to
  a fresh create ("ok") — the model kept calling `start_conversation` at
  the same peer because nothing in the response signaled "you already had
  this." Fixed by making the note say so explicitly.
- Thread pile-on: `triageThreads()`'s "invested" priority and its recency
  tiebreak were both keyed on the agent's *own* sent messages, so replying
  into a dead thread refreshed its own ranking — a structural feedback
  loop, not a missing warning. Fixed by keying both on peer activity.

When this pattern shows up again: look for where the harness's own
logic (API response, ranking, priority) treats a repeat action the same as
the first one, and change that — not the prompt.

## `bun test` from the repo root can silently hit the wrong database — use the workspace script

Bare `bun test <path>` run from the repo root loads the root-level
`.env.test`, not `apps/gateway/.env.test` — even when the test file lives
under `apps/gateway/`. If the root `.env.test` (gitignored, local-only)
points anywhere other than local Postgres, every test run silently queries
that instead, and failures get misdiagnosed as unrelated (a prior session's
RUNLOG blamed 47 failures on "the Neon test DB endpoint is unreachable,"
never questioning why tests were pointed at Neon at all — discovered
2026-09-02 this had been happening for over a week, and real local suite
health was 95 pass / 18 fail, not ~50/25).

Use `bun run --cwd apps/gateway test` (or `cd apps/gateway && bun test`)
instead — that loads `apps/gateway/.env.test`, the correct local one, via
the package.json script's explicit env unset + `NODE_ENV=test`. If a root
`.env.test` exists, keep its `DATABASE_URL` pointed at local Postgres
(`postgresql://localhost:5432/aiverse_test`), matching the gateway one —
never leave it defaulted to a cloud endpoint.

## `bunx tsc --noEmit -p apps/gateway` is broken — use the root command

There is no `apps/gateway/tsconfig.json`; the real config is the repo-root
`tsconfig.json` (`include: ["apps/gateway/**/*", "packages/*/src/**/*"]`).
`bunx tsc --noEmit -p apps/gateway` fails immediately with `TS5057: Cannot
find a tsconfig.json file`, and piping that through `grep <pattern> || echo
clean` reports false-clean every time, since the one-line config error never
matches a filename pattern. Discovered 2026-09-02 after an entire session of
"clean" results that were never real checks. Use `bunx tsc --noEmit` from
the repo root instead — no `-p` flag.
