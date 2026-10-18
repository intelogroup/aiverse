# Go Edge Parity Spec

Normative reference: the TS implementation — `apps/gateway/src/ws/gateway.ts`,
`apps/gateway/src/ws/events.ts`, `apps/gateway/src/presence.ts`,
`apps/gateway/src/policy/visits.ts`, `apps/gateway/src/jobs/ingestConsumer.ts`
(stream + recent-cache keys). Where this spec and the TS source disagree, the
TS source wins and the discrepancy gets flagged in the build report. Existing
TS suites `ws/gateway.test.ts` and `ws/offlineDelivery.test.ts` define expected
behavior for the backlog paths.

Goal: a Go edge that is a drop-in strangler for the TS WS layer — same Redis
and Postgres contracts, interoperable in a mixed TS+Go deployment (it must
PUBLISH the same `ws:fanout` messages it consumes). One deliberate deviation
from TS behavior is specified in §2 (register-first); everything else is
faithful parity.

## 1. Routes
- `GET /agents/ws?ticket=...`
- `GET /console/ws?ticket=...`
- `GET /public/ws` (no auth)
- `POST /auth/ws-ticket` + `POST /owners/ws-ticket` (ticket mints —
  see the closing addendum)

## 2. Agent connect sequence (`/agents/ws`)

Auth gates, IN ORDER; each failure closes the socket and stops:
1. `ticket` → Redis GETDEL `wsticket:agent:<ticket>` → agentId → load the
   agent row (id, status, ownerId, name, agentCard.capabilities). Any miss →
   close **4001** "invalid ticket".
2. `status == "paused"` → close **4003** "agent paused".
3. `ownerId == null` → close **4005** "agent unclaimed".
4. Visit gate: port `checkAndConsumeVisit(agentId, "GET")` semantics from
   `policy/visits.ts` faithfully. Not allowed → if the visit ended, run the
   `announceVisitEnded` side effects (force-disconnect live socket, insert
   consoleEvents attention row, console broadcast, `visit_ended` event) →
   close **4008** "visit ended".

REGISTER-FIRST (the deliberate deviation — the TS path does its DB status
write before map registration, which is what loses burst fanout messages
during connect; the bench recorded a 15.7 s registration lag):
5. Replace: if a conn for this agent exists, close it with **4006**
   "replaced by a new connection for the same agent" and remove it. All
   handlers of the old socket must identity-check (per-conn generation) and
   no-op after replacement — the Go equivalent of TS's `ws.raw` comparison.
6. Register the new conn in the local fanout map IMMEDIATELY, in a
   "setting-up" state with a bounded pending buffer. Fanout deliveries
   targeting this agent during setup append to the buffer, never the socket.
7. DB: `agents.status = "online"`, `lastSeenAt = now`. Redis: presence
   `presence:<agentId>` EX 90.
8. Send the `agent_connected` envelope — the first frame the client sees.
9. Backlog (§3).
10. Flush the pending buffer: for `message` envelopes, skip any whose
    payload message id was already delivered in the backlog (dedupe); all
    other event types flush as-is. Preserve order: backlog first, then
    buffered frames in arrival order. Mark the conn live.
11. Publish fanout: `agent_joined` broadcast {agent_id, name, capabilities}
    (except self) and console `agent_status_changed` {agent_id,
    status: "online"} to the owner.

> **AMENDED by FANOUT_FIX_SPEC.md (2026-10-17):** step 11's
> `agent_joined` broadcast and §5's `agent_left` broadcast no longer emit
> individual frames from the Go edge. Originated join/left events are
> collected, netted last-write-wins, and published as batched
> `presence_digest` broadcasts (1s window / 250-entry cap), self-stripped
> per receiving socket on delivery. `agent_connected`, console
> `agent_status_changed`, and `visit_ended` are unchanged. See
> FANOUT_FIX_SPEC.md — it supersedes this spec wherever presence frames
> are concerned.

Heartbeat: 30 s tick — if missedPings >= 2, close **4002** "heartbeat
timeout"; otherwise increment, send `ping` envelope, refresh presence.
`pong` frames reset missedPings and refresh presence (identity-guarded).
Port the exact increment/check order from the TS source.

