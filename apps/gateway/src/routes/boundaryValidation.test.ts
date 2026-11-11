import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { createApp } from "../app";
import { websocket } from "../ws/gateway";
import { ensureRoomsSeeded } from "../db/seed";
import { agentMemory, reports, messages } from "@aiverse/shared/schema";

// Validate references at the write boundary (2026-11-11 fix lane) —
// permanent versions of the adversarial-loop probes for the cards that
// shared one discipline: a request body is untrusted input, and ids,
// types, and enum keys it carries must be checked for existence,
// ownership, and shape BEFORE the row is written — never left for a
// database constraint (or the absence of one) to sort out downstream.
//
//   AIV-TRENDING-PROTOTYPE-WINDOW-001  ?window=__proto__/constructor hit a
//                                      plain-object lookup → undefined **
//                                      produced a NaN cutoff → 500
//   AIV-MEMORY-FOREIGN-GOAL-TAG-001    memory POST stored a foreign agent's
//                                      goalId; owner goal-recall has no
//                                      agent filter, so it planted content
//                                      in another owner's recall
//   AIV-MEMORY-GOALID-TYPE-001         boolean/array goalId 500'd past the
//                                      22P02 mapper
//   AIV-MEMORY-TYPE-COERCION-001       non-string type stored string-coerced
//   (AIV-POLICY-PHANTOM-001 shared this discipline but was fixed by
//   lane A5 and is covered by authorityUniqueness.test.ts.)
//   AIV-REPORT-BOGUS-TARGET-001        report insert's FK was the only
//                                      target check → bogus target 500'd
//   AIV-REPLYTO-UNVALIDATED-001        replyToId copied verbatim; bogus id
//                                      stored dangling, malformed id lost
//                                      the accepted send in the consumer

