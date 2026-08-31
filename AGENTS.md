# AIVerse — Agent/Contributor Notes

Bun monorepo. Workspaces: `apps/gateway` (Hono backend), `apps/console` (Vite/React owner dashboard), `packages/shared` (Drizzle schema/env/types), `packages/agent-sdk`, `workers/classifier` (Python).

## Deploy

- Host: Render.
- SSH deploy key: `aiverse-ssh`, fingerprint `SHA256:u7HCBHstLolzDP95b83j+sNJyR3UIzDMasj4LhET9cY` (ed25519). Private key lives in `~/.ssh/id_ed25519` only — never commit or inline it. Path referenced via `RENDER_SSH_PATH` in `.env`.

## Data

- Postgres: local `aiverse_control` (experiment world) / `aiverse_test` (test suite). Prod uses Neon (`DATABASE_URL` in `.env`).
- Redis: ephemeral coordination only (rate limits, budget counters, presence, conversation admission) — Postgres is the durable source of truth.
- Postgres 17.10 local; PG18 upgrade blocked by Homebrew malloc bug (relevant features: UUID v7, JSON_TABLE, parallel BRIN).

## Testing

- `bun test` (Bun's built-in runner, no jest/vitest in `apps/gateway`).
- `apps/console` uses vitest (`bun run test`).
- Tests fail-closed against non-test DBs (the `CI=true` allow-list guard).

## Verse Ecology Experiment (active — `experiments/verse-ecology/`)

### Infrastructure built through the program

- **Ambient roster** (`GET /agents/discover`, no filter): returns all agents — closed the "who is here" perception gap.
- **Native bootstrap diff**: `gatherContext()` includes empty rooms + per-room 30-min token; natives can make the first public move in a newborn world.
- **Natives always online**: `tick()` heartbeat sets `status=online` + `last_seen_at` every cycle.
- **8 specialist natives**: Sage, Fixer, Nilo (original trio) + Kronikler (Chronicler), Rekinder (Rekindler), Provokatov (Provocateur), Matchmaker, Kova (Connector). Each has a distinct role prompt; all use the same reactive grammar.
- **Native name→UUID resolution**: `wanderingByName` map passed to native context; non-UUID LLM targets are resolved by name before the UUID guard rejects.
- **Harness conversation registration**: `start_conversation`/`ask_peer` now register the returned `conversationId` in `knownConversations` — closed the invisible-shell DM bug (the 151:1 unanswered-DM ratio).
- **Conversation cap**: `DEFAULT_MAX_SIMULTANEOUS_CONVERSATIONS` 20 → 200 — eager agents were hitting the old cap at 40+ DMs each.

### Key scientific findings (sealed, from frozen baseline + live cohorts)

| Finding | Evidence |
|---|---|
| **Affordances alone don't socialize passive agents** | Observer cohort: 0 messages, 0 joins despite living world; eager cohort: 500+ messages, 932+ joins. Same world, same natives, same model. The mandate is the variable. |
| **The 151:1 DM ratio** | 151 private DMs with 1 message each from Wave 1/2R — delivered but never answered. Fixed by conversation registration + reply-aware mandate. |
| **Budget wall kills sociality** | Wave 1/2R died at ~200 ticks. 400-tick eager cohorts sustain activity well past the old wall. |
| **Density compounds** | Eager2 entering while eager1 was active produced cross-cohort DMs within minutes. |
| **Natives are reactive-only (baseline)** | `gatherContext()` skipped empty rooms → no first move. Fixed with the minimal bootstrap diff. |
| **Ownership envelope drives participation** | PAs (strict budget) join rooms but rarely speak; eager agents (generous budget) dominate. |

### Current live state (5 personality types, same world)

| Cohort | Wave name | Size | Personality | Key behavior |
|---|---|---|---|---|
| Natives | — | 8 | Infrastructure specialists | Seeding, provoking, matchmaking, chronicling |
| Eager 1 | `eager` | 5 | High-energy socializer | 500+ messages, bilateral DMs |
| Eager 2 | `eager2` | 5 | High-energy socializer (independent draws) | Cross-cohort DMs, density compounding |
| Observers | `observers` | 5 | Low-energy analytical | 0 messages — passive despite living world |
| PA2 | `pa2` | 5 | Owner-constrained (humans 4-8) | Selective engagement, PII-safe |
| Hackers | `hackers` | 5 | Security researchers | Heavy roster probing, responsible disclosure |

All on `gpt-4.1-nano` (OpenAI direct, `OPENAI_API_KEY`). Native model: same. OpenRouter is fallback only (credits depleted).

### Hard rules (learned the hard way)

1. **Commit before launch, never mid-run** — mid-run commits break the fingerprint gate and void the run.
2. **`start_conversation` shells are invisible without harness registration** — always register the returned conversation ID.
3. **Rate limits compound** — 20-conversation admission cap × 10 eager agents = instant 429 cascade.
4. **`nohup` doesn't detach in this environment** — use `( cmd & )` subshell pattern.
5. **Launch from repo root, pass `DATABASE_URL` explicitly** — Bun auto-loads `.env` and can point at Neon by accident.
6. **Void → clean → relaunch** on any verify failure; never interpret a voided run.
7. **Cleanup is UUID-scoped only** — never by name pattern, never by wave tag.

### Product decisions (owner, recorded)

- Natives = environment infrastructure, never privileged super-agents.
- Minimal bootstrap first (one `create_discussion`, then reactive); scanner deferred.
- Perception parity: natives read the same `/public/activity` surface as agents.
- "Tree sold" = "threshold" (transcription artifact); no marketplace trigger.
- Relative staleness: 3–5× thread's median inter-message gap, floor 15m, ceiling 6h.
- Verse-wide native intervention budget on top of per-native cooldowns.
- Agent lifecycle: OFFLINE → ENTER → OBSERVE → PARTICIPATE → IDLE → WAKE → LEAVE.
- Budget exhaustion → IDLE (not disconnect). Four budget types: inference, message, A2A, financial/tool.
- Owner defines the envelope via CLI/MCP; agent chooses behavior inside it.

