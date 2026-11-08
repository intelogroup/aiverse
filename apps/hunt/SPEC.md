# Hunt Service — BUILD SPEC (copy of record, as built)

Status: **BUILT 2026-11-08** — this copy lives with the code in `apps/hunt/`
and records the spec **as amended by the hunt v0 experiment deltas** (folded
in at Jim's instruction) and the §11 items built to their recommendations.
The original design document was commissioned 2026-11-07 after Jim approved
the money amendment and decided §9 of the amendment: a small **standalone**
hunt service; the gateway stays out of the hunt path.
Sources: `docs/TREASURE-HUNT-PLAN.md` (PR #39, merged) and
`MONEY-AMENDMENT-DRAFT.md` (approved 2026-11-07). Every place this spec
assumes something the sources did not state is marked **[ASSUMPTION]**.

**Amendments applied in this copy (deltas from hunt v0,
`experiments/hunt-v0/REPORT.md`):**
- **D1 — Claim checks are continuous.** §6 evaluations also run on
  `POST /v1/positions` pings; a ping that lands on a spot resolves the
  claim (`claim_attempts.via` records `claim` vs `ping`).
- **D2 — Default claim radius is 1.5 m** (was proposed 2.0 m): measured
  arrival scatter at stand points is 0.43–0.76 m. See §11.1.
- **D3 — Hint rungs are progress-paced first.** `hint_schedule` rows carry
  optional progress triggers (`prizes_claimed_fraction`,
  `hunters_in_area` with a rung disc); a rung fires when its progress
  trigger is met OR its scheduled time arrives, whichever comes first,
  subject to the unclaimed condition in §5.8.

---

## 1. Scope

### Phase 1 (this spec builds to here)

- Scheduled public hunt **events** in City 3 (Bazaar first; district field is
  general).
- **Code prizes only** (gift/game/sponsor codes), held in encrypted custody
  server-side, revealed exactly once, only to the winner.
- **Position-validated, atomic claims**: exactly one winner per prize.
- **Hint ladder** (district → neighbourhood → street → room) on a schedule,
  server-clock authority.
- **Announcement events** emitted for the existing console machinery
  (tower/Hall screen, central PA, private ping per Amendment 1).
- **Live public counter** (prizes total / claimed / remaining, countdown)
  readable with no account — the spectator page's data source.
- Lightweight hunt identity (email magic-link) — §4.
- Admin tooling to create an event, seed a pool, review claims, and read the
  pool ledger — §9.

### Explicit non-goals

- **Cash / PayPal payouts** — Phase 2. This spec defines the payout-address
  *record shape* only (§5.7); no PayPal API, no money movement.
- **User-funded dead drops and bounties** — out (money-transmission exposure;
  amendment §7). No endpoint accepts value from a user.
- **The full L-B shared world** — out. This service holds **items and
  claims**, never agent world state. It does not simulate, render, or relay
  presence. The console remains the only world client.
- **Fragments trading, keys/chests, races, photo safaris** (plan variants /
  Amendment 2) — out of Phase 1; the data model does not preclude them, but
  no endpoint serves them.
- **Prize locations in any client artifact** — forbidden by design (plan
  integrity rule). Coordinates exist only in this service's datastore.

---

## 2. Architecture

### Chosen stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Bun** | The workspace runtime (repo is a Bun monorepo); one binary, built-in test runner, no transpile step. |
| Framework | **Hono** | Same framework as the parked gateway — shared idioms, tiny footprint, first-class SSE. |
| Datastore | **SQLite** (WAL mode), via `bun:sqlite` | Single-file, zero extra infra, real transactions + unique indexes give atomic claims. Phase 1 volume (a handful of events, ≤ thousands of claims) is far inside SQLite's envelope. |
| Email | **Resend** | Workspace already has a Resend connection; needed only for magic-links. |
| Hosting (DECIDED 2026-11-07) | **Render, one web service (Starter) + persistent disk** | Decided by Jett at Jim's delegation ("Your call", 2026-11-07 23:18 ET) after live verification that Render is fully accessible and the gateway is live on main. Render is AIVerse's existing platform — one workspace, one bill. Single instance matches the single-writer design. (Original draft proposed Fly/sjc under the stale premise that Render was dead; superseded.) **POSTURE (Jim, 2026-11-07 23:21 ET): this topology is the PRODUCTION target. The build phase keeps everything together — the service is developed inside the aiverse repo alongside the console and proven locally; the Render deployment happens only at production time, on Jim's separate word.** |

Rejected in one line each:

- *Reuse the gateway* — live again (verified 2026-11-07), but a public
  money event must not share fate with a service that has a Neon-quota
  outage history and gets parked when costs bite; a hunt bug's blast
  radius also stays out of auth/accounts. Isolation wins.
- *Fly.io* — works fine, but a second platform and billing relationship
  for one tiny service when Render is verified live and already home to
  every other AIVerse service.
- *Neon/Postgres* — durable and familiar, but an extra network dependency
  and a quota history (53000 outages) for data that fits in a file; revisit
  if Phase 3 spectator load ever outgrows one box.
- *Node + Express* — works, but splits the workspace's runtime/framework
  idioms for no gain.
- *Redis / queues / workers* — nothing at Phase 1 scale needs them; the
  scheduler is an in-process timer.
- *Supabase/Firebase* — new vendor + auth surface to hold exactly the
  custody data we most want boring and local.

### Shape

- **One process, one instance, one SQLite file** on a Render persistent
  disk (`/data/hunt.db`). All writes serialize through the process; claims use a
  single `BEGIN IMMEDIATE` transaction (§6), so "exactly one winner" is a
  database fact, not an application hope.
- Scheduled jobs (hint ladder, event open/close) run on an in-process
  1-second ticker against the server clock. If the process restarts, the
  ticker re-derives state from stored schedules — no job state lives only
  in memory.
- Backups: nightly copy of the SQLite file (WAL checkpoint + copy) to a
  second location **[ASSUMPTION: Render disk snapshots or an object store
  bucket — builder picks whichever the account already has]**.
- The console (Vercel, static) calls this service cross-origin; CORS allows
  only the console origins (`aiverse.network`, `www.aiverse.network`,
  `localhost` in dev).

### Cost shape at Phase 1 scale

**[ASSUMPTION: scale = ≤ 5 events/month, ≤ 500 hunters and ≤ 5,000
spectators per event.]** One Render Starter web service (~$7/month,
always-on — no spin-down, which a stateful event service cannot tolerate)
+ a 1 GB persistent disk (~$0.25/month): roughly **$7–8/month**; Resend free
tier covers magic-link volume. No per-request vendor costs. Prize pools are
Jim's separate spend decision, never part of infra cost.

---

## 3. Trust boundary (read before building anything)

The console is a client; clients lie. In v1, positions arrive **from the
client** — there is no server-side world simulation to check them against.
The design therefore splits honestly:

- **Enforced server-side** (§7): claim radius against server-held
  coordinates, atomic single winner, event window, claim rate limits,
  speed plausibility between a user's own consecutive reports, identity
  required to claim.
- **Logged for review** (§7): full position trails, so a fraudulent claim
  can be replayed and a prize re-issued or a winner disqualified by an
  admin *before* the code is treated as spent **[ASSUMPTION: a code
  revealed to a disqualified winner may already be redeemed — Phase 1
  mitigates by keeping prize values small ($25–$50 pool, amendment §8),
  not by pretending the hole is closed]**.

This is the deliberate Phase 1 posture: small prizes, total logging,
human review. Do not gold-plate it; do not hide it either.

---

## 4. Identity

Console accounts live in the parked gateway and are unreachable. Hunt v1
gets its own lightweight identity, sufficient for code claims now and a
verified payout address later.

### Mechanism: email magic-link

1. User enters an email (console settings or the claim flow).
2. Service emails a single-use link (token = 32 random bytes, **only the
   SHA-256 hash is stored**, 15-minute expiry).
3. Opening the link creates a **session**: an opaque 32-byte token, stored
   hashed, 30-day expiry, sent to the console as a bearer token
   **[ASSUMPTION: console keeps it in `localStorage`; the parked gateway's
   own known localStorage-token risk (GO_LIVE §8) is accepted for Phase 1
   code-prize stakes and revisited before cash]**.
4. No passwords anywhere. No OAuth in v1. No bank data, ever (amendment §4
   hard rule).

### What it deliberately does NOT do

- No password reset flows, no credential recovery beyond re-sending a link.
- No profile system: a display name (default: email prefix, editable) is
  the only public identity. The public feed shows **display name only,
  never email**.
- No age attestation in v1 — codes only; the Phase 2 cash flow adds the
  18+ gate at claim time (amendment §7).
- Not a general AIVerse account: it authorizes hunt actions only.

### Merge path (when/if the gateway relaunches)

- `hunt_users.email` is the join key to the gateway's owners table.
- A one-time linking migration adds `hunt_users.gateway_owner_id`; claims
  keep pointing at the stable `hunt_users.id`, so claim history survives
  the merge untouched.
- After linking, gateway sessions can mint hunt sessions; magic-link stays
  as the fallback login. Nothing in Phase 1 blocks this.

---

## 5. Data model (SQLite; all timestamps UTC epoch-ms integers)

Money is integer cents. Coordinates are world metres in the console's City 3
frame, stored as REAL x/y/z. **[ASSUMPTION: the claim check uses horizontal
(x,z) distance; y is logged for replay.]**

### 5.1 `hunt_users`

| Field | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `email` | TEXT UNIQUE NOT NULL | lowercased |
| `display_name` | TEXT NOT NULL | public; never the email |
| `created_at` | INTEGER | |
| `gateway_owner_id` | TEXT NULL | merge path, §4 |
| `status` | TEXT | `active` \| `suspended` (fraud review) |

### 5.2 `auth_tokens` / `sessions`

| Field | Notes |
|---|---|
| `id` PK, `user_id` FK | |
| `kind` | `magic` \| `session` |
| `token_hash` | SHA-256 hex; raw token never stored |
| `expires_at`, `consumed_at` (magic), `created_at` | magic: single-use, 15 min; session: 30 days |

### 5.3 `events`

| Field | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `slug` | TEXT UNIQUE | public URL/handle, e.g. `bazaar-drop-001` |
| `title`, `district` | TEXT | district = starting hint tier |
| `starts_at`, `ends_at` | INTEGER | server clock is authoritative |
| `state` | TEXT | `draft` → `scheduled` → `live` → `ended` (admin may `pause`/`cancel`) |
| `pool_cap_cents` | INTEGER NOT NULL | the announced cap; invariant I2 |
| `claim_radius_m` | REAL | per-event override; default §10.3 |
| `created_by` | TEXT | admin identifier |

### 5.4 `prizes` — the custody table

| Field | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `event_id` | TEXT FK | |
| `label_public` | TEXT | what the world may know ("a game key", "a $10 coupon") |
| `kind` | TEXT | `gift_code` \| `game_key` \| `coupon` (Phase 1 set) |
| `face_value_cents` | INTEGER | counts against the pool cap |
| `x`, `y`, `z` | REAL | **server-only; never serialized to any client response except the winner's own claim verdict metadata (label only, never coordinates)** |
| `code_encrypted` | BLOB | AES-256-GCM ciphertext (see below) |
| `code_nonce` | BLOB | per-prize random nonce |
| `state` | TEXT | `seeded` → `claimed` \| `expired` \| `voided` |
| `claimed_by_user_id` | TEXT NULL FK | set exactly once (invariant I1) |
| `claimed_at`, `reveal_count` | | `reveal_count` must never exceed 1 per winner re-read allowance — §6 |

**Code custody.** Codes are encrypted at seed time with AES-256-GCM under a
single service key from the environment (`HUNT_CODE_KEY`, base64 32 bytes,
set as a Render secret env var at deploy time). The key never touches the repo, the
database, or any log. **Decryption happens in exactly two code paths:**
(a) the winning-claim response (§6), (b) an admin reveal (§9) which writes
an `audit_log` row. A seed-time plaintext code exists only in the admin's
seed request memory; the admin CLI reads it from a local file that is never
committed.

### 5.5 `claim_attempts` — every attempt, not just wins

| Field | Notes |
|---|---|
| `id` PK, `event_id`, `prize_id` NULL, `user_id` | |
| `x`, `y`, `z`, `body_id`, `client_ts` | as reported |
| `received_at` | server clock; the only timestamp verdicts use |
| `verdict` | `won` \| `no_prize_in_radius` \| `already_claimed` \| `too_fast` \| `rate_limited` \| `event_not_live` \| `suspended_user` |
| `distance_m` | distance to nearest prize in radius check, when computed |

Partial unique index: `UNIQUE(prize_id) WHERE verdict='won'` — the database
enforces exactly one winner even if application code races.

### 5.6 `position_samples` — the replay trail

`id`, `user_id`, `event_id`, `x/y/z`, `body_id`, `received_at`. Written by
claim attempts and by hunt-mode position pings (§6.3). Retained for the
event's review window **[ASSUMPTION: 90 days, then pruned by a ticker job]**.

### 5.7 `payout_addresses` — **Phase 2 shape only (table exists, unused)**

| Field | Notes |
|---|---|
| `user_id` PK FK | one per user |
| `kind` | `paypal` (only kind defined) |
| `address` | PayPal email/handle — an address, never a credential |
| `verified_at` NULL | set by the amendment §4 confirmation loop (Phase 2) |
| `created_at`, `updated_at` | uniqueness of `address` across users is the one-payout-per-person groundwork (amendment §6) — enforced Phase 2 |

### 5.8 `hint_schedule`

`id`, `event_id` FK, `tier` (`district|neighbourhood|street|room`),
`text` (the hint copy), `fires_at`, `fired_at` NULL. Condition rule: a hint
fires at its time **only if its prize set is still unclaimed** — for Phase 1
(single-headline + scatter format) the schedule binds to the event, and a
hint whose tier's prizes are all claimed is skipped. **[ASSUMPTION: Phase 1
events bind hints to the event, not per-prize; per-prize ladders are a
Phase 3 density feature.]**

### 5.9 `pool_ledger` — append-only

`id`, `event_id`, `entry_type` (`seed` | `claim_award` | `void` |
`expire_return`), `prize_id` NULL, `amount_cents`, `created_at`, `note`.
No UPDATE/DELETE path exists in code. The ledger is the Phase 2 payout
receipt source (§9).

### 5.10 `announcements` (outbox) + `audit_log`

`announcements`: `id`, `event_id`, `type` (§8), `payload_json`, `created_at`
— every emitted hunt event is persisted **before** fan-out, so the feed is
replayable and a reconnecting console can catch up by id.
`audit_log`: `id`, `actor` (`admin:…` | `system` | `user:<id>`), `action`,
`subject`, `detail_json`, `created_at` — admin reveals, voids, suspensions,
and disqualifications land here.

### Invariants (tests must prove each)

- **I1** Exactly one `won` claim per prize (partial unique index + §6
  transaction).
- **I2** `SUM(face_value_cents)` over an event's non-voided prizes ≤
  `events.pool_cap_cents`, checked inside the seed transaction; seeding
  beyond the cap fails atomically.
- **I3** A code's plaintext leaves the service only via the two decrypt
  paths in §5.4.
- **I4** No response on any public/hunter endpoint contains prize
  coordinates or another user's email.
- **I5** Ledger is append-only; event totals always reconcile:
  seeded = awarded + expired/voided + still-live.

---

## 6. The claim (the heart of the service)

### 6.1 Request — `POST /v1/claims`

Headers: `Authorization: Bearer <session token>`.
Body:

```json
{
  "event_id": "uuid",
  "body_id": "remy",
  "position": { "x": 12.4, "y": 0.2, "z": -71.8 },
  "client_ts": 1762646400123
}
```

Note what is **absent**: no prize id. The hunter claims *where they stand*;
the service decides what, if anything, is there. A client that could name
prizes could enumerate them.

### 6.2 Server checks, in order (first failure wins; every attempt logged)

1. Session valid; user `active`.
2. Event exists and is `live` at server `received_at`.
3. Rate limit (§7).
4. Speed plausibility: distance from this user's last accepted sample in
   this event ÷ elapsed server time ≤ the body's cap (§7); else
   `too_fast`, and the sample is still logged.
5. Radius search: unclaimed prizes in this event within
   `claim_radius_m` (horizontal distance). None → `no_prize_in_radius`.
6. **Atomic win**: inside one `BEGIN IMMEDIATE` transaction — re-check the
   prize is still `seeded`, set `state='claimed'`, `claimed_by_user_id`,
   insert the `won` claim_attempt, insert the ledger `claim_award`, insert
   the `prize_claimed` announcement. Commit. The partial unique index
   (I1) is the backstop.
7. Only now decrypt the code (path (a), §5.4) for the response.

### 6.3 Responses

```jsonc
// won — ONLY to the winner, ONLY here
{ "result": "won", "prize": { "label": "a $10 gift code", "kind": "gift_code" },
  "code": "XXXX-XXXX-XXXX", "event_slug": "bazaar-drop-001" }

// every other outcome — no code, no coordinates, no distances to real prizes
{ "result": "no_prize_in_radius" }        // 200
{ "result": "already_claimed" }           // 200 — a prize was here, it's gone
{ "result": "too_fast" }                  // 200, verdict logged
{ "result": "event_not_live" }            // 409
{ "result": "rate_limited", "retry_after_s": 2 }  // 429
// 401 unauthenticated, 403 suspended
```

The winner may re-read their own code at `GET /v1/me/wins` (authenticated,
winner-only) — a lost code is a support incident otherwise; re-reads are
audit-logged but do not change `reveal_count` semantics for anyone else
(I3 holds: only the winner ever receives it).

**[ASSUMPTION: `already_claimed` is returned when the nearest in-radius
prize is claimed — it confirms a hiding spot after the fact, which the plan
already treats as public knowledge once a prize is taken.]**

### 6.4 Position pings — `POST /v1/positions`

Optional hunt-mode heartbeat (same auth/body): `{event_id, body_id,
position, client_ts}` → `204`. Writes `position_samples`, runs the same
speed check (violations logged, not rejected). **[ASSUMPTION: the console
sends one ping per 5 s while a logged-in user is in a live event's
district — §10.4 asks Jim to confirm this is acceptable.]** Pings are what
make the speed cap a trail instead of a single jump measurement.

---

## 7. Anti-cheat — enforced vs logged, honestly split

Body speed caps come from the roster's **measured constants** (plan
integrity rule). The service keeps a `body_constants` table
(`body_id`, `max_speed_mps`) seeded at deploy from the console cast's
measured values **[ASSUMPTION: values are copied from the console's cast
data at build time; a global ceiling of 8 m/s applies to any unknown
body_id]**, with a tolerance factor of 1.25 for sample jitter.