const app = createApp();
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
afterAll(() => {
  server.stop(true);
});
beforeAll(async () => {
  await ensureRoomsSeeded();
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const BOGUS_UUID = "123e4567-e89b-42d3-a456-426614174000";

function json(token?: string) {
  return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

async function registerAgent(name: string) {
  const email = `bv-${uniq()}@example.com`;
  const reg = await app.request("/owners/register", {
    method: "POST",
    headers: json(),
    body: JSON.stringify({ email, password: "password123" }),
  });
  expect(reg.status).toBe(201);
  const { token: ownerToken } = (await reg.json()) as any;
  const create = await app.request("/owners/agents", {
    method: "POST",
    headers: json(ownerToken),
    body: JSON.stringify({ name }),
  });
  expect(create.status).toBe(201);
  const { agent, agentToken } = (await create.json()) as any;
  return { ownerToken, agent, token: agentToken };
}

describe("public trending window validation", () => {
  test("object-prototype keys in ?window fall back to the default, never 500", async () => {
    for (const w of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
      const res = await app.request(`/public/trending?window=${encodeURIComponent(w)}`);
      expect(res.status).toBe(200);
    }
    for (const w of ["1h", "24h", "7d", "garbage"]) {
      const res = await app.request(`/public/trending?window=${encodeURIComponent(w)}`);
      expect(res.status).toBe(200);
    }
  });
});

describe("memory write validation", () => {
  test("foreign and nonexistent goalIds are refused and store nothing; own goal works", async () => {
    const a = await registerAgent(`BvMemA-${uniq()}`);
    const b = await registerAgent(`BvMemB-${uniq()}`);

    const goalRes = await app.request("/goals", {
      method: "POST",
      headers: json(a.token),
      body: JSON.stringify({ objective: `bv goal ${uniq()}` }),
    });
    expect(goalRes.status).toBe(201);
    const { goal } = (await goalRes.json()) as any;

    const own = await app.request("/memory", {
      method: "POST",
      headers: json(a.token),
      body: JSON.stringify({ type: "interaction", content: "own goal note", goalId: goal.id }),
    });
    expect(own.status).toBe(201);

    const foreign = await app.request("/memory", {
      method: "POST",
      headers: json(b.token),
      body: JSON.stringify({ type: "interaction", content: "planted", goalId: goal.id }),
    });
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect(foreign.status).toBeLessThan(500);

    const bogus = await app.request("/memory", {
      method: "POST",
      headers: json(b.token),
      body: JSON.stringify({ type: "interaction", content: "planted2", goalId: BOGUS_UUID }),
    });
    expect(bogus.status).toBeGreaterThanOrEqual(400);
    expect(bogus.status).toBeLessThan(500);

    const bRows = await db.query.agentMemory.findMany({ where: eq(agentMemory.agentId, b.agent.id) });
    expect(bRows.length).toBe(0);
  });

  test("non-string goalId and type shapes are clean 4xx, never 500, nothing stored", async () => {
    const a = await registerAgent(`BvMemTypes-${uniq()}`);
    for (const goalId of [true, false, ["x"], { id: "x" }, 42]) {
      const res = await app.request("/memory", {
        method: "POST",
        headers: json(a.token),
        body: JSON.stringify({ type: "interaction", content: "shape probe", goalId }),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    for (const type of [12345, true, ["observation"], { kind: "x" }]) {
      const res = await app.request("/memory", {
        method: "POST",
        headers: json(a.token),
        body: JSON.stringify({ type, content: "type probe" }),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    const rows = await db.query.agentMemory.findMany({ where: eq(agentMemory.agentId, a.agent.id) });
    expect(rows.length).toBe(0);

    const plain = await app.request("/memory", {
      method: "POST",
      headers: json(a.token),
      body: JSON.stringify({ content: "no type, no goal" }),
    });
    expect(plain.status).toBe(201);
  });
});

describe("report target validation", () => {
  test("bogus agent and message targets are 404 and store nothing; real targets work", async () => {
    const a = await registerAgent(`BvReportA-${uniq()}`);
    const b = await registerAgent(`BvReportB-${uniq()}`);

    const bogusAgent = await app.request("/reports", {
      method: "POST",
      headers: json(a.ownerToken),
      body: JSON.stringify({ targetAgentId: BOGUS_UUID, reason: "spam" }),
    });
    expect(bogusAgent.status).toBe(404);

    const bogusMessage = await app.request("/reports", {
      method: "POST",
      headers: json(a.ownerToken),
      body: JSON.stringify({ targetMessageId: BOGUS_UUID, reason: "spam" }),
    });
    expect(bogusMessage.status).toBe(404);

    const onBogus = await db.query.reports.findMany({ where: eq(reports.targetAgentId, BOGUS_UUID) });
    expect(onBogus.length).toBe(0);

    const real = await app.request("/reports", {
      method: "POST",
      headers: json(a.ownerToken),
      body: JSON.stringify({ targetAgentId: b.agent.id, reason: "spam" }),
    });
    expect(real.status).toBe(201);
    const onReal = await db.query.reports.findMany({ where: eq(reports.targetAgentId, b.agent.id) });
    expect(onReal.length).toBe(1);
  });
});

describe("replyToId validation", () => {
  test("bogus and malformed replyToIds are refused up front; a real parent threads", async () => {
    const a = await registerAgent(`BvReplyA-${uniq()}`);
    const b = await registerAgent(`BvReplyB-${uniq()}`);

    const room = await app.request("/rooms/general/join", {
      method: "POST",
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(room.status).toBe(200);
    const { conversationId } = (await room.json()) as any;
    const joinB = await app.request("/rooms/general/join", {
      method: "POST",
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(joinB.status).toBe(200);

    const parent = await app.request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: json(a.token),
      body: JSON.stringify({ content: "parent message" }),
    });
    expect(parent.status).toBe(201);
    const { message: parentMsg } = (await parent.json()) as any;

    for (const replyToId of [BOGUS_UUID, "not-a-uuid"]) {
      const res = await app.request(`/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: json(a.token),
        body: JSON.stringify({ content: "reply to nothing", replyToId }),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }

    // The agent send-rate bucket (1/sec) may have been drained by the
    // sends above; wait out one refill window so the control send is
    // judged on its replyToId, not on rate.
    await new Promise((r) => setTimeout(r, 1100));
    const ok = await app.request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: json(a.token),
      body: JSON.stringify({ content: "real reply", replyToId: parentMsg.id }),
    });
    expect(ok.status).toBe(201);
    const { message: replyMsg } = (await ok.json()) as any;
    expect(replyMsg.replyToId).toBe(parentMsg.id);

    const stored = await db.query.messages.findMany({ where: eq(messages.conversationId, conversationId) });
    expect(stored.some((m) => m.replyToId === BOGUS_UUID)).toBe(false);
  });
});
