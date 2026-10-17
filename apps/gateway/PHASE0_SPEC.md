# Phase 0 spec — register-first connect + burst defenses (TS gateway)

Base: `tmp/fanout-digest-ts` @ `a4cd49a` (tree == prod `d306fb1a`).
Reference implementation: the Go edge on `tmp/go-edge-parity` (`apps/go-edge/`),
whose register-first connect is built and soak-proven. **Where TS and Go
observable behavior could differ, Go wins; list every deviation in the
implementation commit message.**

## Problem (measured, 2026-10-17 TS soak)

Ready mode (publish after all clients receive `agent_connected`): zero loss,
500,000/500,000. Burst mode (100 broadcasts in one 14 ms instant during a
2,500-connection storm on the publishing instance): the already-registered
peer received 250,000/250,000; the still-connecting cohort received
**0/250,000**. Cause: the TS connect path runs DB work (agent fetch, visit
gate, status write, backlog queries) *before* the socket joins the fanout
registry, so any frame fanned out during a socket's setup is lost to it.

## 1. Register-first connect (`src/ws/gateway.ts`, `src/ws/presence.ts`)

Reorder the agent-socket connect path:

1. Validate the ticket (Redis GETDEL) → `agentId`. (Unchanged; failure = 4001.)
2. **Immediately** create the connection record and register the socket in the
   fanout registry in state `setting_up`, before any further DB reads/writes.
3. While `setting_up`, fanout frames addressed to this socket are appended to
   a per-socket pending buffer (bounded; mirror the Go edge's cap and
   overflow behavior).
4. Run the existing gates in the existing order with the existing close codes
   (4003 paused, 4005 unclaimed, 4008 visit-ended, 4006 replace semantics).
   On any gate failure: unregister, discard the buffer, deliver nothing.
5. Compute the backlog exactly as today. Dedupe buffered frames against the
   backlog by message identity (same rule the Go edge uses against its
   pending-ingest/backlog path). Flush order: backlog first, then buffered
   frames in arrival order. Then state = `live`.
6. Acks keep their meaning: a frame is acked only when actually written to
   the socket (post-flush counts). No ack for buffered-then-dropped frames.
7. Presence digest collection point for the join: mirror the Go edge (join
   is collected when the connection becomes live, not at registration), so a
   gate-failed connection never appears in a digest.

No other behavior changes: frame shapes, digest windows (1 s / 250),
heartbeat (4002), console and public routes untouched.

## 2. Burst defenses

- **Reconnect budget:** per-agent fixed-window counter in Redis,
  key `ws:reconnect:{agentId}`, limit 30 connects / 5 min (seatbelt, tuned
  loose — storms are hundreds). On exceed: close **4009** with close reason
  `{"retry_after_ms": <ms until window reset>}`.
- **retry_after on shed closes:** any server-initiated shed (budget,
  admission) carries the same `retry_after_ms` hint in its close reason.
- **Connect admission cap:** per-process token bucket, 200 new agent-socket
  connects/sec sustained (burst allowance 400). Excess upgrade requests get
  HTTP **503** with a `Retry-After: 1` header before the socket opens.
  Connects/sec is a TLS+auth CPU guard, not a product limit.

## 3. Ack-cursor design note (deliverable: doc only, no code)

Write `apps/gateway/ACK_CURSORS_V1.md`: the Phase 1 design for replacing
per-message ack persistence with per-(agent, room) cursors — current ack
path traced through the code (where acks write today, at what rate the 5k
soak exercised them), the Discord Read States pattern (in-memory coalescing,
persist on eviction + 30 s scheduled commit), the Redis-cursor +
Postgres-checkpoint split, and the migration path that keeps ack semantics
identical for agents. No schema or behavior change in Phase 0.

## Tests (all required)

New tests in the ws suites:
- (a) a frame fanned out while the target socket is mid-setup is delivered
  exactly once, after the backlog, in order;
- (b) a gate failure after registration (4003/4005/4008 paths) delivers
  nothing and leaves no registry/presence residue;
- (c) reconnect budget: the 31st connect inside the window closes 4009 with
  a parseable `retry_after_ms`;
- (d) admission cap: upgrades beyond the cap receive 503 + `Retry-After`.

Existing suites must stay green (gateway, offlineDelivery, app,
nativeAgents modulo its known rotating timing flake — reproduce any
failure on the base tree before attributing it to this change).

Suites run against a pristine UTC test DB (`ALTER DATABASE … SET timezone
TO 'UTC'`; the schema is timestamp-without-time-zone throughout), single
run — the suites are not re-runnable against a dirty DB.

## Exit bar (parent will verify independently)

- Burst soak re-run: the connecting cohort's loss collapses to parity with
  the registered peer (was 0/250,000).
- Ready-mode soak re-run: still 500,000/500,000.
- Full ws suites green on a pristine UTC DB.
