# Hunt × Gateway Integration Design

**Decision (Jim, 2026-11-08 07:30 ET): "hunts inside the live gateway."**
The hunt module (`apps/hunt/`, built to `SPEC.md` in this directory) ships
**inside** the live `aiverse-gateway` — not as a standalone Render service.
This document is the integration design, written from the gateway's actual
code and the live service's state. **Nothing in the gateway has been
modified.** The deploy sequence at the end runs only after this design is
confirmed against Jim's word.

Evidence gathered 2026-11-08: gateway code at repo main (the clone's
`apps/gateway`), Render API for service `srv-da8ao1qjnfac73drf3og`, and the
live `GET /health` + `GET /version` endpoints.

---

## (a) The gateway: stack and layout

- **Runtime/framework:** Bun + Hono `^4.6.0`, ESM — *identical* to the hunt
  service's stack (`apps/gateway/package.json`). Workspace packages
  `@aiverse/shared`, `@aiverse/topics`.
- **Composition:** `src/app.ts` exports `createApp()`; routes are Hono
  sub-apps mounted with `app.route("/prefix", route)` (owners, rooms,
  conversations, topics, public, a2a, auth, search, goals, memory,
  manifest, onboarding, admin, reports, mcp). Several mount at `"/"`.
  Cross-cutting middleware: CORS from `env.CONSOLE_ORIGINS`, request-id +
  latency logging. `/health` and `/version` are defined in `app.ts`.
- **Data:** Postgres (Neon) via drizzle-orm, Redis (ioredis), NATS.
  Migrations via drizzle-kit.
- **Auth:** owner accounts with JWT sessions — `src/auth/session.ts`
  (`signOwnerSession`/`verifyOwnerSession`, payload `sub` = `owners.id`,
  session-version checked against the owners table, `JWT_SECRET`);
  middleware in `src/middleware/` (`ownerAuth` sets `c.ownerId`; separate
  agent/admin auth).
- **Boot & jobs:** `src/index.ts` — leader election
  (`src/db/singleGatewayLock.ts`); boot prep (room seeding, presence
  reconcile) gates serving; **singleton background jobs start only on the
  elected leader**, via dynamic imports in the leader section
  (`jobs/gc`, `jobs/outcomeLedger`, `jobs/visits`, and the bazaar-expiry
  precedent inside `routes/bazaar.ts`). Serving is a module default export
  `{ port, fetch, websocket }` — **no `idleTimeout` is set** (Bun's 10 s
  default applies; see §b, SSE caveat).
- **Conditional mounting precedent:** `routes/bazaar.ts` mounts only when
  `AIVERSE_BAZAAR_MODE === "1"` — *"prod never serves routes that would 500;
  unset = routes absent (404)"*. The hunt mount follows this exact idiom.
- **Live service (Render API, 2026-11-08):** `aiverse-gateway`,
  web_service, **not suspended**, plan **starter**, region oregon,
  **numInstances 1**, **no persistent disk** (`disk: null`),
  healthCheckPath `/health`, autoDeploy from main. Live probes:
  `GET /health` → `{status:"ok", db:"ok", redis:"ok", natives:"stale"}`
  (stale is informational only, per app.ts); `GET /version` →
  `{version:"0.0.0", gitSha:"106c2d05…", branch:"main",
  environment:"production"}`.
- **Env keys present (names only; values never read):** 18, including
  `RESEND_API_KEY`, `EMAIL_FROM`, `JWT_SECRET`, `DATABASE_URL`,
  `REDIS_URL`, `NATS_URL`, `CONSOLE_ORIGINS`, `PUBLIC_BASE_URL`.
- **Tests:** colocated `*.test.ts` (`app.test.ts`, `version.test.ts`,
  `routes/*.test.ts`, `jobs/*.test.ts`, …). The test script scrubs secrets
  (`env -u DATABASE_URL -u REDIS_URL -u JWT_SECRET -u PORT`,
  `NODE_ENV=test`).

## (b) How the hunt module lives inside — EMBED as a mounted sub-app

**Chosen: embed.** The hunt app is already a Hono app factory
(`buildApp(deps)` in `apps/hunt/src/app.ts`) with absolute `/v1/*` routes —
the gateway's own composition idiom mounts it unchanged:

1. `apps/gateway/package.json` gains `"@aiverse/hunt": "workspace:*"`.
2. `apps/hunt` exports a runtime factory (new `src/runtime.ts`:
   `createHuntRuntime(env)` → `{ app, startTicker, stop }`); the existing
   standalone `src/index.ts` is refactored to use it, so local dev and the
   slice-7 E2E keep working byte-identically.
