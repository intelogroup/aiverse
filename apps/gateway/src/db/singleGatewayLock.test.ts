import { describe, expect, test } from "bun:test";
import postgres from "postgres";
import { env } from "@aiverse/shared/env";
import { tryBecomeGatewayLeader, GATEWAY_LOCK_KEY } from "./singleGatewayLock";

// Exclusion semantics against a live DB session: an independent connection
// holding the same advisory key must make tryBecomeGatewayLeader return
// false (not throw — losing the election is a normal outcome now, see
// singleGatewayLock.ts), and ending that session (what a dead leader process
// does) must free it again. Session scope is the correctness core — the lock
// must never outlive the process that held it.
describe("single-gateway advisory lock", () => {
  test("a competing session blocks the acquire; session end releases it; then this process becomes leader", async () => {
    // 1. Simulate an already-running leader: a separate postgres.js client
    // (its own session) takes the lock on the fixed key.
    const blocker = postgres(env.DATABASE_URL_DIRECT, { max: 1 });
    const taken = (await blocker`select pg_try_advisory_lock(${GATEWAY_LOCK_KEY.toString()}::bigint) as ok`) as unknown as Array<{ ok: boolean }>;
    expect(taken[0]?.ok).toBe(true);

    // 2. The boot-time attempt must fail to acquire while that session lives.
    //    timeoutMs 0 = one attempt, so the test doesn't sit through the
    //    deploy-overlap retry window.
    expect(await tryBecomeGatewayLeader({ timeoutMs: 0 })).toBe(false);

    // 3. The blocker "dies" (session ends) — the lock must release with it,
    // no cleanup step, because it is session-scoped.
    await blocker.end();

    // 4. Now the real acquire succeeds and is held for process lifetime.
    expect(await tryBecomeGatewayLeader()).toBe(true);

    // 5. Idempotent within the process: a second call stays true, no re-attempt.
    expect(await tryBecomeGatewayLeader()).toBe(true);
  });
});
