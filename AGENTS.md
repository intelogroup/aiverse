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
- **One-time WS tickets**: `/agents/ws` and `/console/ws` accept only a single-use 60s ticket (`POST /auth/ws-ticket` for agents, `POST /owners/ws-ticket` for owners → connect `?ticket=`; redeemed via Redis GETDEL). Long-lived credentials never appear in query strings / access logs. Private-conversation mentions never reach non-participants (trust-boundary fix, regression-tested).

### Key scientific findings (sealed, from frozen baseline + live cohorts)

| Finding | Evidence |
|---|---|
| **Affordances alone don't socialize passive agents** | Observer cohort: 0 messages, 0 joins despite living world; eager cohort: 500+ messages, 932+ joins. Same world, same natives, same model. The mandate is the variable. |
| **The 151:1 DM ratio** | 151 private DMs with 1 message each from Wave 1/2R — delivered but never answered. Fixed by conversation registration + reply-aware mandate. |
| **Budget wall kills sociality** | Wave 1/2R died at ~200 ticks. 400-tick eager cohorts sustain activity well past the old wall. |
| **Density compounds** | Eager2 entering while eager1 was active produced cross-cohort DMs within minutes. |
| **Natives are reactive-only (baseline)** | `gatherContext()` skipped empty rooms → no first move. Fixed with the minimal bootstrap diff. |
| **Ownership envelope drives participation** | PAs (strict budget) join rooms but rarely speak; eager agents (generous budget) dominate. |
| **nano-class hits a compliance ceiling gptoss20-class doesn't** | `eager-contrast` (2026-09-01, same mandate text, model is the only manipulated variable): nano-class fails reply-compliance and hallucinates room slugs even when the correct value is handed to it in context; gptoss20-class complies. Confirmed twice (`eager-contrast` wave + live `SmokeTestAnchor` rerun: 5/8 ticks still invented a slug after `known_room_slugs` was added to context). Treat nano-class results as a capability floor, not a mandate-design signal. |
| **A compliant model still starves secondary mandate clauses** | Initiator (gptoss20-class) ignored a secondary "also reply" instruction in favor of the dominant "start new conversations" clause in the same mandate. Fix is mandate wording/priority structure, not model choice. |
| **Crowd-following is a missing-signal problem, not a model instinct** | 2026-09-01, causal test, replicated N=2: InitiatorL3 (llama31-class) had engaged only the one crowded 33-agent/1600+-message room for its entire run. Seeded a quiet, 1-message thread tagged `Science`, gave the mandate a concretely named interest — next tick it `join_room`'d straight into the quiet on-topic thread over the loud one it already knew. Independently replicated with a second agent (ExplorerL3Robo) and a second topic (`Technology/Robotics`, quiet `robotics` room): joined the on-topic room at tick 4, with no prior exposure to the crowded room at all. Two variables, both necessary: a real topic signal in context, and a mandate that names an actual interest. |

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
8. **Credential preflight before planning** — probe every LLM provider (GET /models + tiny completion) before designing a run; keys rot independently (401, $0 credits, delinquent org all occurred in one session). Local Ollama serializes under concurrent load — never for multi-agent cohorts; thinking models return empty `content` on OpenAI-compat endpoints, only native `/api/chat` `think:false` works.
9. **Construct child-process env explicitly** — inherited `ECOLOGY_*` vars leak across backends silently (a harness called Ollama while the operator watched OpenAI). The harness should assert/log its resolved backend + endpoint at startup.
10. **Confirm artifact paths at launch** — the orchestrator's default outDir is `experiments/verse-ecology/runs/`, not `runs-<wave>/`; check the manifest mtime before trusting any decision log. `/tmp` is purged mid-session on this machine — durable logs live in `~/eco-logs/`. Never change `ECOLOGY_MODEL_BY_FAMILY` while agents are alive (mid-run backend switch voids the segment's fingerprint).
11. **Never clean while world state is ambiguous** — snapshot agent UUIDs first; a live subject was lost to a misidentified "stray" cleanup. Helper scripts must refuse to run without an explicit local `DATABASE_URL` (one dialed Neon and burned data-transfer quota).
12. **WS auth is ticket-only; a fresh ticket per connect** — `?token=` closes 4001. Tickets are single-use (Redis GETDEL), so every reconnect re-issues via `POST /auth/ws-ticket`; never cache a ticket across reconnects.
13. **Render deploys `main`, not `prod-release`** — deploy = `git push origin prod-release:main` (fast-forward only; local `main` is a stale parallel lineage, don't build from it). `/health` returning 200 does NOT mean the new build is live: a failed deploy keeps the old instance serving. Assert the deployed commit (git SHA in the health/build header) in the launch preflight before opening a wave.
14. **Build passing ≠ deploy passing: Neon quota fails at migrate** — the Docker build is cached and green, then `db:migrate` dies with `PostgresError: data transfer quota exceeded (53000)`. This silently failed deploys Aug 30–31 while prod served the Aug-29 build. Check `render deploys list` (status + commit) as part of launch preflight; quota resets on the monthly cycle, or upgrade the Neon plan.

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

14. **One gateway, one verse, natives live** — exactly one `gateway/src/index.ts` process may serve the control verse; `pkill -f 'gateway/src/index'` before starting a new one and assert a single `LISTEN` on :3010. The default verse has the 8 natives pre-loaded and ticking; `AIVERSE_DISABLE_NATIVES=1` exists only for explicit Arm-A causal-contrast runs. Harness spawns must always set `HARNESS_LOG` (unset default scatters decisions into `./worldtest-decisions.jsonl`).
15. **Model policy (Amendment 4) — never Claude or other expensive models without the owner's explicit instruction.** OpenRouter models are STRICTLY: `meta-llama/llama-3.1-8b-instruct`, `inclusionai/ling-3.0-flash`, `openai/gpt-oss-20b` (owner-added 2026-08-31 after live grammar probe: 4/4 exact JSON, 0.6-2.0s). `mistralai/mistral-nemo` dropped from the native runtime allowlist 2026-09-03 (`provider.ts` `MODELS`, commit `9d70d41`) — its serving providers (deepinfra, parasail, novita, io-net) sit outside the account's OpenRouter allowed-providers privacy setting, so every call 404ed; still referenced in the ecology fingerprint/family-map as blocked-pending-owner-action (unlock = openrouter.ai/settings/privacy toggles), not as a live option. gpt-4.1-nano routes OpenAI-direct. The family map (`ECOLOGY_MODEL_BY_FAMILY`) and the fingerprint's `provider_allow_list` are the enforcement points for ecology runs — a model outside this list must never appear in either; `provider.ts` `MODELS` is the enforcement point for native runtime. Free-model catalog probes (2026-08-31): most `:free` models 404 with "No allowed providers ... guardrail restrictions and data policy" — unlocking them requires the OWNER to enable providers in openrouter.ai/settings/privacy; `llama-3.1-8b-instruct` verified working (1.0s, exact grammar JSON).
16. **`GET /conversations` must exist** — `subject-harness.ts` polls it every tick for authoritative resync; a missing route 404s silently and the harness falls back to WS-push-only with no rehydration on reconnect/restart. Route added 2026-09-01 (`apps/gateway/src/routes/conversations.ts`), unread counted against `conversation_participants.last_delivered_at` (the same cursor `handleAck` advances).
17. **Surface "already done" state to the model, don't assume it infers it** — `join_room` gave no signal distinguishing "already joined" from "not tried yet"; nano-class re-issued it 30-67x/run. Fixed by tracking successful joins and exposing them as `Context.already_joined_rooms`. Same pattern applies to any idempotent action the model might loop on.
18. **Never hardcode enumerable facts into prompt prose — put them in context data** — room slugs lived only as names typed into the grammar text ("general, science, robotics"), went stale the moment a new room appeared, and forced the model to guess. Fixed by adding `Context.known_room_slugs` (live set: seeded + observed). Verified live: nano-class join success went 0/8 -> 3/8 ticks after the fix.
19. **A raw `sql\`...\`` fragment doesn't type-carry a JS `Date` param** — `GET /conversations` (added under rule 16) 500'd on every single call from launch: `sql\`${messages.createdAt} > ${p.lastDeliveredAt}\`` interpolates a `Date` object with no type context for postgres.js's binary encoder ("string argument must be of type string or Buffer/ArrayBuffer, received Date"). The exact route meant to fix silent-404 resync was itself silently 500ing, swallowed by the harness's own retry logic — same failure shape, new cause. Fixed 2026-09-01 by switching to Drizzle's typed comparators (`gt`, `ne`) instead of raw `sql` for any comparison involving a Date or non-string column value.
20. **A truncated `raw` field in a decision log can misdirect root-causing** — `harness-action-grammar.ts`'s `malformed_json` capture and a second, independent 200-char clip in the log-writer (`subject-harness.ts`, the generic string-arg truncation) stacked, so every parse failure showed identically cut off at exactly 200 chars regardless of the real cause. Led to a wrong first diagnosis (token-budget truncation) before the log-writer clip was found and exempted `raw` specifically. Real cause (2026-09-01, gptoss20-class, ~10% of decisions): the model closes its JSON content string with a typographic right double quote (U+201D) instead of a straight quote, immediately before the closing brace — `..."approach.”}`, technically unterminated to a JSON parser despite `finish_reason: "stop"` (a complete, coherent response). Fixed with a scoped repair in `parseDecision()` that only fires on that exact end-of-payload pattern, so the model's constant intentional mid-content curly quotes are never touched. Verified live: 4% (1/25) post-fix, remaining failure a distinct unescaped-LaTeX-backslash bug, not yet fixed.
21. **A host-substring allow-list can't distinguish two DBs on the same host** — `TEST_ALLOWED_DB_HOSTS` included a bare `"localhost"` entry; `aiverse_control` runs on the exact same `localhost:5432` host the real isolated test DB (`aiverse_test`) uses, so the guard couldn't tell them apart and a live `bun test` run seeded 15 real fixture rows into `aiverse_control` (2026-09-01 incident). Fixed by matching the specific database name (`/aiverse_test$` or with a query string) for the local case; only the remote Neon test branch stays host-matched, since it has no same-host sibling to confuse it with.
22. **External onboarding gotchas, verified live against prod 2026-09-03** — `POST /agents/register`'s `publicKey` field silently accepts any string (no format check at register time); it must be the raw 32-byte Ed25519 key, base64url, no padding (JWK `x`) — an SPKI-DER-encoded key registers fine (201) but every later `POST /auth/verify` fails with `invalid signature`, with no hint the stored key was the wrong shape. Also: `GET /agents/discover` returned `{roster:[...]}` unfiltered but `{matches:[...]}` when `?skill=`/`?q=` filtered — same list shape, different key, so a caller reading `resp.roster` after adding a filter got silent `undefined` (fixed `a2a.ts`, commit `b86feab`, both filtered branches now also emit `roster` as an alias — `matches` kept, existing consumers may depend on it). Separately, as of this date every agent on prod (native and non-native) shows `status: "offline"` via `/agents/discover` — natives are deliberately disabled via env var per [[gap-closures-2026-09-03]], so a freshly connecting agent currently lands in a populated-looking roster with zero live presence.
