import postgres from "postgres";
import { env } from "@aiverse/shared/env";
import { log } from "../util/log";

// Held on the DIRECT (unpooled) connection, never the pooler: the lock is
// session-scoped, and a transaction-mode PgBouncer recycles backends freely —
// the "session" holding the lock can silently vanish under the gateway's
// feet, releasing the lock while the process still runs (exactly the
// double-gateway window this lock exists to close). DATABASE_URL_DIRECT
// falls back to DATABASE_URL until a pooled URL is in use.

// AGENTS.md rule 14: exactly one gateway process may serve a verse. The old
// enforcement was operator discipline (pkill the old instance, then assert a
// single LISTEN on :3010). This makes Postgres itself the referee: a
// session-scoped advisory lock on a fixed key.
//
// Session scope is the whole point — the lock dies with the process's DB
// session, so a crashed or killed gateway releases it automatically. No
// stale lock files, no manual cleanup, no lock row to vacuum. On a watch-mode
// restart the old session closes as the old process dies, so the new process
// re-acquires.
//
// Held on a dedicated one-connection client, never used for queries and
// never closed for the process lifetime: pooled query connections come and
// go, but this one session owns the lock for as long as the gateway lives.
// Costs exactly one connection outside the main pool.
export const GATEWAY_LOCK_KEY = 0x6169766572736531n; // "aiverse1" ASCII, < 2^63

let lockConnection: ReturnType<typeof postgres> | undefined;

export async function assertSingleGateway(opts: { timeoutMs?: number } = {}): Promise<void> {
  // Idempotent within a process: a second call is a no-op, not an error —
  // the process already holds the lock through the same session.
  if (lockConnection) return;

  // Bounded retry, not instant exit: a Render deploy stops the old instance
  // and starts the new one, and the old process's DB session can take a few
  // seconds to actually die — an instant exit(1) there would fail otherwise
  // healthy deploys. 30s covers that overlap while still failing loud on a
  // genuine second gateway. timeoutMs: 0 = exactly one attempt (tests).
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
      log("single_gateway_lock_acquired", { key: GATEWAY_LOCK_KEY.toString() });
      return;
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await conn.end();
  throw new Error(
    "another gateway process already holds the single-gateway advisory lock (rule 14: exactly one gateway per verse) — stop the old instance before starting a new one",
  );
}
