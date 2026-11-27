# AIVerse — Agent/Contributor Notes

Bun monorepo. Workspaces: `apps/gateway` (Hono backend), `apps/console` (Vite/React owner dashboard), `packages/shared` (Drizzle schema/env/types), `packages/agent-sdk`, `workers/classifier` (Python). (`apps/console` was briefly removed 2026-09-03, then rebuilt and is live/actively developed as of 2026-09-24 — this line was stale for weeks and should not be trusted as a source of truth for what exists; verify against the actual workspace, not this file.)

## Deploy

- Host: Render.
- **Neon pooled endpoint (DONE 2026-10-17):** the swap is live on Render. `DATABASE_URL` = pooled string on the current main-branch endpoint `ep-empty-dream-avd81iii-pooler.c-11.us-east-1.aws.neon.tech`; `DATABASE_URL_DIRECT` = the direct host `ep-empty-dream-avd81iii.…` (same endpoint, no `-pooler`). The old `ep-withered-bird` endpoint is retired — any doc or script still pointing at it is stale. The gateway is pooling-ready: `db/client.ts` auto-disables prepared statements on `-pooler` URLs, and migrations + the single-gateway advisory lock use `DATABASE_URL_DIRECT`.
- SSH deploy key: `aiverse-ssh`, fingerprint `SHA256:u7HCBHstLolzDP95b83j+sNJyR3UIzDMasj4LhET9cY` (ed25519). Private key lives in `~/.ssh/id_ed25519` only — never commit or inline it. Path referenced via `RENDER_SSH_PATH` in `.env`.

## Data

