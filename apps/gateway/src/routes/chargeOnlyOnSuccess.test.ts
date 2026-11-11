import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { agentVisits, a2aTasks, conversations, conversationParticipants, messages } from "@aiverse/shared/schema";
import { db } from "../db/client";
import { createApp } from "../app";
import { websocket } from "../ws/gateway";
import { ensureRoomsSeeded } from "../db/seed";
import { resetMemoryStoreForTests, takeToken, getDailyCounter } from "../policy/memoryStore";
import { todayUTC } from "../policy/gate";
import { drainIngestStream } from "../jobs/ingestConsumer";

// Charge only on success (2026-11-11, lanes A2+A3) — permanent versions of
// the adversarial-loop probes for seven cards that shared one discipline:
// a request a gate refuses must never consume a budget, a counter, or a
// quota; a cap must hold under concurrency, not just in sequence. The
// compensations differ per surface (refund primitives where consumption
// must precede the refusal for ordering reasons, consume-after-gates
// where it need not, a conditional UPDATE and a partial unique index for
// the visit caps), but the invariant is one: refused = uncharged, and a
// cap is a cap at any level of concurrency.
//
//   AIV-FANOUT-REFUSED-BURN-001      send path fanout bucket burned by the
//                                    budget / agent-rate / room-rate refusals
//   AIV-RATE-LIMIT-BUDGET-BURN-001   send path token budget burned by the
//                                    agent-rate / room-rate refusals
//   AIV-A2A-RATE-LIMIT-BUDGET-BURN-001  A2A message/send budget burned by
//                                    the -32012 rate refusal
//   AIV-CREATE-CALLS-BURN-001        create path agent-calls quota burned by
//                                    the trust / validation / DM-reuse exits
//   AIV-VISIT-REFUSED-BURN-001       visit action consumed by handler-refused
//                                    (400) requests
//   AIV-VISIT-ACTION-CAP-RACE-001    read-compare-increment visit cap
//                                    overshot under a concurrent burst
//   AIV-VISIT-START-RACE-001         check-then-insert visit start left
//                                    multiple active visits per agent

