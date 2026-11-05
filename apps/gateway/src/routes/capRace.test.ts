import { describe, expect, test, beforeAll } from "bun:test";
import { createApp } from "../app";
import { websocket } from "../ws/gateway";
import { db } from "../db/client";
import { and, eq, isNull, sql } from "drizzle-orm";
import { agents, onboardingQuestions, ownerReadKeys } from "@aiverse/shared/schema";
import { ensureRoomsSeeded } from "../db/seed";
import { resetMemoryStoreForTests } from "../policy/memoryStore";

// Aggregate-cap race regression suite (cap-race fix lane, 2026-11-05).
//
// Five caps were enforced as count-then-insert with no serialization, so
// a concurrent burst overshot every one while sequential controls stayed
// exact (loop cards AIV-VERSE-CAP-RACE-001, AIV-OWNER-AGENT-CAP-RACE-001,
// AIV-A2A-INBOX-CAP-RACE-001, AIV-ONBOARDING-CAP-RACE-001,
// AIV-READKEYS-CAP-RACE-001). The fix is one shared discipline —
// db/capLock.ts: recount + insert inside a transaction holding a
// per-scope pg_advisory_xact_lock. Each surface below gets a sequential
// control AND a burst at width 32: burst width is a variable, and an
// 8-way pass proved nothing for two of these surfaces in the loop.
const app = createApp();
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });

beforeAll(async () => {
  await ensureRoomsSeeded();
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
function json(token?: string) {
  return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}
function rowsOf(r: unknown): any[] {
  return ((r as any).rows ?? r) as any[];
}

async function makeOwner(prefix: string) {
  const email = `${prefix}-${uniq()}@example.com`;
  const reg = await app.request("/owners/register", {
    method: "POST",
    headers: json(),
    body: JSON.stringify({ email, password: "password123", displayName: "Cap Tester" }),
  });
  expect(reg.status).toBe(201);
  const { token, owner } = await reg.json();
  return { ownerToken: token as string, ownerId: owner.id as string };
}

async function makeAgent(ownerToken: string, name: string) {
  const created = await app.request("/owners/agents", {
    method: "POST",
    headers: json(ownerToken),
    body: JSON.stringify({ name, capabilities: [] }),
  });
  expect(created.status).toBe(201);
  const { agentToken, agent } = await created.json();
  return { agentToken: agentToken as string, agentId: agent.id as string };
}

// ---------------------------------------------------------------- read keys
describe("cap race: owner read keys (max 10 active)", () => {
  async function createKey(token: string, label: string) {
    return app.request("/owners/read-keys", { method: "POST", headers: json(token), body: JSON.stringify({ label }) });
  }
  async function activeCount(ownerId: string) {
    const found = await db.query.ownerReadKeys.findMany({
      where: and(eq(ownerReadKeys.ownerId, ownerId), isNull(ownerReadKeys.revokedAt)),
    });
    return found.length;
  }

  test("control: sequential creation admits exactly 10, 11th refused 409", async () => {
    await resetMemoryStoreForTests();
    const { ownerToken, ownerId } = await makeOwner("rk-seq");
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await createKey(ownerToken, `seq-${i}-${uniq()}`)).status);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(201));
    expect(statuses[10]).toBe(409);
    expect(await activeCount(ownerId)).toBe(10);
  }, 60000);

  test("burst: 32 concurrent creations at 9 existing admit exactly 1", async () => {
    await resetMemoryStoreForTests();
    const { ownerToken, ownerId } = await makeOwner("rk-burst");
    for (let i = 0; i < 9; i++) expect((await createKey(ownerToken, `seed-${i}-${uniq()}`)).status).toBe(201);
    const results = await Promise.all(Array.from({ length: 32 }, (_, i) => createKey(ownerToken, `burst-${i}-${uniq()}`)));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201).length).toBe(1);
    expect(statuses.filter((s) => s === 409).length).toBe(31);
    expect(await activeCount(ownerId)).toBe(10);
  }, 60000);
});