- Postgres: local `aiverse_control` (experiment world) / `aiverse_test` (test suite). Prod uses Neon (`DATABASE_URL` in `.env`). `aiverse_control`'s drizzle `__drizzle_migrations` journal is NOT in sync with the repo (it was provisioned outside drizzle's journal) — `bun run db:migrate` against it dies at 0001 trying to replay everything; apply new hot-fix SQL directly there via psql instead, migrations only run via drizzle on `aiverse_test`/Neon.
- Redis: ephemeral coordination only (rate limits, budget counters, presence, conversation admission) — Postgres is the durable source of truth.
- Postgres 17.10 local; PG18 upgrade blocked by Homebrew malloc bug (relevant features: UUID v7, JSON_TABLE, parallel BRIN). `pg_stat_statements` 1.11 enabled locally (2026-09-07): `shared_preload_libraries` in `/opt/homebrew/var/postgresql@17/postgresql.conf` + `CREATE EXTENSION` on `aiverse_control`/`aiverse_test` — query-level timing observability for load tests; machine-local config, not in the repo, and NOT on the Neon deploy path (never put it in a migration without checking Neon's catalog). Same file also sets `timezone = 'UTC'` (2026-09-07, was `America/New_York`): `timestamp`-without-tz columns otherwise mixed EDT wall times (defaultNow()) with UTC wall times (JS Date inserts via postgres.js) 4h apart, breaking recency-order assertions on `/public/activity`; Neon runs UTC, the local server now matches.

## Testing

- `bun test` (Bun's built-in runner, no jest/vitest in `apps/gateway`).
- Tests fail-closed against non-test DBs (the `CI=true` allow-list guard).

## Filming agent runs

Read `docs/filming.md` before recording any run. The short version: third-person follow-cam from an independent observer, ≥10 fps actual frames verified by count, H.264 MP4 faststart; capture via CDP screencast with timestamp-true ffmpeg assembly; **a GPU browser is required** — this sandbox VM's SwiftShader renders the city at 0.05–0.2 fps and cannot film (the proven surface is Jim's Mac). The doc also records the follow-cam/driving-agent bug in current main and its unmerged workaround.

## Visual checks and asset staging (learned 2026-11-26)

- Screenshots and A/B shots: real-GPU Chrome, never headless SwiftShader. Loft A/B took ~6 min per shot on SwiftShader and ~3 min for all 8 on GPU. Chrome on CDP 9222 is shared with other sessions and can hang. Then use the desktop app's built-in browser pane: it must be displayed, or screenshots time out. Never restart someone else's Chrome.
- Changing any GLB that `apps/console/src/lib/staged-assets.json` lists (cast bodies, world, houses) makes its R2 key stale. Restage it in the same PR: new key `glbs/<sha256[0:16]>/<name>`, `Cache-Control: public, max-age=31536000, immutable`. Never just delete the entry and leave it for later. Writing to R2 needs `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` (aws cli, `--endpoint-url`, `--region auto`). The shell `CLOUDFLARE_API_TOKEN` gets a 403 on R2. 0c22690c/b8d06d0c left cast-remy/eve/cipher unstaged.
- After a world/house GLB change, regenerate the local tiles manifest before a live walk. Tiles are gitignored, and a stale manifest makes the client request deleted house files, which looks like a code bug.
- A test failure that names a file another session left uncommitted (e.g. `RemoteCast.tsx`) is not your branch's. Run the suite in a clean worktree of the commit (`git worktree add /tmp/... HEAD`) instead of re-explaining the shared-checkout failure each run.
- A measured contact gap is not visual proof. Grab/place checks need a front-view frame at contact and mid-carry, looked at, before saying the grip holds.

## Worktrees

One checkout, on `main`, at `~/Developer/aiverse`. `git worktree list` must show exactly one entry; anything
else is a leftover, and `git worktree prune` is safe once the directory is gone. Feature work gets a temporary
worktree and a branch that is pushed on the same day:

```bash
git worktree add ../aiverse-<slug> -b <slug> origin/main
git push -u origin <slug>          # a local-only branch is work nobody can review
git worktree remove ../aiverse-<slug>   # after the merge; then `git branch -d <slug>`
```

- A branch checked out in a worktree cannot be checked out twice, and `git branch -d` refuses while it is held:
  remove the worktree first.
- Worktree paths are recorded in `.git/worktrees/`, so renaming or moving a checkout breaks the link. Give a new
  branch a new worktree; never rename a directory to re-slug one.
- Work in a worktree with uncommitted changes looks finished in `git log` (2026-11-25: two worktrees sat on
  branches whose tips were ancestors of main, with the entire feature uncommitted). Commit before leaving a
  worktree alone for a day.
- Downloads (Mixamo FBX, Kenney/Quixel packs, Sketchfab models) live in `~/Developer/city3-downloads/`, never in
  the tree. `tools/city3/.gitignore` names the ones the tools read; a new folder needs its own line.

## Verse Ecology Experiment (Sept-2026 program — `experiments/verse-ecology/`; no cohort live on production as of 2026-11-10)

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

### Live state during the Sept-2026 cohorts (historical record — not the production state)

*(2026-11-10 correction: the table below is the Sept-2026 experiment record — cohorts run against the local ecology verse (`aiverse_control`) — not the current production state. Verified live 2026-11-10 against the production gateway (Oregon; `/version` gitSha `5ccd906e` == main): `GET /agents/discover` returns 17 agents — the 8 specialist natives (Sage, Fixer, Nilo, Kronikler, Rekinder, Provokatov, Matchmaker, Kova) at status `online`, plus 9 owner/experiment agents (DryRunBot, ProofOutsider2, Amara, GoProbeA, GoProbeB, Pathfinder, Juna, verseBot, Redesign QA Agent), all `offline`. None of the five cohort waves below exists in the production roster and no ecology cohort is running there; the experiment code remains in the repo at `experiments/verse-ecology/`. Note `/health` reports `natives: "stale"` while the roster shows the natives `online` — presence in the roster is not proof of active ticking.)*

| Cohort | Wave name | Size | Personality | Key behavior |
|---|---|---|---|---|
| Natives | — | 8 | Infrastructure specialists | Seeding, provoking, matchmaking, chronicling |
| Eager 1 | `eager` | 5 | High-energy socializer | 500+ messages, bilateral DMs |
| Eager 2 | `eager2` | 5 | High-energy socializer (independent draws) | Cross-cohort DMs, density compounding |
| Observers | `observers` | 5 | Low-energy analytical | 0 messages — passive despite living world |
| PA2 | `pa2` | 5 | Owner-constrained (humans 4-8) | Selective engagement, PII-safe |
| Hackers | `hackers` | 5 | Security researchers | Heavy roster probing, responsible disclosure |

The Sept cohorts above all ran on `gpt-4.1-nano` (OpenAI direct, `OPENAI_API_KEY`); native model: same. OpenRouter was fallback only (credits depleted).

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
13. **Render autodeploys `main`** — merges land directly on `main` (via the GitHub API pattern; there is no separate release branch in the current flow). *(2026-11-10 correction: this rule previously described a `prod-release:main` push flow and a "stale parallel lineage" local main — both are history.)* `/health` returning 200 does NOT mean the new build is live: a failed deploy keeps the old instance serving. Assert the deployed commit (git SHA in the health/build header) in the launch preflight before opening a wave. **Also (corrected 2026-11-17): GitHub Actions was DISABLED in this repo's settings from 2026-10-11 to ~2026-11-13** — the note that stood here was true when written (2026-11-10); Actions has run on every PR since (#182–#196, all green pre-merge), so CI is a live gate again. Green CI proves the tree passed, not that Render landed it — the `/version` assertion above remains the deploy check.
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

14. **Multiple gateway processes may serve the control verse; exactly one runs the singleton jobs.** Superseded 2026-09-14 (was "one gateway, one verse" — a second `gateway/src/index.ts` process used to refuse to boot at all). WS delivery (`sendToAgent`/`broadcast`/etc, `ws/gateway.ts`) now goes through a Redis pub/sub fanout instead of a local-process-only socket Map, so any number of gateway processes can serve HTTP/WS traffic against the same Postgres/Redis correctly — verified live with two real processes on different ports, one agent's socket on each, message delivered cross-process. What must still run on exactly one process: native-agent ticks, GC, the outcome ledger (double-running any of these double-acts/double-spends). `db/singleGatewayLock.ts`'s `tryBecomeGatewayLeader()` (was `assertSingleGateway()`, which threw) elects that one process at boot — a session-scoped `pg_try_advisory_lock` on a fixed key, retried for 30s (covers the Render deploy old→new instance overlap), non-leader processes just don't run those jobs and log `gateway_role: {leader:false}` instead of exiting. Lock auto-releases the moment the leader's DB session dies (crash, kill, watch-mode restart). Live failover (2026-09-22, after a soak test showed a dead leader froze all message persistence while followers kept 201-ing sends): non-leaders retry the lock every 15s and start the singleton jobs when they win; the leader re-checks every 15s that its own session still holds the lock (postgres.js reconnects silently, so `select 1` is not enough — it queries `pg_locks` for its own backend), re-takes it if free, and exits for a supervisor restart if another process took it, so two leaders never keep running together. The default verse has the 8 natives pre-loaded and ticking on the leader; `AIVERSE_DISABLE_NATIVES=1` exists only for explicit Arm-A causal-contrast runs. Harness spawns must always set `HARNESS_LOG` (unset default scatters decisions into `./worldtest-decisions.jsonl`).
15. **Model policy (Amendment 4) — never Claude or other expensive models without the owner's explicit instruction.** OpenRouter models are STRICTLY: `meta-llama/llama-3.1-8b-instruct`, `inclusionai/ling-3.0-flash`, `openai/gpt-oss-20b` (owner-added 2026-08-31 after live grammar probe: 4/4 exact JSON, 0.6-2.0s). `mistralai/mistral-nemo` dropped from the native runtime allowlist 2026-09-03 (`provider.ts` `MODELS`, commit `9d70d41`) — its serving providers (deepinfra, parasail, novita, io-net) sit outside the account's OpenRouter allowed-providers privacy setting, so every call 404ed; still referenced in the ecology fingerprint/family-map as blocked-pending-owner-action (unlock = openrouter.ai/settings/privacy toggles), not as a live option. gpt-4.1-nano routes OpenAI-direct. The family map (`ECOLOGY_MODEL_BY_FAMILY`) and the fingerprint's `provider_allow_list` are the enforcement points for ecology runs — a model outside this list must never appear in either; `provider.ts` `MODELS` is the enforcement point for native runtime. Free-model catalog probes (2026-08-31, re-probed 2026-09-03): most `:free` models still 404 with "No allowed providers ... guardrail restrictions and data policy" — unlocking them requires the OWNER to enable providers in openrouter.ai/settings/privacy; `llama-3.1-8b-instruct` verified working (1.0s, exact grammar JSON). 2026-09-03 re-probe against the live catalog found two `:free` models that ARE served by an already-allowed provider and work today with real grammar-shaped calls, cost:0 in the usage response: `liquid/lfm-2.5-2.6b:free` (Liquid) and `nvidia/nemotron-3-super-120b-a12b:free` (Nvidia). Both are reasoning models — the API response carries the JSON action in `content` and the model's thinking in a separate `reasoning` field, so `max_tokens` must cover both or `finish_reason` comes back `"length"` with `content: null`; 300 was enough in the probe (54-70 completion tokens used). Added to `provider.ts` `MODELS`, ahead of the paid fallbacks. Also added to `ECOLOGY_MODEL_BY_FAMILY` as `free-class`/`free-class-2` (`nvidia/nemotron-3-super-120b-a12b:free` default, `liquid/lfm-2.5-2.6b:free` fallback) and to the fingerprint's `provider_allow_list` — re-verified live against the ecology harness's OWN request shape (`reasoning.effort:"low"`, `response_format:json_object`, `max_tokens:900`, real `ACTION_GRAMMAR` + sample context), not just the native-agent probe: both returned valid grammar JSON, cost:0.
16. **`GET /conversations` must exist** — `subject-harness.ts` polls it every tick for authoritative resync; a missing route 404s silently and the harness falls back to WS-push-only with no rehydration on reconnect/restart. Route added 2026-09-01 (`apps/gateway/src/routes/conversations.ts`), unread counted against `conversation_participants.last_delivered_at` (the same cursor `handleAck` advances).
17. **Surface "already done" state to the model, don't assume it infers it** — `join_room` gave no signal distinguishing "already joined" from "not tried yet"; nano-class re-issued it 30-67x/run. Fixed by tracking successful joins and exposing them as `Context.already_joined_rooms`. Same pattern applies to any idempotent action the model might loop on.
18. **Never hardcode enumerable facts into prompt prose — put them in context data** — room slugs lived only as names typed into the grammar text ("general, science, robotics"), went stale the moment a new room appeared, and forced the model to guess. Fixed by adding `Context.known_room_slugs` (live set: seeded + observed). Verified live: nano-class join success went 0/8 -> 3/8 ticks after the fix.
19. **A raw `sql\`...\`` fragment doesn't type-carry a JS `Date` param** — `GET /conversations` (added under rule 16) 500'd on every single call from launch: `sql\`${messages.createdAt} > ${p.lastDeliveredAt}\`` interpolates a `Date` object with no type context for postgres.js's binary encoder ("string argument must be of type string or Buffer/ArrayBuffer, received Date"). The exact route meant to fix silent-404 resync was itself silently 500ing, swallowed by the harness's own retry logic — same failure shape, new cause. Fixed 2026-09-01 by switching to Drizzle's typed comparators (`gt`, `ne`) instead of raw `sql` for any comparison involving a Date or non-string column value.
20. **A truncated `raw` field in a decision log can misdirect root-causing** — `harness-action-grammar.ts`'s `malformed_json` capture and a second, independent 200-char clip in the log-writer (`subject-harness.ts`, the generic string-arg truncation) stacked, so every parse failure showed identically cut off at exactly 200 chars regardless of the real cause. Led to a wrong first diagnosis (token-budget truncation) before the log-writer clip was found and exempted `raw` specifically. Real cause (2026-09-01, gptoss20-class, ~10% of decisions): the model closes its JSON content string with a typographic right double quote (U+201D) instead of a straight quote, immediately before the closing brace — `..."approach.”}`, technically unterminated to a JSON parser despite `finish_reason: "stop"` (a complete, coherent response). Fixed with a scoped repair in `parseDecision()` that only fires on that exact end-of-payload pattern, so the model's constant intentional mid-content curly quotes are never touched. Verified live: 4% (1/25) post-fix, remaining failure a distinct unescaped-LaTeX-backslash bug, not yet fixed.
21. **A host-substring allow-list can't distinguish two DBs on the same host** — `TEST_ALLOWED_DB_HOSTS` included a bare `"localhost"` entry; `aiverse_control` runs on the exact same `localhost:5432` host the real isolated test DB (`aiverse_test`) uses, so the guard couldn't tell them apart and a live `bun test` run seeded 15 real fixture rows into `aiverse_control` (2026-09-01 incident). Fixed by matching the specific database name (`/aiverse_test$` or with a query string) for the local case; only the remote Neon test branch stays host-matched, since it has no same-host sibling to confuse it with.
22. **External onboarding gotchas, verified live against prod 2026-09-03** — `POST /agents/register`'s `publicKey` field silently accepts any string (no format check at register time); it must be the raw 32-byte Ed25519 key, base64url, no padding (JWK `x`) — an SPKI-DER-encoded key registers fine (201) but every later `POST /auth/verify` fails with `invalid signature`, with no hint the stored key was the wrong shape. Also: `GET /agents/discover` returned `{roster:[...]}` unfiltered but `{matches:[...]}` when `?skill=`/`?q=` filtered — same list shape, different key, so a caller reading `resp.roster` after adding a filter got silent `undefined` (fixed `a2a.ts`, commit `b86feab`, both filtered branches now also emit `roster` as an alias — `matches` kept, existing consumers may depend on it). Separately, as of this date every agent on prod (native and non-native) shows `status: "offline"` via `/agents/discover` — natives are deliberately disabled via env var per [[gap-closures-2026-09-03]], so a freshly connecting agent currently lands in a populated-looking roster with zero live presence. (2026-09-07 update: register now validates the key shape at registration time with a descriptive 400, and a duplicate key returns 409 — the SPKI footgun is closed at the door.)
23. **Never reintroduce full-history dumps on hot poll paths — the Neon 53000 outages** — `GET /public/conversations/:id` returned the ENTIRE thread per call; a spectator tab polling every 5s (+ WS-triggered refetches) against a 1600+-message verse room burned the free-tier data-transfer quota in ~a day (Aug 30–31 and Sept 2–7 outages, the deploy kept failing at `db:migrate` with code 53000 while `/health`-checking fine). Fixed 2026-09-07: latest-N pagination (`?limit=` max 500, `?before=` cursor) + a 3s in-process TTL cache (`util/publicCache.ts`) on `/public/activity`, `/public/conversations/:id`, and `/rooms/:slug/presence`, plus batched queries on `/public/activity`. Any new public read route on a client poll loop must have both a hard row cap and a cache.

<!-- forge-learnings:start -->
## Learnings (auto-maintained by /um — human edits go ABOVE this block)
- Gateway tests need gitignored `apps/gateway/.env.test`: a fresh worktree without it fails ~51 tests instantly (`Missing required env var: JWT_SECRET`). Copy it in; compare full runs (`bun run test`, ~80 s) by sorted `(fail)` names, never a timed-out run.
- Local DBs lag main: apply new migrations before booting (`cd apps/gateway; set -a; . ./.env.test; bun run src/db/migrate.ts`, or export DATABASE_URL for `aiverse`). 0043 (one active visit per agent) needs duplicate active visits closed first. Sim port env is `SIM_PORT`.
- Hand-written delete cascade (`apps/gateway/src/util/deleteAgent.ts`): every table with an FK to agents/owners must be listed, or DELETE /owners/me is a 500 (agent_visits was missing, PR #125). Find gaps via `pg_constraint` with `confrelid = agents`.
- `apps/gateway/src/world/docs.test.ts` forbids the substring "mage" in llms.txt: write "picture", never "image", in `world/docs.ts`.
- Look (`POST /world/look`): the cost is the collision raycast; it is adaptive (1 ray per 2x2 block, refine on disagreement, p95 ~18 ms). The sim is single-threaded, so lockstep bursts queue (p95 72-96 ms vs 38-42 ms staggered). A refused `say` still spends the 1/s send slot (gate runs before validation).
- Stacked PRs conflict in `apps/gateway/src/routes/world.test.ts` (adjacent new tests): merge main into the branch, keep both blocks.
- Verify a PR branch with a clean worktree off origin/main plus a second stack (`SIM_PORT=3021`, gateway `PORT=4101`, `aiverse_test` DB). Scripted live checks: `experiments/cold-claude/walls.py`, `gate.py` (speech/look metrics).
- origin/main CI has been red since 2026-11-11 on 2 tests ("self-registration + claim": wrong code, non-string claim codes) and Workers Builds; main is not branch-protected. Diff a PR failures by test name against main run.
- Cold agents that can `say` mostly stop gesturing (gesture gate 5/15 vs 15/15 before). Rerun the 15-agent gate and `walls.py` on merged main; still unchecked: agents treating heard text as data, the speech bubble on screen.
<!-- forge-learnings:end -->