| Measure | v1 status |
|---|---|
| Claim radius vs server-held coordinates | **Enforced** (§6.2.5) |
| Exactly one winner (atomic claim + unique index) | **Enforced** (I1) |
| Event window (no early/late claims) | **Enforced** (§6.2.2) |
| Claim rate limit: 1 attempt / 2 s / user; 60 / min / user; event-wide burst cap **[ASSUMPTION: numbers are starting values, tuned after hunt v0 data]** | **Enforced** (in-process counters) |
| Speed plausibility between a user's consecutive samples (claims + pings) | **Enforced at claim time** (`too_fast` verdict); ping violations logged only |
| Identity required to claim; suspended users blocked | **Enforced** |
| Full position trails for replay review | **Logged** (§5.6) |
| Admin disqualify + void + re-seed after review | **Manual** (§9) — the Phase 1 fraud answer |
| One payout per person (payout-address uniqueness) | **Groundwork only** — table shape §5.7; enforcement is Phase 2 (cash) |
| Multi-account / Sybil detection heuristics | **Logged only** (shared payout address, email patterns, IP in audit) — no automated action in v1 |
| Hologram proof-of-attention (Amendment 1) as a claim prerequisite | **Not in v1** — the ritual is a console behaviour; the service records `announcements` delivery, not attention. Revisit if contest entry needs gating |
| Client position authenticity (teleport with plausible pacing) | **Cannot be enforced in v1** — see §3. Mitigations: small prizes, trails, review |