// ------------------------------------------------------------- owner agents
describe("cap race: owner agent creation (max 100/owner)", () => {
  async function createAgent(ownerToken: string, prefix: string) {
    return app.request("/owners/agents", {
      method: "POST",
      headers: json(ownerToken),
      body: JSON.stringify({ name: `${prefix}-${uniq()}`, capabilities: [] }),
    });
  }
  async function agentCount(ownerId: string) {
    const found = await db.query.agents.findMany({ where: eq(agents.ownerId, ownerId), columns: { id: true } });
    return found.length;
  }

  test("control: sequential creation admits exactly 100, 101st refused 429", async () => {
    await resetMemoryStoreForTests();
    const { ownerToken, ownerId } = await makeOwner("ag-seq");
    for (let i = 0; i < 100; i++) expect((await createAgent(ownerToken, "seq")).status).toBe(201);
    expect((await createAgent(ownerToken, "seq-over")).status).toBe(429);
    expect(await agentCount(ownerId)).toBe(100);
  }, 180000);

  test("burst: 32 concurrent creations at 99 existing admit exactly 1", async () => {
    await resetMemoryStoreForTests();
    const { ownerToken, ownerId } = await makeOwner("ag-burst");
    for (let i = 0; i < 99; i++) expect((await createAgent(ownerToken, "fill")).status).toBe(201);
    const results = await Promise.all(Array.from({ length: 32 }, () => createAgent(ownerToken, "burst")));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201).length).toBe(1);
    expect(statuses.filter((s) => s === 429).length).toBe(31);
    expect(await agentCount(ownerId)).toBe(100);
  }, 180000);
});

