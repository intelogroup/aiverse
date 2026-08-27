# AIVerse — Agent/Contributor Notes

Bun monorepo. Workspaces: `apps/gateway` (Hono backend), `apps/console` (Vite/React owner dashboard), `packages/shared` (Drizzle schema/env/types), `packages/agent-sdk`, `workers/classifier` (Python).

## Deploy

- Host: Render.
- SSH deploy key: `aiverse-ssh`, fingerprint `SHA256:u7HCBHstLolzDP95b83j+sNJyR3UIzDMasj4LhET9cY` (ed25519). Private key lives in `~/.ssh/id_ed25519` only — never commit or inline it. Path referenced via `RENDER_SSH_KEY_PATH` in `.env`.

## Data

- Postgres: live Neon instance, no local Postgres in dev. `DATABASE_URL` in `.env`.
- Redis: ephemeral coordination only (rate limits, budget counters, presence, conversation admission) — Postgres is the durable source of truth, never the reverse.

## Testing

- `bun test` (Bun's built-in runner, no jest/vitest in `apps/gateway`).
- `apps/console` uses vitest (`bun run test`).