const app = createApp();
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
afterAll(() => {
  server.stop(true);
});
beforeAll(async () => {
  await ensureRoomsSeeded();
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
function json(token?: string) {
  return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function registerAgent(name: string, dailyTokenBudget?: number) {
  const email = `cos-${uniq()}@example.com`;
  const reg = await app.request("/owners/register", {
    method: "POST",
    headers: json(),
    body: JSON.stringify({ email, password: "password123" }),
  });
  expect(reg.status).toBe(201);
  const { token: ownerToken } = (await reg.json()) as any;
  const created = await app.request("/owners/agents", {
    method: "POST",
    headers: json(ownerToken),
    body: JSON.stringify({ name, capabilities: [] }),
  });
  expect(created.status).toBe(201);
  const { agentToken, agent } = (await created.json()) as any;
  await app.request(`/owners/agents/${agent.id}/wallet`, {
    method: "PATCH",
    headers: json(ownerToken),
    body: JSON.stringify({
      autonomyMode: "autonomous",
      ...(dailyTokenBudget !== undefined ? { dailyTokenBudget } : {}),
    }),
  });
  return { ownerToken: ownerToken as string, agentToken: agentToken as string, agentId: agent.id as string };
}

async function createGroup(senderToken: string, peerId: string, tag: string) {
  const res = await app.request("/conversations", {
    method: "POST",
    headers: json(senderToken),
    body: JSON.stringify({ isPublic: false, name: `${tag}-${uniq()}`, participantIds: [peerId] }),
  });
  expect(res.status).toBe(201);
  const { conversation } = (await res.json()) as any;
  return conversation.id as string;
}

const budgetOf = (agentId: string) => getDailyCounter(`budget:${agentId}:${todayUTC()}`);
const callsOf = (agentId: string) => getDailyCounter(`calls:${agentId}:${todayUTC()}`);

// ------------------------------------------------------------- fanout ---

describe("AIV-FANOUT-REFUSED-BURN-001 — a refused send charges no fanout budget", () => {
  test("agent-rate leg: a rate-limited 429 leaves the fanout bucket untouched", async () => {
    process.env.AIVERSE_FANOUT_BUDGET_CAPACITY = "2";
    process.env.AIVERSE_FANOUT_BUDGET_REFILL_PER_SEC = "0";
    try {
      await resetMemoryStoreForTests();
      const sender = await registerAgent(`CosFanRate-${uniq()}`);
      const peer = await registerAgent(`CosFanRatePeer-${uniq()}`);
      const conversationId = await createGroup(sender.agentToken, peer.agentId, "cos-fan-rate");
      const send = (cmid: string) =>
        app.request(`/conversations/${conversationId}/messages`, {
          method: "POST",
          headers: json(sender.agentToken),
          body: JSON.stringify({ content: "fanout rate leg", clientMessageId: cmid, tokensUsed: 100 }),
        });

      expect((await send(`cos-fr-1-${uniq()}`)).status).toBe(201);
      const second = await send(`cos-fr-2-${uniq()}`);
      expect(second.status).toBe(429);
      expect(((await second.json()) as any).error).toBe("agent_rate_limited");

      // Agent-rate bucket refills (1/sec); the fanout bucket cannot
      // (pinned 0/sec) — send 3 succeeds only if send 2 burned nothing.
      await sleep(1200);
      const thirdId = `cos-fr-3-${uniq()}`;
      expect((await send(thirdId)).status).toBe(201);

      await drainIngestStream();
      const thirdRows = await db.query.messages.findMany({
        where: and(eq(messages.conversationId, conversationId), eq(messages.clientMessageId, thirdId)),
      });
      expect(thirdRows.length).toBe(1);
    } finally {
      delete process.env.AIVERSE_FANOUT_BUDGET_CAPACITY;
      delete process.env.AIVERSE_FANOUT_BUDGET_REFILL_PER_SEC;
    }
  }, 30_000);

  test("budget leg: a budget_exceeded 429 leaves the fanout bucket untouched", async () => {
    process.env.AIVERSE_FANOUT_BUDGET_CAPACITY = "2";
    process.env.AIVERSE_FANOUT_BUDGET_REFILL_PER_SEC = "0";
    try {
      await resetMemoryStoreForTests();
      const sender = await registerAgent(`CosFanBudget-${uniq()}`, 150);
      const peer = await registerAgent(`CosFanBudgetPeer-${uniq()}`);
      const conversationId = await createGroup(sender.agentToken, peer.agentId, "cos-fan-budget");
      const send = (cmid: string, tokensUsed: number) =>
        app.request(`/conversations/${conversationId}/messages`, {
          method: "POST",
          headers: json(sender.agentToken),
          body: JSON.stringify({ content: "fanout budget leg", clientMessageId: cmid, tokensUsed }),
        });

      expect((await send(`cos-fb-1-${uniq()}`, 100)).status).toBe(201);
      await sleep(1200); // past the rate window: the budget is the only refusal in play
      const second = await send(`cos-fb-2-${uniq()}`, 100);
      expect(second.status).toBe(429);
      expect(((await second.json()) as any).error).toBe("budget_exceeded");

      await sleep(1200);
      // 10 fits the remaining 50 of budget — and the fanout bucket, if
      // send 2 left it alone.
      expect((await send(`cos-fb-3-${uniq()}`, 10)).status).toBe(201);
    } finally {
      delete process.env.AIVERSE_FANOUT_BUDGET_CAPACITY;
      delete process.env.AIVERSE_FANOUT_BUDGET_REFILL_PER_SEC;
    }
  }, 30_000);

  test("room-rate leg: a room_rate_limited 429 charges neither fanout nor token budget", async () => {
    try {
      await resetMemoryStoreForTests();
      const sender = await registerAgent(`CosFanRoom-${uniq()}`);
      const peer = await registerAgent(`CosFanRoomPeer-${uniq()}`);
      const join = async (token: string) => {
        const res = await app.request("/rooms/general/join", {
          method: "POST",
          headers: json(token),
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(200);
        return ((await res.json()) as any).conversationId as string;
      };
      const conversationId = await join(sender.agentToken);
      await join(peer.agentToken);

      const conv = await db.query.conversations.findFirst({ where: eq(conversations.id, conversationId) });
      const roomId = conv!.roomId as string;
      const parts = await db.query.conversationParticipants.findMany({
        where: eq(conversationParticipants.conversationId, conversationId),
      });
      const charge = Math.max(1, parts.filter((p) => p.agentId !== sender.agentId && p.mode === "active").length);
      // Exactly two charges in the bucket, no refill: send 1 takes one;
      // if the refused send 2 takes the other, send 3 is fanout-refused.
      process.env.AIVERSE_FANOUT_BUDGET_CAPACITY = String(2 * charge);
      process.env.AIVERSE_FANOUT_BUDGET_REFILL_PER_SEC = "0";

      const send = (cmid: string) =>
        app.request(`/conversations/${conversationId}/messages`, {
          method: "POST",
          headers: json(sender.agentToken),
          body: JSON.stringify({ content: "fanout room leg", clientMessageId: cmid, tokensUsed: 100 }),
        });

      expect((await send(`cos-frr-1-${uniq()}`)).status).toBe(201);

      // Drain the room bucket so the room-rate gate is send 2's refusal.
      for (let i = 0; i < 30; i++) {
        if (!(await takeToken(`room:${roomId}`, 20, 20 / 60))) break;
      }
      await sleep(1200); // clear the agent-rate window only

      const second = await send(`cos-frr-2-${uniq()}`);
      expect(second.status).toBe(429);
      expect(((await second.json()) as any).error).toBe("room_rate_limited");
      // The room leg of AIV-RATE-LIMIT-BUDGET-BURN-001: the token budget
      // counter also still shows only send 1's charge.
      expect(await budgetOf(sender.agentId)).toBe(100);

      await sleep(4500); // room bucket refills >= 1 (20/60 per sec)
      expect((await send(`cos-frr-3-${uniq()}`)).status).toBe(201);
    } finally {
      delete process.env.AIVERSE_FANOUT_BUDGET_CAPACITY;
      delete process.env.AIVERSE_FANOUT_BUDGET_REFILL_PER_SEC;
    }
  }, 40_000);
});

// ------------------------------------------------------ budget (send) ---

describe("AIV-RATE-LIMIT-BUDGET-BURN-001 — a rate-limited send charges no token budget", () => {
  test("agent-rate leg: 429 leaves the daily budget counter unchanged and publishes nothing", async () => {
    await resetMemoryStoreForTests();
    const sender = await registerAgent(`CosRateBudget-${uniq()}`);
    const peer = await registerAgent(`CosRateBudgetPeer-${uniq()}`);
    const conversationId = await createGroup(sender.agentToken, peer.agentId, "cos-rate-budget");
    const send = (cmid: string) =>
      app.request(`/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: json(sender.agentToken),
        body: JSON.stringify({ content: "rate budget leg", clientMessageId: cmid, tokensUsed: 100 }),
      });

    expect((await send(`cos-rb-1-${uniq()}`)).status).toBe(201);
    expect(await budgetOf(sender.agentId)).toBe(100);

    const secondId = `cos-rb-2-${uniq()}`;
    const second = await send(secondId); // immediately: inside the 1s rate window
    expect(second.status).toBe(429);
    expect(await budgetOf(sender.agentId)).toBe(100);

    await drainIngestStream();
    const rows = await db.query.messages.findMany({
      where: and(eq(messages.conversationId, conversationId), eq(messages.clientMessageId, secondId)),
    });
    expect(rows.length).toBe(0);
  }, 30_000);
});

// -------------------------------------------------------- budget (a2a) ---

describe("AIV-A2A-RATE-LIMIT-BUDGET-BURN-001 — a rate-limited A2A send charges no budget", () => {
  test("-32012 refusal leaves the caller's budget counter unchanged and creates no task", async () => {
    await resetMemoryStoreForTests();
    const target = await registerAgent(`CosA2aTarget-${uniq()}`);
    const caller = await registerAgent(`CosA2aCaller-${uniq()}`);
    const send = (messageId: string) =>
      app.request(`/a2a/agents/${target.agentId}`, {
        method: "POST",
        headers: json(caller.agentToken),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "message/send",
          params: { message: { role: "user", parts: [{ kind: "text", text: "do a thing" }], messageId, metadata: { tokensUsed: 100 } } },
        }),
      });

    const first = await send(`cos-a2a-1-${uniq()}`);
    expect(first.status).toBe(200);
    expect(await budgetOf(caller.agentId)).toBe(100);

    const second = await send(`cos-a2a-2-${uniq()}`); // immediately: rate-limited
    expect(second.status).toBe(429);
    expect(((await second.json()) as any)?.error?.code).toBe(-32012);
    expect(await budgetOf(caller.agentId)).toBe(100);

    const tasks = await db.query.a2aTasks.findMany({ where: eq(a2aTasks.callerAgentId, caller.agentId) });
    expect(tasks.length).toBe(1);
  }, 60_000);
});

// --------------------------------------------------------- create calls ---

describe("AIV-CREATE-CALLS-BURN-001 — a refused or reused creation consumes no agent-calls quota", () => {
  const create = (token: string, body: any) =>
    app.request("/conversations", { method: "POST", headers: json(token), body: JSON.stringify(body) });

  test("trust leg: a 403 (blocked by target) consumes nothing; a success consumes exactly 1", async () => {
    await resetMemoryStoreForTests();
    const caller = await registerAgent(`CosCallsTrust-${uniq()}`);
    const blocker = await registerAgent(`CosCallsBlocker-${uniq()}`);
    const stranger = await registerAgent(`CosCallsStranger-${uniq()}`);
    await app.request(`/owners/agents/${blocker.agentId}/policy`, {
      method: "PATCH",
      headers: json(blocker.ownerToken),
      body: JSON.stringify({ blockedAgentIds: [caller.agentId] }),
    });

    const refused = await create(caller.agentToken, { participantIds: [blocker.agentId], kind: "dm" });
    expect(refused.status).toBe(403);
    expect(await callsOf(caller.agentId)).toBe(0);

    const control = await create(caller.agentToken, { participantIds: [stranger.agentId], kind: "dm" });
    expect(control.status).toBe(201);
    expect(await callsOf(caller.agentId)).toBe(1);
  }, 60_000);

  test("validation leg: a 400 (kind room) consumes nothing; a success consumes exactly 1", async () => {
    await resetMemoryStoreForTests();
    const caller = await registerAgent(`CosCallsValid-${uniq()}`);
    const target = await registerAgent(`CosCallsValidPeer-${uniq()}`);

    const refused = await create(caller.agentToken, { participantIds: [target.agentId], kind: "room" });
    expect(refused.status).toBe(400);
    expect(await callsOf(caller.agentId)).toBe(0);

    const control = await create(caller.agentToken, { participantIds: [target.agentId], kind: "group", name: `cos-calls-${uniq()}` });
    expect(control.status).toBe(201);
    expect(await callsOf(caller.agentId)).toBe(1);
  }, 60_000);

  test("reuse leg: an idempotent DM re-creation (200 reused:true) consumes nothing extra", async () => {
    await resetMemoryStoreForTests();
    const caller = await registerAgent(`CosCallsReuse-${uniq()}`);
    const peer = await registerAgent(`CosCallsReusePeer-${uniq()}`);

    const first = await create(caller.agentToken, { participantIds: [peer.agentId], kind: "dm" });
    expect(first.status).toBe(201);
    expect(await callsOf(caller.agentId)).toBe(1);

    const second = await create(caller.agentToken, { participantIds: [peer.agentId], kind: "dm" });
    expect(second.status).toBe(200);
    expect(((await second.json()) as any)?.reused).toBe(true);
    expect(await callsOf(caller.agentId)).toBe(1);
  }, 60_000);
});

// --------------------------------------------------------------- visits ---

async function startVisit(ownerToken: string, agentId: string, maxActions: number) {
  const res = await app.request(`/owners/agents/${agentId}/visits`, {
    method: "POST",
    headers: json(ownerToken),
    body: JSON.stringify({ minutes: 30, maxActions }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as any).visit;
}
const visitUsed = async (visitId: string) =>
  (await db.query.agentVisits.findFirst({ where: eq(agentVisits.id, visitId) }))?.actionsUsed;
const postGoal = (token: string, objective: string) =>
  app.request("/goals", { method: "POST", headers: json(token), body: JSON.stringify({ objective }) });

describe("AIV-VISIT-REFUSED-BURN-001 — handler-refused requests consume no visit action", () => {
  test("400-refused writes leave actionsUsed unchanged; a successful write consumes exactly 1", async () => {
    const a = await registerAgent(`CosVisitBurn-${uniq()}`);
    const visit = await startVisit(a.ownerToken, a.agentId, 10);

    expect((await postGoal(a.agentToken, "visit burn control objective")).status).toBe(201);
    expect(await visitUsed(visit.id)).toBe(1);

    const badGoal = await postGoal(a.agentToken, "x"); // too short -> 400
    expect(badGoal.status).toBe(400);
    expect(await visitUsed(visit.id)).toBe(1);

    const badMem = await app.request("/memory", {
      method: "POST",
      headers: json(a.agentToken),
      body: JSON.stringify({}), // no content -> 400
    });
    expect(badMem.status).toBe(400);
    expect(await visitUsed(visit.id)).toBe(1);
  }, 30_000);

  test("composition: in a concurrent burst over a cap-3 visit, refused writes net zero and only successes count", async () => {
    const a = await registerAgent(`CosVisitMix-${uniq()}`);
    const visit = await startVisit(a.ownerToken, a.agentId, 3);
    const calls: Promise<Response>[] = [];
    for (let i = 0; i < 6; i++) calls.push(postGoal(a.agentToken, `visit mix valid objective ${i}`));
    for (let i = 0; i < 6; i++) calls.push(postGoal(a.agentToken, "x")); // invalid -> 400 when admitted
    const results = await Promise.all(calls);
    const succeeded = results.filter((r) => r.status === 201).length;
    expect(succeeded).toBeLessThanOrEqual(3);
    // Every admitted-then-refused write was refunded by the middleware:
    // the final counter is exactly the number of performed actions.
    expect(await visitUsed(visit.id)).toBe(succeeded);
  }, 30_000);
});

describe("AIV-VISIT-ACTION-CAP-RACE-001 — the visit action cap holds under concurrency", () => {
  test("sequential control exact; a 12-way burst over cap 3 admits at most 3, three rounds", async () => {
    // Control: cap 1, sequential — 1 admitted, 2nd refused, counter 1.
    const c = await registerAgent(`CosVisitCapCtl-${uniq()}`);
    const cv = await startVisit(c.ownerToken, c.agentId, 1);
    expect((await postGoal(c.agentToken, "visit cap control one")).status).toBe(201);
    expect((await postGoal(c.agentToken, "visit cap control two")).status).toBe(403);
    expect(await visitUsed(cv.id)).toBe(1);

    for (let round = 0; round < 3; round++) {
      const r = await registerAgent(`CosVisitCapRace-${uniq()}`);
      const rv = await startVisit(r.ownerToken, r.agentId, 3);
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) => postGoal(r.agentToken, `visit cap race objective ${round}-${i}`)),
      );
      const admitted = results.filter((x) => x.status === 201).length;
      expect(admitted).toBeLessThanOrEqual(3);
      expect(await visitUsed(rv.id)).toBe(3);
    }
  }, 60_000);
});

describe("AIV-VISIT-START-RACE-001 — at most one active visit per agent", () => {
  const rawStart = (ownerToken: string, agentId: string) =>
    app.request(`/owners/agents/${agentId}/visits`, {
      method: "POST",
      headers: json(ownerToken),
      body: JSON.stringify({ minutes: 30, maxActions: 10 }),
    });
  const activeCount = async (agentId: string) =>
    (await db.query.agentVisits.findMany({
      where: and(eq(agentVisits.agentId, agentId), isNull(agentVisits.endedAt)),
    })).length;

  test("sequential control: second start refused 409, one active visit", async () => {
    const a = await registerAgent(`CosVisitStartCtl-${uniq()}`);
    expect((await rawStart(a.ownerToken, a.agentId)).status).toBe(201);
    expect((await rawStart(a.ownerToken, a.agentId)).status).toBe(409);
    expect(await activeCount(a.agentId)).toBe(1);
  }, 30_000);

  test("concurrent starts admit exactly one active visit", async () => {
    const a = await registerAgent(`CosVisitStartRace-${uniq()}`);
    const results = await Promise.all(Array.from({ length: 12 }, () => rawStart(a.ownerToken, a.agentId)));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201).length).toBe(1);
    expect(statuses.filter((s) => s === 409).length).toBe(11);
    expect(await activeCount(a.agentId)).toBe(1);
  }, 30_000);
});
