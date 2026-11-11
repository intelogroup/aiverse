import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import postgres from "postgres";
import { env } from "@aiverse/shared/env";
import { createApp } from "./app";
import { redis } from "./redis/client";
import { GATEWAY_LOCK_KEY } from "./db/singleGatewayLock";
import { INGEST_STREAM, INGEST_GROUP } from "./jobs/ingestConsumer";

// WI-5 (PHASE1_SPEC): serving-first follower boot. These are process-level
// tests — the behavior under test is WHEN the real entrypoint (src/index.ts)
// starts serving relative to the leader election, so the gateway is spawned
// as an actual child process rather than imported (importing index.ts would
// also run its boot in this test process). The incumbent "leader" is a raw
// Postgres session holding the advisory lock, the same simulation
// singleGatewayLock.test.ts uses.
//
// Singleton-job observability: startSingletonJobs starts every leader-only
// job together, behind one guard. The ingest consumer is the canary — when
// scheduled, its first pass creates the verse:ingest consumer group in
// Redis and logs ingest_consumer_started. The log line can only come from
// the child process, so its absence proves no singleton job started and
// its presence proves they did. (The consumer NAME `gateway-<pid>` only
// registers in XINFO after a delivered read, so it is not a usable
// signal on an idle stream — see test (b).)

const CHILD_PORT = 4571;
const CHILD_BASE = `http://127.0.0.1:${CHILD_PORT}`;
const GATEWAY_ROOT = join(import.meta.dir, "..");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(probe: () => Promise<T | null> | T | null, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await probe();
    if (hit !== null) return hit;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(50);
  }
}

// Explicit child env (never inherited wholesale — a stray parent var must
// not leak into the child's boot). Values are the suite's own parsed env,
// so the child runs against the same isolated test DB/Redis. Natives are
// disabled so the post-failover job start stays side-effect-light, and the
// leader-check interval is shrunk so failover cadence is test-scale.
function childEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: "test",
    DATABASE_URL: env.DATABASE_URL,
    DATABASE_URL_DIRECT: env.DATABASE_URL_DIRECT,
    REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
    JWT_SECRET: env.JWT_SECRET,
    NATIVE_LLM_MODE: "mock",
    PORT: String(CHILD_PORT),
    AIVERSE_LEADER_CHECK_MS: "250",
    AIVERSE_DISABLE_NATIVES: "1",
  };
}

async function ingestGroupExists(): Promise<boolean> {
  try {
    const res = (await (redis as any).call("XINFO", "GROUPS", INGEST_STREAM)) as unknown[][];
    return res.some((entry) => {
      const i = entry.indexOf("name");
      return i >= 0 && String(entry[i + 1]) === INGEST_GROUP;
    });
  } catch {
    return false; // stream doesn't exist yet — no group either
  }
}

async function ingestConsumerNames(): Promise<string[]> {
  try {
    const res = (await (redis as any).call("XINFO", "CONSUMERS", INGEST_STREAM, INGEST_GROUP)) as unknown[][];
    return res.map((entry) => {
      const i = entry.indexOf("name");
      return i >= 0 ? String(entry[i + 1]) : "";
    });
  } catch {
    return []; // NOGROUP: stream/group don't exist yet — no consumers at all
  }
}

// Wall-clock budgets in this file measure a REAL child process booting
// against a held lock. PHASE1_SPEC's 2s figure is the quiet-machine
// design target; the pathology these tests guard against is serving
// waiting on the boot election (~30s of lock retry). On shared CI
// hardware (~1.5 shared CPUs for the whole suite) a cold child boot
// alone can exceed 2s, so the asserted budget is 20s: still well
// inside the election window, so a serve-after-election regression
// fails, while ordinary contention no longer flakes the suite
// (reproduced on pristine main: (a) failed at 2049ms, (b) at the
// 10s wait, on a loaded box whose child was healthy).
const BOOT_BUDGET_MS = 20_000;

