import { sql } from "drizzle-orm";
import { db } from "./client";

// Shared aggregate-cap discipline (cap-race fix lane, 2026-11-05).
//
// An aggregate cap ("at most N rows matching X") enforced as
// count-then-insert without serialization is racy: concurrent requests
// all read the same pre-insert count and all insert, overshooting the
// cap. Sequential controls stay exact, so the hole only shows under a
// wide concurrent burst (loop lesson: burst width is a variable — an
// 8-way pass proves nothing; the regression tests burst at 32).
//
// The discipline, mirroring the bazaar claim cap (routes/bazaar.ts) and
// the delegation admission cap (policy/gate.ts): run the count and the
// insert inside ONE transaction that first takes a transaction-scoped
// Postgres advisory lock keyed on the cap's scope (owner / agent /
// target). pg_advisory_xact_lock(hashtext(key)) serializes every
// contender for that scope; the lock releases automatically at commit
// or rollback, so a crashed request can never wedge the cap. Unrelated
// scopes hash to unrelated locks and never block each other.
//
// Callers re-check the count INSIDE the locked transaction and return a
// sentinel (not a throw) for the cap-full outcome, so the handler can
// answer with its usual refusal response.

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Take the cap lock inside an already-open transaction. */
export async function acquireCapLock(tx: Tx, lockKey: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
}

/** Open a transaction, take the cap lock for `lockKey`, then run `fn`. */
export async function withCapLock<T>(lockKey: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await acquireCapLock(tx, lockKey);
    return fn(tx);
  });
}
