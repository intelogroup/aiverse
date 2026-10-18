import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { websocket } from "../ws/gateway";
import { ensureRoomsSeeded } from "../db/seed";
import { db } from "../db/client";
import { conversationParticipants } from "@aiverse/shared/schema";
import { redis } from "../redis/client";
import { resetMemoryStoreForTests, getDailyCounter, takeTokens } from "../policy/memoryStore";
import { todayUTC } from "../policy/gate";

// PHASE1_SPEC WI-1 — per-room fanout budget + publish-limit pricing.
// The knobs are read at call time (WI-4 pattern), so tests pin them via
// process.env and clear them in afterEach — bun runs every file in one
// process and a leaked capacity would silently throttle later suites.

const app = createApp();
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });

const KNOBS = [
  "AIVERSE_FANOUT_BUDGET_CAPACITY",
  "AIVERSE_FANOUT_BUDGET_REFILL_PER_SEC",
  "AIVERSE_FANOUT_BUDGET_GROUP_MIN_PARTICIPANTS",
];

afterAll(() => {
  server.stop(true);
});

afterEach(() => {
  for (const k of KNOBS) delete process.env[k];
});

beforeAll(async () => {
  await ensureRoomsSeeded();
});

function uniqueName(base: string): string {
  return `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function registerAgentWithId(name: string): Promise<{ token: string; agentId: string }> {
  const email = `fanout-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const { token: ownerToken } = await reg.json();
  const created = await app.request("/owners/agents", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ name, capabilities: [] }),
  });
  const { agentToken, agent } = await created.json();
  // Default wallet autonomy is "observe" (blocks sends before the fanout
  // gate is even reached) — promote, as the other messaging suites do.
  await app.request(`/owners/agents/${agent.id}/wallet`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ autonomyMode: "autonomous" }),
  });
  return { token: agentToken as string, agentId: agent.id as string };
}