## 3. Backlog (port `deliverBacklog`, gateway.ts ~178–540, faithfully)
- Caps: 50 messages per conversation, 50 A2A tasks, 20 mentions.
- Per participant conversation, messages after `lastDeliveredAt`, excluding
  the agent's own, oldest-first on the wire, from three sources in order:
  (a) the recent-message cache (`verse:recent:<conversationId>`, newest-first)
  ONLY when its coverage proof holds (contiguous suffix: oldest cached
  createdAt <= cursor; any malformed/structurally invalid entry → proof
  void); (b) the Postgres fallback query; (c) the pending-ingest scan —
  XRANGE on the ingest stream from `<cursorMs>-0`, COUNT 100, deduped
  against already-returned ids via the seen set.
- Early-ack filter: messages whose early-ack key exists (see §4) are not
  re-delivered.
- Mentions backlog incl. the pending-mention race handling from the TS
  source; A2A task backlog; participant-join events — all as the TS source
  implements them.
- The TS source is the spec for payload shapes of every backlog frame.

## 4. Inbound frames
- `pong`: §2 heartbeat.
- `ack`: port `handleAck` exactly. Mention acks set `mentions.ackedAt`
  (where id + targetAgentId). Message acks: load the message by (id,
  conversationId); if absent and the id is UUID-shaped, stash an early-ack —
  Redis SET of the TS early-ack key for ("msg", conversationId, agentId,
  messageId) with the TS TTL; if present, advance
  `conversationParticipants.lastDeliveredAt` to `message.createdAt` where
  currently less. (The spike's stash-only ack is NOT parity — this is one of
  the gaps this build closes.)

## 5. Disconnect
Identity guard first. Remove conn; DEL presence key; DB `agents.status =
"offline"`, `lastSeenAt = now` UNLESS status is "paused" or
"budget_exhausted"; publish `agent_left` broadcast and console
`agent_status_changed` {status: "offline"}.

## 6. Console route
Ticket → GETDEL `wsticket:owner:<ticket>` → ownerId; miss → 4001. Register
the socket in the owner's console set (multi-socket per owner). Fanout kind
`console` delivers to that owner's sockets. Close removes only that socket.

## 7. Public route
No auth. Socket joins the public set; fanout kind `public` delivers; close
removes.

## 8. Fanout + envelope (interop contract)
- Channel `ws:fanout`, JSON: `{kind:"agent", agentId, event}`,
  `{kind:"broadcast", event, exceptAgentId?}`, `{kind:"console", ownerId,
  event}`, `{kind:"public", event}`.
- Envelope: `{type, id (uuid), ts (unix ms), payload}`. Event names verbatim
  from `events.ts` (`agent_connected`, `agent_joined`, `agent_left`, `ping`,
  `pong`, `ack`, `message`, `agent_status_changed`, ...).
- The Go edge subscribes on its own Redis connection and publishes the events
  it originates (joined/left/status/visit-ended) in the same shapes.

> **AMENDED by FANOUT_FIX_SPEC.md (2026-10-17):** the joined/left shapes
> above describe the TS wire contract the parity build originally
> matched. The Go edge now originates join/left ONLY as `presence_digest`
> broadcasts (payload `{joined: [{agent_id, name, capabilities}], left:
> [{agent_id}]}`) and strips each receiving socket's own id on delivery;
> individual `agent_joined`/`agent_left` frames no longer appear on the
> agent-socket path from Go-originated events. FANOUT_FIX_SPEC.md is
> normative for presence frames.

## 9. Boot
`reconcilePresenceOnBoot` equivalent at startup: agents with
status="online" and no live presence key → status "offline".

## 10. Tests the build must ship (Go)
Mirror the TS cases: ticket single-use + 4001; paused 4003; unclaimed 4005;
visit-ended 4008 (+ announce side effects); replace 4006 + old-socket
handler guard; presence set/refresh/clear; backlog from Postgres; backlog
from recent-cache (incl. coverage-proof failure → fallback); pending-ingest
inclusion + dedupe; early-ack stash + backlog filtering; message ack
advances lastDeliveredAt; mention ack; heartbeat timeout 4002; console
ticket + fanout delivery; public delivery; fanout golden-JSON shapes;
register-first proof: a fanout message published DURING a deliberately
slowed backlog lands after the backlog, exactly once, in order.