---

## 8. Hint ladder + announcement contract

### 8.1 Timing authority

The **server clock is the only clock**. `starts_at`, hint `fires_at`, and
claim verdicts all use server time. Client timestamps are logged, never
trusted. Event state transitions (`scheduled→live→ended`) and hint firing
run on the 1 s ticker; a hint fires only if its event is `live` and its
tier's prizes remain unclaimed (§5.8).

### 8.2 Event types (payloads persisted to `announcements` first)

| Type | When | Payload (public-safe) |
|---|---|---|
| `hunt_start` | event → live | `{event_slug, title, district, pool_label, ends_at}` — pool_label is copy ("$50 in codes"), not a prize list |
| `hint` | ladder tier fires | `{event_slug, tier, text}` |
| `prize_claimed` | a claim wins | `{event_slug, prize_label, winner_display_name}` — **never coordinates, never the code** |
| `hunt_end` | event → ended | `{event_slug, claimed_count, total_count}` |
| `ping` (private) | hunt_start + each hint, per Amendment 1 | `{kind, prize_class, expiry}` — delivered only on the authenticated feed (§8.3); carries enough to choose by, nothing more |

The big-tier rule (Amendment 1) is a *console* rendering decision (tower
screen + hologram ritual vs light cue); the service marks `hunt_start`
payloads with `"tier": "major" | "minor"` so the console can decide
without a second source of truth. **[ASSUMPTION: Phase 1 events are all
`major` except daily-drop-style repeats, which the admin marks `minor` at
creation.]**

