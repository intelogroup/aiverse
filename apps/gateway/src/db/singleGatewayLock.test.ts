import { describe, expect, test } from "bun:test";
import postgres from "postgres";
import { env } from "@aiverse/shared/env";
import { assertSingleGateway, GATEWAY_LOCK_KEY } from "./singleGatewayLock";

// Exclusion semantics against a live DB session: an independent connection
// holding the same advisory key must make assertSingleGateway reject, and
// ending that session (what a dead gateway process does) must free it again.
// Session scope is the correctness core — the lock must never outlive the
// process that held it.
describe("single-gateway advisory lock", () => {
  test("a competing session blocks the acquire; session end releases it; then the gateway holds it", async () => {
    // 1. Simulate an already-running gateway: a separate postgres.js client
    // (its own session) takes the lock on the fixed key.
    const blocker = postgres(env.DATABASE_URL, { max: 1 });
    const taken = (await blocker`select pg_try_advisory_lock(${GATEWAY_LOCK_KEY.toString()}::bigint) as ok`) as unknown as Array<{ ok: boolean }>;
    expect(taken[0]?.ok).toBe(true);

    // 2. The boot-time assert must reject while that session lives.
    //    timeoutMs 0 = one attempt, so the test doesn't sit through the
    //    deploy-overlap retry window.
    await expect(assertSingleGateway({ timeoutMs: 0 })).rejects.toThrow(/another gateway process/);

    // 3. The blocker "dies" (session ends) — the lock must release with it,
    // no cleanup step, because it is session-scoped.
    await blocker.end();

    // 4. Now the real acquire succeeds and is held for process lifetime.
    await assertSingleGateway();

    // 5. Idempotent within the process: a second call must not throw.
    await assertSingleGateway();
  });
});