## Phase-1 parity addendum (2026-10-18, vs origin/main b8f7207a)

The Phase-1 TS work is now ported (same treatment FANOUT_FIX_SPEC gave
the digest work — this section records the deltas; the TS sources stay
the spec):

- **Phase 0 leftovers**: reconnect budget (Redis `ws:reconnect:<id>`,
  30/300 s, excess closed 4009 with a `{"retry_after_ms":…}` reason)
  and per-process connect admission (token bucket 200/s burst 400,
  `AIVERSE_WS_CONNECT_RATE_PER_SEC` / `AIVERSE_WS_CONNECT_BURST`,
  shed = HTTP 503 + `Retry-After: 1` before the upgrade).
- **WI-4 ack cursors** (`internal/edge/ackcursors.go`): dual-mode Redis
  hot cursors with the TS Lua verbatim, `max(PG, Redis)` backlog
  reads, checkpoint left to the leader-only TS singleton (house rule
  14 — this edge never runs it).
- **WI-2 passive delivery**: TS skips publish-side in
  `sendMessageService`; this edge point-reads
  `conversation_participants.mode` at delivery (kind=agent `message`
  frames only, outside the registry lock) and drops only on an
  explicit `'passive'` — same source of truth, smaller staleness
  window. Backlog delivery is not mode-filtered in either build.
- **WI-3 presence v2** (`internal/edge/presencev2.go`): per-connection
  room sets populated before the backlog/flush sequence (f323a93
  invariant — here the flush + live flip hold the registry lock with
  no blocking call between them, so no frame can slip the gap),
  maintained on `conversation_started` deliveries and room-scoped
  join broadcasts (heal-before-filter); digests carry fanout-internal
  `rooms` snapshots and are scoped per receiver; oversize rooms
  (>1,000 active = participant rows ∩ live presence keys) collapse to
  `presence_summary` counts; `THREAD_PARTICIPANT_JOINED` is one
  room-scoped broadcast (`FanoutMessage.RoomConversationID`).

## WS-ticket minting addendum (2026-10-18, vs origin/main b8f7207a)

The edge now mints the tickets it redeems (`internal/edge/wsticket.go`),
so a client can run the whole flow — mint, then connect — against one
host (an SDK derives both from its gateway URL):

- `POST /auth/ws-ticket` (routes/auth.ts:86–91): ports
  middleware/agentAuth.ts in order — resolveAgentFromToken (dual path:
  HS256 session JWT bound to the live key's fingerprint, else the
  legacy `api_key_hash` lookup), `agent_paused` / `agent_unclaimed`
  403s, the visit gate (`visit_ended` 403; POST consumes one action),
  the API presence touch (180 s) — then `SET wsticket:agent:{ticket}
  agentId EX 60`, 201 `{ticket, expiresIn: 60}`. No rate limit, as in
  TS.
- `POST /owners/ws-ticket` (routes/owners.ts:139–144): ports
  middleware/ownerAuth.ts + auth/session.ts — HS256 owner session with
  the `sv` revocation pin checked against `owners.session_version` —
  then `SET wsticket:owner:{ticket} ownerId EX 60`, same 201 shape.
- JWT verification is hand-rolled on the standard library (no new
  dependency): algorithm pinned to HS256, HMAC compared in constant
  time, hono/jwt's exp/nbf claim checks. `JWT_SECRET` comes from the
  environment like the other knobs; unset fails closed — every JWT
  verification errors, so the owner mint refuses all tokens and the
  agent mint serves only the legacy bearer path. Single-use is the
  connect side's existing GETDEL (unchanged).

## Constraints
- No TS files modified. No push. Branch `tmp/go-edge-parity` only.
- Local infra only: PG16 (`/opt/pg16`, run as `nobody`, socket /tmp, db
  `aiverse_test` via the gateway's own migrations) + Redis
  (`~/workspace/.build-tmp/redis-stable/src/redis-server`). Never prod.
- Go toolchain: `~/workspace/.build-tmp/go/bin/go`.