3. Gateway `createApp()` mounts the hunt app at `"/"` **only when
   `AIVERSE_HUNT_MODE === "1"`** (the bazaar idiom). Mode off ⇒ the route
   table is exactly today's.
4. The hunt **ticker** (event transitions, hint firing, pruning) starts in
   `src/index.ts`'s **leader-only** singleton-jobs section via dynamic
   import — two processes must never tick the same hunt (the gateway's own
   stated reason for the leader gate).
5. **SSE caveat (must-fix at integration):** the gateway's serve export
   sets no `idleTimeout`; Bun's 10 s default kills a quiet SSE connection
   before the hunt feed's 15 s heartbeat (this exact failure bit the
   standalone service in slice 6; its entry sets `idleTimeout: 255`).
   Integration adds `idleTimeout: 255` to the gateway's serve export —
   one line, flagged here as the only gateway-behavior-adjacent change.
   (Alternative — hunt heartbeats every ≤5 s — is chattier and still racy;
   rejected.)
6. **CORS:** when embedded, the gateway's global CORS governs; the hunt
   runtime is mounted without its own CORS layer (a mount option on the
   runtime factory). Standalone dev keeps hunt CORS. Endpoint behavior is
   unchanged either way.

**Rejected shapes:** a second process inside the same Render service
(Render web services run one start command; a supervisor arrangement is
fragile and is not "inside"), and a port of the hunt routes/store into
gateway idioms + drizzle (rewrites the slice-gated storage layer for no
behavioral gain — see §c).

## (c) Storage: SQLite on a disk the service does not have yet

- The hunt store is one SQLite file (WAL). The live gateway has **no
  disk** and an ephemeral filesystem — deploying hunt state there as-is
  would lose the custody store on every deploy.
- **Design:** at deploy time, attach a **1 GB persistent disk mounted at
  `/data`** to `srv-da8ao1qjnfac73drf3og` and set
  `HUNT_DB_PATH=/data/hunt.db`. Render disks pin a service to a single
  instance — the service is already `numInstances: 1`, so no topology
  change. Until the disk exists, `AIVERSE_HUNT_MODE` stays off in
  production (routes absent — the bazaar discipline).
- **Deploy overlap:** a rolling deploy briefly runs old+new processes on
  the same disk. Claims stay safe: the win path is `BEGIN IMMEDIATE` +
  the I1 partial unique index (`UNIQUE(prize_id) WHERE verdict='won'`) —
  enforced by SQLite, not by process locality; the ticker is leader-only.
  Honest caveat: cross-process write contention was not load-tested (the
  50-claim gate ran single-process); Phase-1 volumes are small and the
  index, not timing, carries the invariant.
- **Rejected:** porting hunt storage to the gateway's Postgres via
  drizzle. Feasible (Postgres has partial unique indexes too) but it
  replaces the shipped, slice-gated `db.ts`/`store.ts` with a second
  storage implementation that must re-pass every invariant gate.
  Recorded as the future option if hunts outgrow one file.
- **Backups:** the disk file is the custody store — snapshot it before
  each seeded event (deploy runbook), same posture as spec §11.4.

## (d) Identity: `gateway_owner_id` becomes the primary path

- The console already authenticates to the gateway with the owner JWT.
  Hunt's `requireUser` gains a **primary path**: a gateway Bearer JWT is
  verified through the gateway's own `verifyOwnerSession`; the resulting
  `owners.id` resolves the hunt user by `hunt_users.gateway_owner_id`,
  creating the row on first sight (email + display name from the owners
  record).
- **Adoption, not duplication:** `email` is unique in `hunt_users`. If a
  magic-link account already exists for that email, the gateway sign-in
  **adopts** it (sets `gateway_owner_id`) — the spec §4 merge path,
  exercised as the common case.
- **Magic-link remains** as the fallback for hunters with no gateway
  account (spectator → hunter funnel), unchanged; those rows carry
  `gateway_owner_id NULL` until adopted.
- **Decoupling:** the hunt app never imports gateway code. `buildApp`
  deps gain an optional `verifyGatewayToken(token) → { ownerId, email,
  displayName }`; the gateway passes a closure over its own session code
  at mount time. Admin auth (`HUNT_ADMIN_TOKEN`) is unchanged and
  separate, per spec §9.

## (e) Secrets: two new gateway env vars, set at deploy, never printed

