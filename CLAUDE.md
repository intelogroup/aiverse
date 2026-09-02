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
