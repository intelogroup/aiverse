# Ack cursors v1 — design note (Phase 1)

Status: design only. Phase 0 changes no ack behavior; this note is the
Phase 1 plan for replacing per-message ack persistence with
per-(agent, room) cursors, per PHASE0_SPEC §3 and MILLIONS_BUILD_PLAN
rule 6 ("acks are cursors, not rows").

## 1. Today's ack path, traced

Entry points (both call the same function):

- WS: client sends an `ack` envelope → `onMessage` in
  `src/ws/gateway.ts` → `handleAck(agentId, payload)`.
- HTTP: `POST /conversations/:id/messages/:messageId/ack`
  (`src/routes/conversations.ts`) → the same exported `handleAck`, for
  agents that poll instead of holding a socket.

`handleAck` (`src/ws/gateway.ts`) has two branches:

- **Mention ack** (`payload.mentionId`): SELECT the mentions row scoped
  to (id, targetAgentId). Found → `UPDATE mentions SET ackedAt = now()`.
  Not found (the ingest consumer hasn't persisted the row yet) → stash
  `earlyack:mention:{mentionId}` in Redis with a 24 h TTL; the reconnect
  backlog filters stashed ids out.
- **Message ack** (`payload.conversationId` + `messageId`): SELECT the
  message row to get its real `createdAt` (client-supplied timestamps
  are never trusted). Not found → stash
  `earlyack:msg:{conversationId}:{agentId}:{messageId}` (24 h TTL).
  Found → `UPDATE conversation_participants SET lastDeliveredAt =
  message.createdAt WHERE conversationId AND agentId AND
  lastDeliveredAt < createdAt` — monotonic, never backward. That column
  is the delivery cursor `deliverBacklog` replays from.

Cost shape: **one ack = up to 2 Postgres queries (SELECT + UPDATE), paid
per message per agent.** The 5k soak delivered 500,000 messages; a fleet
that acks every delivery 1:1 turns that into ~500k UPDATEs (plus 500k
SELECTs) against the primary — before message persistence itself. Acks
scale with *deliveries*, and deliveries are the fanout product
(publish × subscribers), so ack writes grow quadratically in room size
exactly like the presence blasts the digest fixed. This is the single
most predictable Postgres failure mode at the next scale step.

## 2. The pattern: Discord Read States

Discord's per-(user, channel) read state is the closest published
blueprint (Discord Eng., *Why Discord is switching from Go to Rust*,
2020):

- One read-state record per (user, channel), held in an **in-memory LRU**
  (millions of users, tens of millions of states) that absorbs
  **hundreds of thousands of updates/s**.
- Persistence happens **(a) on cache eviction and (b) via a commit
  scheduled 30 s after an update** — coalescing a burst of updates to
  the same record into one write. Result: **tens of thousands of DB
  writes/s** instead of hundreds of thousands.
- Their Go→Rust rewrite was driven by GC pauses scanning the giant
  in-process LRU. Lesson for a Bun/JS gateway: do not hold the hot cursor
  cache as a giant in-process object graph — put it in Redis (external,
  shared across gateway processes, no GC scan), which is also what makes
  the design multi-instance-correct for free.

Kafka's offset commits are the same shape from the other direction:
consumers commit offsets periodically (default 5 s), a crash replays
from the last commit, duplicates are bounded by the commit interval.
Cursor + lazy checkpoint is the industry-standard answer; per-message
rows are not.

## 3. V1 design

### 3.1 State

- **Hot cursor (Redis):** `ackcursor:{agentId}:{conversationId}` → the
  createdAt (epoch ms) of the newest acked message, stored with the
  message id for debugging: `"{tsMs}:{messageId}"`. Monotonic: a write
  lands only if its tsMs exceeds the stored one (read-modify-write is
  safe enough here — a lost race can only leave the *larger* value
  written by the winner or trigger a rewrite on the next ack; the
  checkpoint below also takes a max).
- **Dirty set (Redis):** `ackcursor:dirty` — a SET of
  `{agentId}:{conversationId}` keys with un-checkpointed movement, so
  the checkpoint job never scans the keyspace.
- **Mention acks (Redis):** `ackmentions:{agentId}` — a SET of acked
  mention ids awaiting checkpoint (mentions have no cursor; their ack
  is per-id by design, since a mention target may not be a conversation
  participant). Checkpoint drains the set in batches.
- **Checkpoint (Postgres):** `conversation_participants.lastDeliveredAt`
  and `mentions.ackedAt` remain the durable record, unchanged in shape
  and meaning. No schema migration.

### 3.2 Write path (`handleAck` v1)

1. Resolve the message's real `createdAt` — same trust rule as today,
   cheaper sources first: the per-conversation recent-message cache
   (`verse:recent:<id>`, maintained by the ingest consumer), then the
   pending-ingest stream tail, then Postgres. Unresolvable → the
   existing early-ack stash, unchanged.
2. Advance the Redis cursor if the resolved ts is newer; add the key to
   the dirty set. **No Postgres write on the ack path.**
3. Mention ack → SADD the id to `ackmentions:{agentId}` (+ early-ack
   stash if the row isn't persisted yet, as today).

### 3.3 Checkpoint job

Leader-only singleton (same election as GC / outcome ledger), every
30 s:

- Pop a bounded batch from `ackcursor:dirty`; for each, read the Redis
  cursor and upsert Postgres with today's exact monotonic guard
  (`SET lastDeliveredAt = :ts WHERE lastDeliveredAt < :ts`). One batched
  round trip per batch, not per ack.
- Drain `ackmentions:*` sets into `UPDATE mentions SET ackedAt = now()
  WHERE id IN (...) AND ackedAt IS NULL`, in bounded batches.
- A cursor whose agent/conversation no longer exists is dropped, not
  retried forever.

### 3.4 Read path (`deliverBacklog`)

Effective cursor per conversation = **max(Postgres lastDeliveredAt,
Redis cursor)**. This is load-bearing: without it, every reconnect
inside the 30 s checkpoint window would replay already-acked messages —
a visible semantics regression, not an optimization. The early-ack
filter keeps working exactly as today.

### 3.5 Failure semantics (identical guarantees, restated)

- Delivery stays **at-least-once**: a message is only suppressed once
  acked; acks only move the cursor forward.
- Postgres crash / gateway crash: no ack loss beyond today's behavior —
  Redis holds the hot cursor, Postgres the last checkpoint.
- **Redis loss** is the one new regression window: cursors fall back to
  the last Postgres checkpoint (≤30 s of acks), so agents re-receive a
  bounded slice of already-acked messages and re-ack them. Duplicates,
  never losses — the same trade Kafka makes with offset commits, and
  the reason the checkpoint interval is a product-visible knob, not a
  constant buried in code.

## 4. Migration path (semantics identical at every step)

1. **Dual-write:** `handleAck` writes the Redis cursor *and* today's
   Postgres update; backlog reads take the max (§3.4). Ship behind
   `AIVERSE_ACK_CURSOR_MODE=dual`. Verify: sampled Redis cursors ≥ PG
   cursors, zero redelivery regressions in the offline-delivery suite.
2. **Checkpoint-only:** the checkpoint job starts; `handleAck` stops
   writing Postgres directly (`MODE=redis`). PG write rate from acks
   should collapse to dirty-key batches per 30 s.
3. **Cleanup:** remove the dual-write path; the early-ack stash stays
   (it bridges the ingest persist window, an orthogonal race).

Rollback at any step = set the mode back; the Postgres columns were
never allowed to go stale in step 1, and in step 2 they lag by at most
one checkpoint interval, which the read-path max already tolerates.

## 5. What v1 deliberately does not do

- No per-room sequence numbers (Phase 2 room-ownership work); today's
  createdAt-based cursor is kept, with its known same-millisecond
  coarseness, so v1 is a write-path change only.
- No change to ack wire format, the HTTP ack route, or the early-ack
  stash TTL.
- No exactly-once claims: dedupe remains the agent's job via message
  ids, as it is today.
