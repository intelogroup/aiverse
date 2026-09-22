import { describe, expect, test } from "bun:test";
import postgres from "postgres";
import { env } from "@aiverse/shared/env";
import { tryBecomeGatewayLeader, checkGatewayLeadership, releaseGatewayLeadershipForTests, GATEWAY_LOCK_KEY } from "./singleGatewayLock";

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

  // Live-failover watchdog: a dropped lock session must be detected even
  // though postgres.js silently reconnects (a `select 1` would still pass).
  test("leadership check: held → session killed → reacquired; killed and taken by another process → lost", async () => {
    await releaseGatewayLeadershipForTests();
    expect(await tryBecomeGatewayLeader({ timeoutMs: 0 })).toBe(true);
    expect(await checkGatewayLeadership()).toBe("held");

    const admin = postgres(env.DATABASE_URL_DIRECT, { max: 1 });
    // pg_locks is cluster-wide: scope to THIS database and THIS key, or the
    // test kills a local dev gateway's leader session in another database
    // (it did, 2026-09-22 — a bootstrap retest's gateway lost its lock
    // mid-run while this suite ran). Advisory bigint keys: classid = high
    // 32 bits, objid = low 32 bits.
    const hi = (GATEWAY_LOCK_KEY >> 32n).toString();
    const lo = (GATEWAY_LOCK_KEY & 0xffffffffn).toString();
    const killLockSession = async () => {
      await admin`
        select pg_terminate_backend(l.pid) from pg_locks l
        where l.locktype = 'advisory' and l.granted and l.pid <> pg_backend_pid()
          and l.database = (select oid from pg_database where datname = current_database())
          and l.classid = ${hi}::oid and l.objid = ${lo}::oid and l.objsubid = 1
      `;
      await new Promise((r) => setTimeout(r, 200));
    };
    // postgres.js may surface the dead socket once before reconnecting.
    const check = async () => {
      try {
        return await checkGatewayLeadership();
      } catch {
        return await checkGatewayLeadership();
      }
    };

    // Session dies, nobody else wants the lock: take it back.
    await killLockSession();
    expect(await check()).toBe("reacquired");
    expect(await checkGatewayLeadership()).toBe("held");

    // Session dies and a follower grabs the lock first: this process has lost it.
    await killLockSession();
    const follower = postgres(env.DATABASE_URL_DIRECT, { max: 1 });
    const taken = (await follower`select pg_try_advisory_lock(${GATEWAY_LOCK_KEY.toString()}::bigint) as ok`) as unknown as Array<{ ok: boolean }>;
    expect(taken[0]?.ok).toBe(true);
    expect(await check()).toBe("lost");

    await follower.end();
    await admin.end();
    await releaseGatewayLeadershipForTests();
  });
});