async function joinGeneral(token: string): Promise<string> {
  const res = await app.request("/rooms/general/join", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(200);
  const { conversationId } = await res.json();
  return conversationId as string;
}

async function audienceOf(conversationId: string, senderId: string): Promise<number> {
  const rows = await db.query.conversationParticipants.findMany({
    where: eq(conversationParticipants.conversationId, conversationId),
  });
  return rows.filter((r) => r.agentId !== senderId).length;
}

async function bucketTokens(conversationId: string): Promise<number | null> {
  const raw = await redis.hmget(`fanout:${conversationId}`, "tokens");
  return raw && raw[0] != null ? Number(raw[0]) : null;
}

async function postMessage(token: string, conversationId: string, body: Record<string, unknown>) {
  const res = await app.request(`/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function connectAgent(token: string): Promise<{ ws: WebSocket; frames: any[] }> {
  const issued = await app.request("/auth/ws-ticket", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(issued.status).toBe(201);
  const { ticket } = await issued.json();
  const ws = new WebSocket(`ws://localhost:${server.port}/agents/ws?ticket=${ticket}`);
  const frames: any[] = [];
  const connected = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for agent_connected")), 5000);
    ws.addEventListener("message", (msg) => {
      const event = JSON.parse(String(msg.data));
      frames.push(event);
      if (event.type === "agent_connected") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  await connected;
  return { ws, frames };
}

async function waitForFrames(frames: any[], pred: (f: any) => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (frames.some(pred)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("fanout budget (PHASE1_SPEC WI-1)", () => {
  test("(a) a room send whose audience exceeds the bucket is rejected 429, burns no agent budget, publishes nothing, and emits exactly one RATE_LIMITED frame", async () => {
    await resetMemoryStoreForTests();
    process.env.AIVERSE_FANOUT_BUDGET_CAPACITY = "3";
    process.env.AIVERSE_FANOUT_BUDGET_REFILL_PER_SEC = "0";

    const sender = await registerAgentWithId(uniqueName("FanoutSender"));
    const conversationId = await joinGeneral(sender.token);
    for (let i = 0; i < 4; i++) {
      const other = await registerAgentWithId(uniqueName(`FanoutPeer${i}`));
      await joinGeneral(other.token);
    }
    const audience = await audienceOf(conversationId, sender.agentId);
    expect(audience).toBeGreaterThanOrEqual(4); // charge >= 4 > capacity 3

    const { ws, frames } = await connectAgent(sender.token);
    expect(await redis.xlen("verse:ingest")).toBe(0);

    const res = await postMessage(sender.token, conversationId, {
      content: "this should never fan out",
      tokensUsed: 500,
    });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("fanout_budget_exceeded");

    // Ordering proof: the fanout gate sits before budget consumption, so
    // the rejected send consumed zero of the sender's daily token budget.
    expect(await getDailyCounter(`budget:${sender.agentId}:${todayUTC()}`)).toBe(0);
    // Nothing was published to the ingest stream.
    expect(await redis.xlen("verse:ingest")).toBe(0);

    // Exactly one RATE_LIMITED frame, carrying the fanout reason.
    await waitForFrames(frames, (f) => f.type === "rate_limited");
    await new Promise((r) => setTimeout(r, 400)); // grace window for a duplicate
    const limited = frames.filter((f) => f.type === "rate_limited");
    expect(limited).toHaveLength(1);
    expect(limited[0].payload.reason).toBe("fanout_budget_exceeded");
    ws.close();
  }, 20000);

  test("(b) a send that exactly fits the bucket succeeds and drains it by the audience size", async () => {
    await resetMemoryStoreForTests();
    const sender = await registerAgentWithId(uniqueName("FanoutExactSender"));
    const conversationId = await joinGeneral(sender.token);
    for (let i = 0; i < 2; i++) {
      const other = await registerAgentWithId(uniqueName(`FanoutExactPeer${i}`));
      await joinGeneral(other.token);
    }
    const audience = await audienceOf(conversationId, sender.agentId);
    // Capacity exactly equals the charge: the send fits, the bucket ends
    // at zero, and a second send has nothing left to pay with.
    process.env.AIVERSE_FANOUT_BUDGET_CAPACITY = String(audience);
    process.env.AIVERSE_FANOUT_BUDGET_REFILL_PER_SEC = "0";

    const res = await postMessage(sender.token, conversationId, { content: "exact fit" });
    expect(res.status).toBe(201);
    expect(await bucketTokens(conversationId)).toBe(0);

    const second = await postMessage(sender.token, conversationId, { content: "one too many" });
    expect(second.status).toBe(429);
    expect(second.body.error).toBe("fanout_budget_exceeded");
  }, 20000);

  test("(c) a clientMessageId retry of a successful send is not charged twice", async () => {
    await resetMemoryStoreForTests();
    const sender = await registerAgentWithId(uniqueName("FanoutRetrySender"));
    const conversationId = await joinGeneral(sender.token);
    const other = await registerAgentWithId(uniqueName("FanoutRetryPeer"));
    await joinGeneral(other.token);
    const audience = await audienceOf(conversationId, sender.agentId);

    process.env.AIVERSE_FANOUT_BUDGET_CAPACITY = "1000";
    process.env.AIVERSE_FANOUT_BUDGET_REFILL_PER_SEC = "0";

    const first = await postMessage(sender.token, conversationId, {
      content: "charge me once",
      clientMessageId: "wi1-retry-1",
    });
    expect(first.status).toBe(201);
    expect(await bucketTokens(conversationId)).toBe(1000 - audience);

    const retry = await postMessage(sender.token, conversationId, {
      content: "charge me once",
      clientMessageId: "wi1-retry-1",
    });
    expect(retry.status).toBe(200);
    expect(retry.body.message.id).toBe(first.body.message.id);
    expect(await bucketTokens(conversationId)).toBe(1000 - audience);
  }, 20000);

  test("(d) at default knobs a DM send is unaffected and charged a flat 1 token", async () => {
    await resetMemoryStoreForTests();
    // No knob env set: defaults (capacity 100_000) apply.
    const a = await registerAgentWithId(uniqueName("FanoutDmA"));
    const b = await registerAgentWithId(uniqueName("FanoutDmB"));
    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${a.token}` },
      body: JSON.stringify({ isPublic: false, participantIds: [b.agentId] }),
    });
    expect(createRes.status).toBe(201);
    const { conversation } = await createRes.json();

    const res = await postMessage(a.token, conversation.id, { content: "hello dm" });
    expect(res.status).toBe(201);
    // Stored bucket value is exact: refill is applied lazily at the next
    // take, so the post-take balance sits at capacity - 1.
    expect(await bucketTokens(conversation.id)).toBe(100_000 - 1);
  }, 20000);

  test("(d2) a group below the size threshold is also charged a flat 1 token, not its audience", async () => {
    await resetMemoryStoreForTests();
    const a = await registerAgentWithId(uniqueName("FanoutGroupA"));
    const b = await registerAgentWithId(uniqueName("FanoutGroupB"));
    const c = await registerAgentWithId(uniqueName("FanoutGroupC"));
    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${a.token}` },
      body: JSON.stringify({ isPublic: false, name: "wi1-small-group", participantIds: [b.agentId, c.agentId] }),
    });
    expect(createRes.status).toBe(201);
    const { conversation } = await createRes.json();

    const res = await postMessage(a.token, conversation.id, { content: "hello group" });
    expect(res.status).toBe(201);
    expect(await bucketTokens(conversation.id)).toBe(100_000 - 1);
  }, 20000);

  test("(e) capacity=inf disables the gate entirely — no bucket is even created", async () => {
    await resetMemoryStoreForTests();
    process.env.AIVERSE_FANOUT_BUDGET_CAPACITY = "inf";
    process.env.AIVERSE_FANOUT_BUDGET_REFILL_PER_SEC = "0";
    const sender = await registerAgentWithId(uniqueName("FanoutInfSender"));
    const conversationId = await joinGeneral(sender.token);
    for (let i = 0; i < 3; i++) {
      const other = await registerAgentWithId(uniqueName(`FanoutInfPeer${i}`));
      await joinGeneral(other.token);
    }
    const res = await postMessage(sender.token, conversationId, { content: "ungated" });
    expect(res.status).toBe(201);
    expect(await redis.exists(`fanout:${conversationId}`)).toBe(0);
  }, 20000);
});

describe("takeTokens (WI-1 multi-token bucket)", () => {
  test("takes n atomically; a failed take drains nothing", async () => {
    await resetMemoryStoreForTests();
    const key = "fanout:unit-test-key";
    expect(await takeTokens(key, 5, 10, 0)).toBe(true);
    expect(Number((await redis.hmget(key, "tokens"))[0])).toBe(5);
    expect(await takeTokens(key, 6, 10, 0)).toBe(false);
    expect(Number((await redis.hmget(key, "tokens"))[0])).toBe(5); // no partial drain
    expect(await takeTokens(key, 5, 10, 0)).toBe(true);
    expect(Number((await redis.hmget(key, "tokens"))[0])).toBe(0);
    await redis.del(key);
  });
});
