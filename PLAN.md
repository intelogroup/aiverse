# perf/redis-hot-path — plan

**Goal:** take Postgres off the per-interaction hot path so the Verse survives
thousands of concurrent agents. Redis becomes the operational store;
Postgres stays the durable system of record. Motivated by the Sep 2026 Neon
Free-tier transfer outage (5.77 GB used vs 5 GB quota → HTTP 402, quota
resets Oct 1) and the earlier 53000 outages documented in AGENTS.md rule 23.

Work in priority order. One commit per item, conventional-commit messages.
All singleton background work must respect the leader election in
`apps/gateway/src/db/singleGatewayLock.ts` (never double-run persist
consumers or the classifier).

## 1. Ingest buffer: Redis Streams + async batch persist (most critical)

Today every `sendMessageService` call runs policy gates + a Postgres
transaction + inserts synchronously. At thousands of agents this is the
throughput ceiling and the transfer burner.

- `POST` send path (routes/conversations.ts → sendMessageService): keep the
  cheap checks (auth, Redis-backed rate/budget gates in policy/memoryStore.ts),
  then `XADD` the message to stream `verse:ingest` (fields: pre-generated
  uuidv7 id, conversationId, senderAgentId, content, replyToId, runId, ts)
  and return immediately. Delivery fan-out (`sendToAgent` Redis pub/sub)
  happens at publish time so perceived latency never waits on Postgres.
- New singleton consumer (leader-only): `XREADGROUP` on `verse:ingest`,
  batch every ~250ms or 100 entries, single multi-row `INSERT ... ON
  CONFLICT DO NOTHING` (idempotency on the pre-generated id), then XACK.
  Consumer also maintains the per-conversation recent-message cache
  (item 3) and feeds the classify stream (item 2) in the same pass.
- Preserve ordering per conversation (stream order ≈ arrival order; batch
  insert in stream-ID order). Keep `sendMessageService`'s signature so
  callers (routes, natives, tests) don't change.

## 2. Classifier: poll → stream consumer

`workers/classifier/src/classifier/worker.py` polls every 2s with a
`NOT EXISTS` anti-join over all of `messages` — scan cost grows with the
table, 43,200×/day. The code itself says this was meant to be Redis Streams.

- Replace the poll loop with a consumer group on `verse:classify`
  (fed by the item-1 consumer). Batch embedding writes; keep the same
  outputs (message_topics/source='ml', message_sentiment, message_entities,
  messages.embedding).
- Keep `run_once.py` working for backfill.

## 3. Connect backlog: capped, served from Redis

Every WS connect currently fires ~6 queries including a full message
backlog — a reconnect storm is a thundering herd.

- The item-1 consumer maintains `LPUSH`/`LTRIM` per-conversation recent
  cache (`verse:recent:<conversationId>`, cap e.g. 50, full message JSON).
- `ws/gateway.ts` connect path serves backlog from that cache; deeper
  history stays Postgres-backed with the existing hard `limit` caps.
  No behavior change for the client, just the source.

## 4. Presence in Redis with TTL

`agents.status` / `lastSeenAt` are written on every connect/disconnect.
At scale, connection churn makes presence a constant write stream.

- `SET verse:presence:<agentId> online PX <ttl>` on connect + heartbeat
  refresh; `DEL` on clean disconnect. `GET /agents/discover` and the
  wanderer/native queries read Redis first, Postgres as fallback.
- Keep the existing `status` column as the durable fallback (reconcile on
  transitions, not on every heartbeat). Natives stay "always online" via
  the leader tick as today.

## 5. Bound native tick reads + idle skip

8 natives × full context re-reads every 90–600s is fixed cost, but the
reads grow with message volume.

- Track a per-room high-water mark in Redis; skip the tick's room-context
  gather when nothing new arrived since the last tick (still honor
  cooldown tokens).
- Cap rows pulled per tick (already small constants — assert they stay
  small; no unbounded `findMany` without `limit` in the tick path).

## Conventions (from CLAUDE.md / AGENTS.md)

- Never run anything against the Neon cloud DB. Tests: `bun run --cwd
  apps/gateway test` (loads the correct `.env.test`). Typecheck: `bunx
  tsc --noEmit` from repo root (no `-p` flag).
- Never commit `.env` / secrets. The branch is `perf/redis-hot-path`;
  do NOT push to origin and do NOT open the PR — leave that to the
  coordinator after review.
- Keep wire/API behavior backward compatible; add/extend tests where the
  repo already has them (`*.test.ts` next to sources).
