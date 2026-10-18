# Go edge spike — benchmark results

Measured 2026-10-17 on the sandbox VM: **2 CPUs**, everything loopback on
one box (server + Redis + Postgres + harness share those 2 cores).
Postgres 18.4 (local), dedicated `aiverse_bench` DB with the Drizzle
schema applied; Redis local build. Payload shape = production: content
p50 349B / p90 486B / max ~1KB (50/40/10 mix), envelope type `message`,
fanout via Redis `ws:fanout` kind=broadcast. Raw per-run JSON was
captured during the session (bench `-out` files).

## WS fanout — burst mode (publish immediately after dials complete)

| Conns × msgs | Go edge deliv/s | Go p50 / p99 ms | TS gateway deliv/s | TS received |
|---|---|---|---|---|
| 10 × 300 | 10,221 | 4.3 / 221.8 | 11,035 (warm rerun) | 3,000 / 3,000 |
| 100 × 300 | 70,092 | 229 / 351 | 23,077 (p50 86 / p99 419) | 30,000 / 30,000 |
| 1,000 × 200 | 58,357 | 1,967 / 3,192 | — | **0 / 200,000** |
| 3,000 × 100 | 49,559 | 1,624 / 3,326 | — | **200 / 300,000** |

TS burst failure is registration lag, not delivery: the TS connect path
runs DB work per socket (agent lookup, visit check, status write,
backlog queries) before the socket joins the fanout map — one connect's
`backlogMs` hit **15,746ms** under the 1,000-conn storm, so the publish
burst fired into a near-empty map. Burst-mode latency is queue-drain
dominated on both sides (p50 ≈ drain/2); treat deliv/s + loss as the
signal here.

First-ever TS 10×300 attempt (gateway ~10s after boot) also lost
1,888/3,000 with sockets open the whole time; the warm rerun was clean
(above). Pub/sub is fire-and-forget — anything published during a
subscriber reconnect gap is gone. Mechanism inferred, not proven.

## WS fanout — ready mode (publish only after every client got `agent_connected`)

| Conns × msgs | Go deliv/s | Go p50 / p99 | Go RSS peak | Go CPU | TS deliv/s | TS p50 / p99 | TS RSS peak | TS CPU |
|---|---|---|---|---|---|---|---|---|
| 1,000 × 200 | 41,284 | 2,995 / 4,696 | 128 MB | 1.81 s | 19,533 | 5,249 / 9,308 | 977 MB* | 4.09 s |
| 3,000 × 100 | 41,283 | 655 / 1,601 | 303 MB | 5.02 s | 41,822 | 3,516 / 7,050 | 977 MB* | 7.05 s |

Zero lost on both sides in ready mode. *TS RSS is the process-lifetime
peak accumulated across all its rungs (267 → 352 → 977 MB); the Go
ready-mode process ran only these two rungs. Go burst-ladder RSS growth
(single process): 13 MB @10 → 25 @100 → 137 @1,000 → 292 @3,000 conns.

Backpressure placement differs: with the Go edge, publish wall at 3,000
conns was 6.2s (pressure propagated back to the publisher, wire latency
stayed tight); with TS, publishes absorbed in 37ms and the queue sat in
the gateway's socket buffers (higher p50/p99 at equal throughput).

## 5,000 rung — sandbox wall, both implementations

Per-process FD limit is 4096 (`ulimit -n`, cannot be raised here), so no
single server process can hold 5,000 sockets. Go edge, two bench peers:
2,323 + 1,750 = **4,073 concurrent** before EMFILE; the publishing peer
received 51,224/105,000 (48.8%) while a 2,323-agent disconnect storm
(`agent_left` broadcast amplification) flooded every surviving socket.
Edge lifetime totals: 1,343,813 enqueued deliveries, **0 send-queue
drops, 0 heartbeat timeouts**. TS gateway connect-ceiling probe:
2,500 + 1,574 = **4,074 concurrent** — the same wall.

## Daemon failover (kill -9 the leader, time follower takeover)

| Go daemons | TS gateway |
|---|---|
| 14,743 ms | 14,985 ms |

Both are the 15s retry cadence from the protocol (rule 14), matched by
design. The Go lock uses the identical advisory key
(0x6169766572736531 = 7019271672317568305, confirmed in both logs).

## GC — 107k aged rows (50k messages, 40k console_events, 5k tasks >30d,
## 5k security_events, 5k agent_memory, 2k stuck submitted, 100 unclaimed)

| Go (`daemons -once`) | TS (`runGc`) |
|---|---|
| ≈3,971 ms (4,029 wall − 58 empty-pass overhead) | 4,199 ms internal (4,536 wall) |

Identical effect, verified in SQL after each run: 30 fresh messages
remain, stuck tasks canceled (2,000), unclaimed purged (100),
`conversations.message_count` mismatches = **0** after both.

**Finding (TS telemetry bug):** TS reported `tasks_stuck_canceled: 0`
while actually canceling 2,000. postgres.js results expose `.count`, not
`.rowCount`; `gc.ts` reads `(x as any).rowCount ?? 0`. Probed directly:
UPDATE result `.rowCount === undefined`, `.count === 3`. The same
pattern in `outcomeLedger.ts` makes its logged `materialized` /
`verdict_backfilled` always 0 (below), and `unclaimed_purged` silently
falls back to the ≤1000-row probe count. The jobs' DB effects are
correct; two of their reported numbers are fiction.

## Outcome ledger — 20k terminal tasks (100 with valid runId, 100 malformed)

| Go | TS |
|---|---|
| ≈550 ms (607 wall incl. no-op GC pass) | 519 ms internal (644 wall) |

Identical outcome, verified in SQL: 20,000 `task_outcomes`, exactly 100
with `source_run_id` set, `latency_ms` correct on all rows. TS logged
`materialized: 0` — the `.rowCount` bug above; the materialization
itself was complete.

## Known deltas (Go spike vs TS gateway)

- Go edge does **no DB lookup on connect**: no paused (4003), unclaimed
  (4005) or visit (4008) checks, no backlog replay, no DB status writes,
  no `agent_joined` / console status broadcasts on connect. Its connect
  path is Redis-only, which is exactly why it has no registration lag.
- Ack in Go = log + early-ack Redis stash only; it does not advance
  `conversation_participants.lastDeliveredAt` or set `mentions.ackedAt`.
- Tick scheduler dispatches intents (`verse:tick-intents` stream) only;
  the tick body stays TypeScript product logic by design.
