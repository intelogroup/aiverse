import postgres from "postgres";
import { env } from "@aiverse/shared/env";
import { log } from "../util/log";

// Held on the DIRECT (unpooled) connection, never the pooler: the lock is
// session-scoped, and a transaction-mode PgBouncer recycles backends freely —
// the "session" holding the lock can silently vanish under the gateway's
// feet, releasing the lock while the process still runs (exactly the
// double-gateway window this lock exists to close). DATABASE_URL_DIRECT
// falls back to DATABASE_URL until a pooled URL is in use.

// AGENTS.md rule 14 (original form): exactly one gateway process may serve a
// verse — enforced by making boot fail loud on a second process. That existed
// because WS delivery (ws/gateway.ts sendToAgent/broadcast) used to write
// straight into a local, per-process socket Map: two gateways would each
// only see their own half of connected agents and silently split the world.
//
// 2026-09-14: WS delivery moved onto Redis pub/sub fanout (every instance
// publishes; every instance's own subscriber delivers to whichever sockets
// it actually holds), so serving HTTP/WS from multiple processes is correct
// now. What still must run exactly once is the set of singleton background
// jobs (native-agent ticks, GC, the outcome ledger) — two processes both
// ticking the same native double-acts it and double-spends its wallet. So
// this lock's job changed from "refuse to boot a second gateway" to "elect
// which one process runs the singleton jobs" — every process still serves
// traffic, only the leader also runs scheduleNativeAgents/scheduleGc/etc.
//
// Session scope is the whole point — the lock dies with the process's DB
// session, so a crashed or killed gateway releases it automatically. No
// stale lock files, no manual cleanup, no lock row to vacuum, and on a
// watch-mode restart or a leader dying, some other live process picks it up
// on its next attempt (index.ts retries this periodically, not just at boot).
//
// Held on a dedicated one-connection client, never used for queries and
// never closed for the process lifetime: pooled query connections come and
// go, but this one session owns the lock for as long as this process is
// leader. Costs exactly one connection outside the main pool.
export const GATEWAY_LOCK_KEY = 0x6169766572736531n; // "aiverse1" ASCII, < 2^63

let lockConnection: ReturnType<typeof postgres> | undefined;

// Non-throwing: returns whether THIS process is (now) the singleton-job
// leader. false is a normal outcome (another process already leads), not an
// error — callers should still serve HTTP/WS either way, and only gate the
// singleton jobs on the return value.
export async function tryBecomeGatewayLeader(opts: { timeoutMs?: number } = {}): Promise<boolean> {
  // Idempotent within a process: already holding it, no need to re-attempt.
  if (lockConnection) return true;

  // Bounded retry, not an instant single try: a Render deploy stops the old
  // leader and starts a new process, and the old one's DB session can take a
  // few seconds to actually die — retrying here lets the new process pick up
  // leadership promptly instead of just concluding "someone else leads" while
  // that someone is actually mid-shutdown. timeoutMs: 0 = exactly one attempt
  // (tests). This is a boot-time election only — no live failover once a
  // process starts running as a non-leader; a future need for that is a
  // separate change (index.ts would periodically retry tryBecomeGatewayLeader).
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;

  const conn = postgres(env.DATABASE_URL_DIRECT, { max: 1 });
  for (;;) {
    // The key travels as text and PG casts to bigint — exact for values above
    // 2^53 where a JS number parameter would silently round, and it satisfies
    // postgres.js's parameter typing (bigint params aren't accepted).
    const rows = (await conn`select pg_try_advisory_lock(${GATEWAY_LOCK_KEY.toString()}::bigint) as ok`) as unknown as Array<{ ok: boolean }>;
    if (rows[0]?.ok) {
      lockConnection = conn;
      log("gateway_leader_acquired", { key: GATEWAY_LOCK_KEY.toString() });
      return true;
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await conn.end();
  return false;
}