Set on `srv-da8ao1qjnfac73drf3og` at deploy time via the Render
API/dashboard (the workspace's Render connector), values never printed,
logged, or committed:

| Var | Value |
|---|---|
| `HUNT_CODE_KEY` | 32-byte base64, generated at deploy. Jim's sealed offline backup stays the owed handoff (spec §11.4) — the smoke pool is invented code-words, zero real value. |
| `HUNT_ADMIN_TOKEN` | ≥16 chars, generated at deploy. |
| `HUNT_DB_PATH` | `/data/hunt.db` (not secret). |
| `AIVERSE_HUNT_MODE` | `1` (the mount switch; the rollback lever). |
| `HUNT_RESEND_API_KEY` | the account key — a `RESEND_API_KEY` **already exists** on the gateway (key name verified); reuse the same Resend account. |
| `HUNT_EMAIL_FROM` | see open item below. |

Hunt config gains one fallback: `RESEND_API_KEY` is read when
`HUNT_RESEND_API_KEY` is unset (config-only change, slice-1-style test).

**Open item for Jim:** the magic-link sender identity. `EMAIL_FROM`
already exists on the gateway (its value was not read). Options:
(i) launch on the gateway's existing sender identity — no DNS work;
(ii) `hunt@aiverse.network` after Resend domain verification (the
spec §11.5 production step). Recommendation: (i) at launch, (ii) when
convenient. Until one is picked, prod runs `HUNT_EMAIL_MODE` as
configured at deploy; local/E2E stays stubbed.

## (f) Regression gates — before and after

**Baseline (record before integration, on gateway main):**
- G1: `apps/gateway` full `bun test` (env-scrubbed script); root
  `tsconfig.ci.json` typecheck green. (Hunt PR baselines already on
  record: console 426/426 effective + build green; hunt 27/27.)
  **Measured 2026-11-08** (this sandbox, main `932f24bf`, CI-parity
  `.env.test` copied from `.github/workflows/ci.yml`, local Postgres
  `aiverse_test` migrated + local Redis): **247 pass / 142 fail of
  389 tests (49 files)**. Without `.env.test` the suite cannot even
  import (44/80 fail on missing `JWT_SECRET`). The 142 failures
  concentrate in boot-timing, leader-election, WS and presence tests
  whose 10 s waits time out under multi-lane VM load — i.e. this
  sandbox does not reproduce CI's near-green. The integration gate
  is therefore **like-for-like**: reproduce ~247/142 in the same
  environment after integration, with zero NEW failures; a cleaner
  environment should be judged against its own pre-integration run.
- G2: live snapshot — `GET /health` ok, `GET /version` gitSha recorded,
  latest deploy = live (`render deploys srv-da8ao1qjnfac73drf3og`).

**After integration (all must pass before the deploy is called done):**
- G3: gateway suite at baseline counts **twice**: with
  `AIVERSE_HUNT_MODE` off (existing behavior untouched) and on
  (mount present) — no new failures vs the G1 baseline either way.
- G4: hunt suite still 27/27, plus new mount tests: mounted app answers
  `/v1/events`; gateway-JWT path adopts/creates the hunt user; ticker
  starts only in the leader section.
- G5: boot-for-real smoke (repo lore): local gateway boot with hunt mode
  on and a temp `HUNT_DB_PATH` → `/health` ok, `/version` shape
  unchanged, `/v1/events` 200, one magic-link → claim roundtrip against
  the gateway process itself.
- G6: live-after: deploy lands, `/health` + `/version` verified at the
  new gitSha, then the **production smoke**: seed one event with ONE
  invented code-word prize via the admin API on the gateway host; run the
  claim path end-to-end (console or harness at the spot); verify
  winner-only code reveal, the public counter moving, and `hunt_end`;
  close the event and leave the service idle-clean.
- **Rollback at any point:** set `AIVERSE_HUNT_MODE` off + redeploy —
  the mount disappears; no code rollback needed.

## Deploy sequence (fenced — after this design is confirmed)

1. Integration PR per §b/§d/§e (runtime factory, gateway dep + mount,
   leader-gated ticker, `idleTimeout`, config fallback, mount tests).
   Gates G1, G3, G4, G5. Merge per Jim's word at the time.
2. Render: attach the 1 GB disk at `/data`; set the §e env vars
   (secrets generated in place, never printed; code-key backup handoff
   to Jim recorded as owed).
3. Deploy (autoDeploy on merge, or manual trigger) → G2/G6 live checks →
   production smoke → idle-clean.

## Open items for Jim's confirmation

1. The `idleTimeout: 255` line on the gateway's serve export (§b.5).
2. Attaching a persistent disk (brief service restart; pins the already
   single-instance service) (§c).
3. Magic-link sender identity: existing gateway sender vs
   `hunt@aiverse.network` after DNS verification (§e).