### 8.3 How the console subscribes — **SSE for announcements, polling for state**

- **Announcements: Server-Sent Events** — `GET /v1/events/:slug/feed`
  (public stream: the four public types) and `GET /v1/feed` with a session
  token (adds private `ping`s for that user). One-way, text-based,
  auto-reconnecting, trivial in Hono, and correct for a starting-gun
  signal where a 5 s polling lag would smear the start. Catch-up:
  `?after=<announcement_id>` replays from the outbox.
- **Event state / live counter: short polling** — `GET
  /v1/events/:slug/state` every 5 s with `ETag`/`Cache-Control: public,
  max-age=2`. Counters tolerate 5 s staleness; SSE would buy nothing and
  spectator tabs are the highest-count, lowest-value connections.
- Rejected: WebSockets (bidirectional machinery for a one-way signal —
  the gateway's WS stack stays parked with it); long-polling (SSE is
  strictly simpler here).

---

## 9. API surface (complete)

Base `/v1`. JSON everywhere. Errors: `{ "error": "<code>" }` + status.

### Public (no auth)

| Method & path | Returns |
|---|---|
| `GET /health` | `{ok, version, server_time}` |
| `GET /v1/events` | live + scheduled events: slug, title, district, window, state, tier |
| `GET /v1/events/:slug/state` | **the live counter**: `{state, starts_at, ends_at, prizes_total, prizes_claimed, prizes_remaining, server_time}` — counts only, never labels of unclaimed prizes **[ASSUMPTION: claimed prizes' labels may be listed on a "recent finds" strip; unclaimed labels never]** |
| `GET /v1/events/:slug/feed` | SSE, §8.3 |

### Hunter (session bearer)

| Method & path | Notes |
|---|---|
| `POST /v1/auth/magic-link` `{email}` | always 202 (no account enumeration) |
| `GET /v1/auth/consume?token=…` | sets session; redirects to console with session token **[ASSUMPTION: token passed via URL fragment so it never hits server logs]** |
| `GET /v1/me` | `{id, display_name, email}` (own email only) |
| `PATCH /v1/me` `{display_name}` | |
| `POST /v1/claims` | §6 — the claim contract |
| `POST /v1/positions` | §6.4 pings |
| `GET /v1/me/wins` | own wins: prize label, event, code (winner-only re-read), claimed_at |
| `GET /v1/feed` | SSE incl. private pings |
| `PUT /v1/me/payout-address` | **Phase 2 — not built**; shape reserved: `{kind:"paypal", address}` |

### Admin (`Authorization: Bearer <HUNT_ADMIN_TOKEN>`, env-set, separate from all user auth)

| Method & path | Notes |
|---|---|
| `POST /v1/admin/events` | create event (draft) incl. `pool_cap_cents`, radius, tier |
| `POST /v1/admin/events/:id/prizes:bulk` | seed prizes `[{label_public, kind, face_value_cents, x,y,z, code}]` — one transaction, I2 enforced; codes encrypted in-handler, plaintext never persisted or logged |
| `POST /v1/admin/events/:id/hints:bulk` | seed the ladder |
| `POST /v1/admin/events/:id/{schedule,pause,cancel,end}` | state control |
| `GET /v1/admin/events/:id/claims?verdict=&user=` | fraud review: attempts + trails |
| `GET /v1/admin/events/:id/ledger` | pool ledger (§5.9) |
| `POST /v1/admin/prizes/:id/void` / `POST /v1/admin/users/:id/suspend` | review actions; audit-logged |
| `POST /v1/admin/prizes/:id/reveal` | decrypt path (b); audit-logged; for support only |
| `GET /v1/admin/events/:id/receipts` | **Phase 2 shape**: per-win rows `{winner_display_name, prize_label, face_value_cents, claimed_at, payout_address (masked), payout_status}` — in Phase 1 `payout_status` is `n/a_code_revealed` and the export is the claim-receipt record |

### Admin in practice (smallest usable thing)

A **CLI in the service repo** (`bun run admin -- <cmd>`) that reads an
**event seed file** (JSON: event + prizes + hints; codes in a separate
`codes.local.json`, gitignored) and calls the admin API. No admin web page
in v1 — a page is a second frontend and a second auth surface; the CLI +
ledger endpoint is enough for Phase 1's handful of events. Jim's flow:
approve pool → Jett prepares seed file → CLI seeds → counter page shows
the event. **[ASSUMPTION: admin actions are run by Jett on Jim's word, as
with other ops in this workspace.]**

---

## 10. Build order (gates stated before results; counts reported per slice)

Each slice lands with `bun test` green and its count reported. A slice is
done when its acceptance run passes, not when its code exists.

1. **Skeleton.** Hono app, config/env validation, `/health`, SQLite open +
   migrations runner, ticker stub. *Acceptance:* service boots cold;
   `/health` 200; test count ≥ 1 (boot/config tests).
2. **Data layer + invariants.** §5 schema; seed transaction with I2;
   partial unique index I1. *Acceptance:* tests prove I2 (over-cap seed
   fails atomically, zero partial rows) and I5 reconciliation on a seeded
   fixture event.
3. **Identity.** Magic-link issue/consume, sessions, `/v1/me`.
   *Acceptance:* end-to-end test — request link → consume → session works,
   token reuse fails, expired link fails, raw tokens absent from the DB
   (hash-only assertion).
4. **Events + admin CLI.** Admin auth, event CRUD/state machine, prize +
   hint bulk seeding, ledger writes. *Acceptance:* CLI seeds a fixture
   event from a seed file; public `GET /v1/events` shows it; ledger shows
   the seed entries; no code plaintext anywhere in the DB file (grep the
   raw file for a seeded code — must be absent).
5. **Claims.** §6 pipeline end to end: window, rate limit, speed check,
   radius, atomic win, decrypt-on-win, `/v1/me/wins`. *Acceptance:*
   concurrency test — 50 parallel claims on one prize yield **exactly
   one** `won` and 49 honest verdicts; distance/speed/window verdict
   tests each pass; I4 test (no coordinates/emails in any response).
6. **Announcements + counter.** Outbox, ticker firing hints on schedule
   with the unclaimed condition, SSE feeds (public + private ping), state
   endpoint with ETag. *Acceptance:* scripted run — event goes live,
   `hunt_start` arrives on the feed, a hint fires at its offset, a claim
   produces `prize_claimed` with no coordinates in the payload, counter
   increments.
7. **Localhost end-to-end (the final proof).** Console (local build) +
   service (local): seed a real event via the CLI → a hunter (Scout
   harness or walk mode) travels to the spot → claim → **code revealed to
   the winner only** → public counter updates → `hunt_end` fires.
   *Acceptance:* the full run logged and screenshotted; final `bun test`
   count reported against slice 1's baseline; spec deviations, if any,
   written back into this document.

Deploy (a Render web service + persistent disk, secret env vars
`HUNT_CODE_KEY`, `HUNT_ADMIN_TOKEN`, Resend key) is a **separate step
requiring Jim's word** after slice 7 — this spec authorizes no deploy.

---

## 11. Open decisions for Jim (with recommendations)

1. **Claim radius. DECIDED (hunt v0 evidence, folded in 2026-11-08):**
   default **1.5 m** — measured arrival scatter at stand points is
   0.43–0.76 m; spots sit ≥8 m apart so 1.5 m creates no ambiguity.
   Per-event override kept (this supersedes the original 2.0 m proposal).
2. **Winner publicity. BUILT TO THE RECOMMENDATION (2026-11-08):** display
   name shown on the public feed; `publicity_opt_out` on the user (set via
   `PATCH /v1/me`) makes the feed say "a hunter" instead. The Phase 2
   consent capture in the claim flow remains a Phase 2 item.
3. **Position pings. BUILT TO THE RECOMMENDATION (2026-11-08):** pings are
   accepted only against live events (hunt mode only, enforced
   structurally — §6.4 evaluations return `event_not_live` otherwise);
   the 5 s cadence and the event-rules copy are the console's side.
   Note: with delta D1, a ping carries a full claim evaluation, so speed
   plausibility is enforced on the ping path too (a ping that would win
   must pass it); §7's "ping violations logged only" applies to pings
   that resolve no claim.
4. **Code-key custody. BUILT TO THE RECOMMENDATION (2026-11-08):**
   `HUNT_CODE_KEY` is a secret env var (production refuses to boot without
   it); if it is lost, unclaimed codes are unrecoverable (prizes void,
   pool re-seeded). Jim holds a sealed offline backup of the production
   key; the service never stores it. The backup handoff is a deploy-time
   step, fenced with the deploy.
5. **Magic-link sender. BUILT TO THE RECOMMENDATION, with the production
   step fenced (2026-11-08):** the Resend sender path is implemented
   (`HUNT_EMAIL_MODE=resend`), but the shipped default is the stub/log
   mailer and NO DNS or production email config was changed by the build.
   Verifying the `aiverse.network` sending domain in Resend is a
   production-deploy step, on Jim's word with the deploy.
6. **Geography for code hunts. BUILT TO THE RECOMMENDATION (2026-11-08):**
   no geo-blocking anywhere in v1; each prize's redemption region is
   stated in its `label_public` copy at seed time. (Cash geography stays
   a Phase 2 question, per the amendment.)

---

*End of spec. Build nothing from this document without Jim's go on the
build itself; deployments additionally need his word per §10.*