// ------------------------------------------------------------------- verse
describe("cap race: verse per-owner presence (max 10 joined)", () => {
  async function verseJoinedCount(agentIds: string[]): Promise<number> {
    const conv = rowsOf(await db.execute(sql`SELECT id FROM conversations WHERE room_id = (SELECT id FROM rooms WHERE slug='verse') LIMIT 1`));
    if (!conv.length) return -1;
    const cid = conv[0].id;
    const rr = rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM conversation_participants WHERE conversation_id = ${cid}::uuid AND agent_id = ANY(${sql.raw(`ARRAY[${agentIds.map((id) => `'${id}'::uuid`).join(",")}]`)})`));
    return Number(rr[0].n);
  }
  async function makeAgents(ownerToken: string, prefix: string, n: number) {
    const out: { agentToken: string; agentId: string }[] = [];
    for (let i = 0; i < n; i++) out.push(await makeAgent(ownerToken, `${prefix}${i}-${uniq()}`));
    return out;
  }
  function join(agentToken: string) {
    return app.request("/rooms/verse/join", { method: "POST", headers: { authorization: `Bearer ${agentToken}` } });
  }

  test("control: sequential joins admit exactly 10, 11th refused 429", async () => {
    await resetMemoryStoreForTests();
    const { ownerToken } = await makeOwner("verse-seq");
    const agents = await makeAgents(ownerToken, "seq", 11);
    const statuses: number[] = [];
    for (const a of agents) statuses.push((await join(a.agentToken)).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(await verseJoinedCount(agents.map((a) => a.agentId))).toBe(10);
  }, 120000);

  test("burst: 32 concurrent joins by distinct agents of one owner admit exactly 10", async () => {
    await resetMemoryStoreForTests();
    const { ownerToken } = await makeOwner("verse-burst");
    const agents = await makeAgents(ownerToken, "burst", 32);
    const results = await Promise.all(agents.map((a) => join(a.agentToken)));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 200).length).toBe(10);
    expect(statuses.filter((s) => s === 429).length).toBe(22);
    expect(await verseJoinedCount(agents.map((a) => a.agentId))).toBe(10);
  }, 120000);
});

// -------------------------------------------------------------- onboarding
describe("cap race: onboarding open questions (max 5/agent)", () => {
  async function postQuestion(agentToken: string, q: string) {
    return app.request("/onboarding/questions", {
      method: "POST",
      headers: json(agentToken),
      body: JSON.stringify({ question: q, allowFreeText: true }),
    });
  }
  async function openCount(agentId: string) {
    const found = await db.query.onboardingQuestions.findMany({
      where: and(eq(onboardingQuestions.agentId, agentId), eq(onboardingQuestions.status, "open")),
    });
    return found.length;
  }

  test("control: sequential asks admit exactly 5, 6th refused 409", async () => {
    await resetMemoryStoreForTests();
    const { ownerToken } = await makeOwner("onb-seq");
    const { agentToken, agentId } = await makeAgent(ownerToken, `onb-seq-${uniq()}`);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await postQuestion(agentToken, `Control question number ${i}?`)).status);
    expect(statuses.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
    expect(statuses[5]).toBe(409);
    expect(await openCount(agentId)).toBe(5);
  }, 60000);

  test("burst: 32 concurrent asks at 4 open admit exactly 1", async () => {
    await resetMemoryStoreForTests();
    const { ownerToken } = await makeOwner("onb-burst");
    const { agentToken, agentId } = await makeAgent(ownerToken, `onb-burst-${uniq()}`);
    for (let i = 0; i < 4; i++) expect((await postQuestion(agentToken, `Seed question number ${i}?`)).status).toBe(201);
    const results = await Promise.all(
      Array.from({ length: 32 }, (_, i) => postQuestion(agentToken, `Burst question number ${i}?`)),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201).length).toBe(1);
    expect(statuses.filter((s) => s === 409).length).toBe(31);
    expect(await openCount(agentId)).toBe(5);
  }, 60000);
});

// --------------------------------------------------------------------- a2a
describe("cap race: A2A target inbox (max 100 pending)", () => {
  async function registerCaller(prefix: string) {
    const { ownerToken } = await makeOwner(prefix);
    const a = await makeAgent(ownerToken, `${prefix}-${uniq()}`);
    const patched = await app.request(`/owners/agents/${a.agentId}/wallet`, {
      method: "PATCH",
      headers: json(ownerToken),
      body: JSON.stringify({ autonomyMode: "autonomous" }),
    });
    expect(patched.status).toBe(200);
    return a;
  }
  async function makeTargetAt99(prefix: string) {
    const target = await registerCaller(`${prefix}-target`);
    for (let i = 0; i < 99; i++) {
      await db.execute(sql`INSERT INTO a2a_tasks (target_agent_id, caller_agent_id, state, request_message) VALUES (${target.agentId}::uuid, ${target.agentId}::uuid, 'submitted', '{}'::jsonb)`);
    }
    expect(await pendingCount(target.agentId)).toBe(99);
    return target;
  }
  async function pendingCount(targetId: string): Promise<number> {
    const cnt = rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM a2a_tasks WHERE target_agent_id = ${targetId}::uuid AND state IN ('submitted','working')`));
    return Number(cnt[0].n);
  }
  async function send(callerToken: string, targetId: string, contextId?: string) {
    const res = await app.request(`/a2a/agents/${targetId}`, {
      method: "POST",
      headers: json(callerToken),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          ...(contextId ? { contextId } : {}),
          message: { role: "user", parts: [{ kind: "text", text: "do a thing" }], messageId: `m-${uniq()}` },
        },
      }),
    });
    const body: any = await res.json().catch(() => ({}));
    return { status: res.status, code: body?.error?.code ?? null, hasResult: !!body?.result };
  }

  test("control: at 99 pending, one send admitted, the next refused -32015", async () => {
    await resetMemoryStoreForTests();
    const target = await makeTargetAt99("inbox-seq");
    const caller = await registerCaller("inbox-seq-caller");
    const first = await send(caller.agentToken, target.agentId);
    expect(first.hasResult).toBe(true);
    expect(await pendingCount(target.agentId)).toBe(100);
    const second = await send(caller.agentToken, target.agentId);
    expect(second.hasResult).toBe(false);
    expect(second.code).toBe(-32015);
    expect(await pendingCount(target.agentId)).toBe(100);
  }, 120000);

  test("burst: 32 concurrent sends from distinct callers at 99 pending admit exactly 1", async () => {
    await resetMemoryStoreForTests();
    const target = await makeTargetAt99("inbox-burst");
    const callers: { agentToken: string }[] = [];
    for (let i = 0; i < 32; i++) callers.push(await registerCaller(`inbox-burst-c${i}`));
    const results = await Promise.all(callers.map((c) => send(c.agentToken, target.agentId)));
    expect(results.filter((r) => r.hasResult).length).toBe(1);
    expect(results.filter((r) => r.code === -32015).length).toBe(31);
    expect(await pendingCount(target.agentId)).toBe(100);
  }, 180000);

  test("burst (goal-scoped): 32 concurrent sends with distinct contextIds at 99 pending admit exactly 1", async () => {
    await resetMemoryStoreForTests();
    const target = await makeTargetAt99("inbox-goal");
    const callers: { agentToken: string }[] = [];
    for (let i = 0; i < 32; i++) callers.push(await registerCaller(`inbox-goal-c${i}`));
    const results = await Promise.all(callers.map((c) => send(c.agentToken, target.agentId, crypto.randomUUID())));
    expect(results.filter((r) => r.hasResult).length).toBe(1);
    expect(results.filter((r) => r.code === -32015).length).toBe(31);
    expect(await pendingCount(target.agentId)).toBe(100);
  }, 180000);
});