describe("serving-first follower boot (PHASE1_SPEC WI-5)", () => {
  let blocker: ReturnType<typeof postgres> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let childOut = "";
  let childErr = "";
  let probeAgentId = "";

  beforeAll(async () => {
    // One real agent row for the WS-connect probe, created through the API
    // in-process (same pattern as ws/registerFirst.test.ts). The ticket
    // itself is seeded straight into Redis in test (a), moments before the
    // connect, in the exact shape the gateway redeems via GETDEL.
    const app = createApp();
    const email = `boot-probe-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const reg = await app.request("/owners/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    });
    const { token } = await reg.json();
    const created = await app.request("/owners/agents", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: `BootProbe-${Date.now()}`, capabilities: [] }),
    });
    if (created.status !== 201) {
      throw new Error(`probe agent create failed: ${created.status} ${await created.text()}`);
    }
    probeAgentId = ((await created.json()) as any).agent.id as string;
  });

  afterAll(async () => {
    // The child may be leader by now: killing it ends its DB session,
    // which is what releases the advisory lock for the rest of the suite.
    if (child) {
      child.kill();
      const exited = await Promise.race([child.exited, sleep(3000).then(() => null)]);
      if (exited === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      child = undefined;
    }
    if (blocker) {
      await blocker.end();
      blocker = undefined;
    }
  });

  test("(a) lock held by another process: child serves /health and WS well inside the election window, starts no singleton job", async () => {
    // Incumbent leader: an independent session holding the lock. Session
    // scope is the point — it holds until this client ends.
    blocker = postgres(env.DATABASE_URL_DIRECT, { max: 1 });
    const taken = (await blocker`select pg_try_advisory_lock(${GATEWAY_LOCK_KEY.toString()}::bigint) as ok`) as unknown as Array<{ ok: boolean }>;
    expect(taken[0]?.ok).toBe(true);

    const ticket = crypto.randomUUID();
    await redis.set(`wsticket:agent:${ticket}`, probeAgentId, "EX", 60);

    const spawnedAt = Date.now();
    child = Bun.spawn([process.execPath, "src/index.ts"], {
      cwd: GATEWAY_ROOT,
      env: childEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const drain = async (stream: ReadableStream<Uint8Array>, push: (s: string) => void) => {
      const reader = stream.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        push(dec.decode(value, { stream: true }));
      }
    };
    void drain(child.stdout as ReadableStream<Uint8Array>, (s) => { childOut += s; });
    void drain(child.stderr as ReadableStream<Uint8Array>, (s) => { childErr += s; });

    // /health answers long before the election could complete — before
    // WI-5 this took the election's full ~30s deploy-overlap retry,
    // because the export (and therefore serving) waited on the boot
    // election. (Budget: BOOT_BUDGET_MS, see the note above.)
    const health = await waitFor(async () => {
      try {
        const r = await fetch(`${CHILD_BASE}/health`);
        return r.status === 200 ? r : null;
      } catch {
        return null;
      }
    }, BOOT_BUDGET_MS, "child /health 200");
    expect(Date.now() - spawnedAt).toBeLessThan(BOOT_BUDGET_MS);
    expect(((await health.json()) as any).status).toBe("ok");

    // WS connects are accepted within the same budget: the socket opens
    // and the gateway's own agent_connected frame comes back.
    const frames: any[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${CHILD_PORT}/agents/ws?ticket=${ticket}`);
    ws.onmessage = (msg) => {
      try {
        frames.push(JSON.parse(String(msg.data)));
      } catch {
        // non-JSON frame — not expected on this socket; ignore
      }
    };
    await waitFor(
      () => frames.find((f) => f.type === "agent_connected") ?? null,
      Math.max(1, BOOT_BUDGET_MS - (Date.now() - spawnedAt)),
      "agent_connected frame",
    );
    expect(Date.now() - spawnedAt).toBeLessThan(BOOT_BUDGET_MS);
    ws.close();

    // No singleton job may have started: the child is a follower (its boot
    // election is still inside the retry window against the held lock).
    // Settle briefly so a wrongly-eager job start would have registered.
    await sleep(500);
    expect(childOut).not.toContain("gateway_leader_acquired");
    expect(childOut).not.toContain("ingest_consumer_started");
    expect(await ingestConsumerNames()).not.toContain(`gateway-${child.pid}`);
  }, 45_000);

  test("(b) incumbent dies: the follower acquires the lock and starts the singleton jobs", async () => {
    if (!child) throw new Error("child gateway not running (test (a) must pass first)");
    if (!blocker) throw new Error("incumbent blocker not held (test (a) must pass first)");

    // Incumbent death = its DB session ends; the session-scoped lock
    // releases with it, no cleanup step. The child's still-running boot
    // election (1s retry inside tryBecomeGatewayLeader) acquires within
    // ~a second — and had the 30s boot window already closed, the 250ms
    // follower retry started by index.ts would land the same
    // startSingletonJobs call; the job-start path is shared, and the
    // lock-level failover mechanics are covered by singleGatewayLock.test.ts.
    await blocker.end();
    blocker = undefined;

    // The failover proof is the child's own log lines (only the child
    // writes to childOut), corroborated by the consumer GROUP existing
    // in Redis. An earlier version waited for the child's consumer NAME
    // in XINFO CONSUMERS — but a consumer only registers there after
    // its first DELIVERED read (an empty XREADGROUP creates nothing;
    // verified against Redis 7.0), so that wait could only ever pass
    // when unrelated stream traffic happened to flow, and never on an
    // idle stream. That, not boot speed, was this test's flake.
    await waitFor(() => (childOut.includes("ingest_consumer_started") ? true : null), 30_000, "ingest_consumer_started log");
    expect(childOut).toContain("gateway_leader_acquired");
    expect(await ingestGroupExists()).toBe(true);
    expect(childErr).not.toContain("gateway_boot_error");
  }, 60_000);
});
