import { describe, expect, test, beforeAll } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  agentMemory,
  conversations,
  messages,
  reports,
} from "@aiverse/shared/schema";
import { db } from "../db/client";
import { createApp } from "../app";
import { ensureRoomsSeeded } from "../db/seed";
import { resetMemoryStoreForTests } from "../policy/memoryStore";
import { drainIngestStream } from "../jobs/ingestConsumer";

// Permanent tests for lane A6 (validation & existence), converted from the
// adversarial loop's preserved probes. One describe per card:
//   AIV-REPLYTO-UNVALIDATED-001      — replyToId must name a message in the
//                                      same conversation (400 otherwise).
//   AIV-REPORT-BOGUS-TARGET-001      — report targets must exist (404).
//   AIV-MEMORY-FOREIGN-GOAL-TAG-001  — memory goalId must be the caller's
//                                      own goal (404 otherwise / bogus).
//   AIV-MEMORY-GOALID-TYPE-001       — non-string goalId → 400.
//   AIV-MEMORY-TYPE-COERCION-001     — non-string / undocumented type → 400.
//   AIV-TRENDING-PROTOTYPE-WINDOW-001 — inherited Object.prototype window
//                                      keys fall back to the 24h default.
//   AIV-TOPICS-PAGINATION-001        — limit/offset must be non-negative
//                                      integers (400 otherwise).

const app = createApp();
beforeAll(async () => {
  await ensureRoomsSeeded();
});

function json(token?: string) {
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function ownerWithAgent(name: string) {
  const email = `a6-${uniq()}@example.com`;
  const reg = await app.request("/owners/register", {
    method: "POST",
    headers: json(),
    body: JSON.stringify({ email, password: "password123" }),
  });
  const { token: ownerToken } = (await reg.json()) as any;
  const created = await app.request("/owners/agents", {
    method: "POST",
    headers: json(ownerToken),
    body: JSON.stringify({ name, capabilities: [] }),
  });
  const { agent, agentToken } = (await created.json()) as any;
  await app.request(`/owners/agents/${agent.id}/wallet`, {
    method: "PATCH",
    headers: json(ownerToken),
    body: JSON.stringify({ autonomyMode: "autonomous" }),
  });
  return {
    ownerToken: ownerToken as string,
    agentId: agent.id as string,
    agentToken: agentToken as string,
  };
}
async function makeGoal(agentToken: string, objective: string) {
  const res = await app.request("/goals", {
    method: "POST",
    headers: json(agentToken),
    body: JSON.stringify({ objective }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as any).goal.id as string;
}
async function postMemory(agentToken: string, body: any) {
  return app.request("/memory", {
    method: "POST",
    headers: json(agentToken),
    body: JSON.stringify(body),
  });
}
async function postReport(ownerToken: string, body: any) {
  return app.request("/reports", {
    method: "POST",
    headers: json(ownerToken),
    body: JSON.stringify(body),
  });
}

describe("AIV-REPLYTO-UNVALIDATED-001", () => {
  test("bogus, malformed, and cross-conversation replyToId are refused up front; accepted sends persist", async () => {
    const u = uniq();
    const a = await ownerWithAgent("ReplyA" + u);
    const b = await ownerWithAgent("ReplyB" + u);
    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: json(a.agentToken),
      body: JSON.stringify({ isPublic: false, participantIds: [b.agentId] }),
    });
    expect(createRes.status).toBe(201);
    const convId = ((await createRes.json()) as any).conversation.id as string;
    // A DM with a different participant — the same pair would dedupe to
    // the first conversation (200, same id), which is not "cross".
    const cOwner = await ownerWithAgent("ReplyC" + u);
    const otherCreate = await app.request("/conversations", {
      method: "POST",
      headers: json(a.agentToken),
      body: JSON.stringify({ isPublic: false, participantIds: [cOwner.agentId] }),
    });
    expect(otherCreate.status).toBe(201);
    const otherConvId = ((await otherCreate.json()) as any).conversation.id as string;
    expect(otherConvId).not.toBe(convId);

    const send = async (conv: string, body: any) => {
      await resetMemoryStoreForTests();
      return app.request(`/conversations/${conv}/messages`, {
        method: "POST",
        headers: json(a.agentToken),
        body: JSON.stringify(body),
      });
    };
    const rowsFor = (content: string) =>
      db.query.messages.findMany({
        where: and(eq(messages.conversationId, convId), eq(messages.content, content)),
      });

    // Control: plain send persists.
    const c1 = await send(convId, { content: "reply-control-" + u });
    expect(c1.status).toBe(201);
    await drainIngestStream();
    const controlRows = await rowsFor("reply-control-" + u);
    expect(controlRows.length).toBe(1);
    const parentId = controlRows[0].id;

    // Valid reply: persists pointing at the real parent.
    const c2 = await send(convId, { content: "reply-valid-" + u, replyToId: parentId });
    expect(c2.status).toBe(201);
    await drainIngestStream();
    const validRows = await rowsFor("reply-valid-" + u);
    expect(validRows.length).toBe(1);
    expect(validRows[0].replyToId).toBe(parentId);

    // In-flight parent: the parent send's 201 was issued but the ingest
    // consumer has NOT persisted it yet (no drain) — its gateway-issued
    // id is still a valid reply target in the same conversation.
    const cInf = await send(convId, { content: "reply-inflight-parent-" + u });
    expect(cInf.status).toBe(201);
    const inflightId = ((await cInf.json()) as any).message.id as string;
    const cInfReply = await send(convId, { content: "reply-inflight-" + u, replyToId: inflightId });
    expect(cInfReply.status).toBe(201);
    await drainIngestStream();
    const inflightRows = await rowsFor("reply-inflight-" + u);
    expect(inflightRows.length).toBe(1);
    expect(inflightRows[0].replyToId).toBe(inflightId);

    // Bogus (well-formed but nonexistent) UUID → 400, nothing stored.
    const rA = await send(convId, { content: "reply-bogus-" + u, replyToId: crypto.randomUUID() });
    expect(rA.status).toBe(400);
    await drainIngestStream();
    expect((await rowsFor("reply-bogus-" + u)).length).toBe(0);

    // Malformed replyToId → 400, nothing stored, no ingest wedge.
    const rB = await send(convId, { content: "reply-malformed-" + u, replyToId: "not-a-uuid" });
    expect(rB.status).toBe(400);
    await drainIngestStream();
    expect((await rowsFor("reply-malformed-" + u)).length).toBe(0);

    // Cross-conversation: parent exists but in a DIFFERENT conversation → 400.
    const [foreignMsg] = await db
      .insert(messages)
      .values({ conversationId: otherConvId, senderAgentId: a.agentId, content: "foreign parent " + u })
      .returning();
    const rC = await send(convId, { content: "reply-xconv-" + u, replyToId: foreignMsg.id });
    expect(rC.status).toBe(400);
    await drainIngestStream();
    expect((await rowsFor("reply-xconv-" + u)).length).toBe(0);

    // Follow-up plain send still persists (no silent loss).
    const c3 = await send(convId, { content: "reply-after-" + u });
    expect(c3.status).toBe(201);
    await drainIngestStream();
    expect((await rowsFor("reply-after-" + u)).length).toBe(1);
  });
});

describe("AIV-REPORT-BOGUS-TARGET-001", () => {
  test("control: valid agent and message targets report 201 and store one row each", async () => {
    const owner = await ownerWithAgent("RptCtl" + uniq());
    const res = await postReport(owner.ownerToken, { targetAgentId: owner.agentId, reason: "spam control" });
    expect(res.status).toBe(201);
    const rows = await db.query.reports.findMany({ where: eq(reports.targetAgentId, owner.agentId) });
    expect(rows.length).toBe(1);

    const [conv] = await db.insert(conversations).values({ kind: "dm", isPublic: false }).returning();
    const [msg] = await db
      .insert(messages)
      .values({ conversationId: conv.id, senderAgentId: owner.agentId, content: "hello control" })
      .returning();
    const res2 = await postReport(owner.ownerToken, { targetMessageId: msg.id, reason: "abuse control" });
    expect(res2.status).toBe(201);
    const rows2 = await db.query.reports.findMany({ where: eq(reports.targetMessageId, msg.id) });
    expect(rows2.length).toBe(1);
  });

  test("bogus agent target → 404 and no row", async () => {
    const owner = await ownerWithAgent("RptBogA" + uniq());
    const bogus = "11111111-2222-3333-4444-555555555555";
    const res = await postReport(owner.ownerToken, { targetAgentId: bogus, reason: "ghost agent" });
    expect(res.status).toBe(404);
    const rows = await db.query.reports.findMany({ where: eq(reports.targetAgentId, bogus) });
    expect(rows.length).toBe(0);
  });

  test("bogus message target → 404 and no row", async () => {
    const owner = await ownerWithAgent("RptBogM" + uniq());
    const bogus = "99999999-8888-7777-6666-555555555555";
    const res = await postReport(owner.ownerToken, { targetMessageId: bogus, reason: "ghost message" });
    expect(res.status).toBe(404);
    const rows = await db.query.reports.findMany({ where: eq(reports.targetMessageId, bogus) });
    expect(rows.length).toBe(0);
  });

  test("malformed targets → 4xx and no row", async () => {
    const owner = await ownerWithAgent("RptMal" + uniq());
    const r1 = await postReport(owner.ownerToken, { targetAgentId: "not-a-uuid", reason: "malformed" });
    expect(r1.status).toBeGreaterThanOrEqual(400);
    expect(r1.status).toBeLessThan(500);
    const r2 = await postReport(owner.ownerToken, { targetMessageId: "not-a-uuid", reason: "malformed" });
    expect(r2.status).toBeGreaterThanOrEqual(400);
    expect(r2.status).toBeLessThan(500);
  });
});

describe("AIV-MEMORY-FOREIGN-GOAL-TAG-001", () => {
  test("control: own goalId tags, stores, and reads back via own owner", async () => {
    const a = await ownerWithAgent("MemTagCtl" + uniq());
    const g = await makeGoal(a.agentToken, "memory tag control objective");
    const m = `memtag-marker-${uniq()}`;
    const res = await postMemory(a.agentToken, { content: m, goalId: g });
    expect(res.status).toBe(201);
    const rows = await db.query.agentMemory.findMany({ where: eq(agentMemory.goalId, g) });
    expect(rows.some((r) => r.content === m && r.agentId === a.agentId)).toBe(true);
    const read = await app.request(`/owners/goals/${g}/memory`, { headers: json(a.ownerToken) });
    expect(read.status).toBe(200);
    expect(JSON.stringify((await read.json()) as any)).toContain(m);
  });

  test("foreign goalId is refused, stores nothing, never reaches the foreign owner's recall", async () => {
    const a = await ownerWithAgent("MemTagAtk" + uniq());
    const b = await ownerWithAgent("MemTagVic" + uniq());
    const gB = await makeGoal(b.agentToken, "victim goal for memory tagging");
    const m = `memtag-marker-${uniq()}`;
    const res = await postMemory(a.agentToken, { content: m, goalId: gB });
    expect(res.status).toBe(404);
    const rows = await db.query.agentMemory.findMany({ where: eq(agentMemory.goalId, gB) });
    expect(rows.some((r) => r.content === m)).toBe(false);
    const read = await app.request(`/owners/goals/${gB}/memory`, { headers: json(b.ownerToken) });
    expect(JSON.stringify((await read.json()) as any)).not.toContain(m);
  });

  test("same-owner different-agent goalId is refused (goal belongs to another agent)", async () => {
    const a = await ownerWithAgent("MemTagSame" + uniq());
    const created = await app.request("/owners/agents", {
      method: "POST",
      headers: json(a.ownerToken),
      body: JSON.stringify({ name: "MemTagSecond" + uniq(), capabilities: [] }),
    });
    const { agentToken: secondToken } = (await created.json()) as any;
    const gOther = await makeGoal(secondToken, "second agent goal");
    const m = `memtag-marker-${uniq()}`;
    const res = await postMemory(a.agentToken, { content: m, goalId: gOther });
    expect(res.status).toBe(404);
    const rows = await db.query.agentMemory.findMany({ where: eq(agentMemory.goalId, gOther) });
    expect(rows.some((r) => r.content === m)).toBe(false);
  });

  test("nonexistent goalId gets a clean 4xx and stores nothing", async () => {
    const a = await ownerWithAgent("MemTagBog" + uniq());
    const bogus = "22222222-3333-4444-5555-666666666666";
    const m = `memtag-marker-${uniq()}`;
    const res = await postMemory(a.agentToken, { content: m, goalId: bogus });
    expect(res.status).toBe(404);
    const rows = await db.query.agentMemory.findMany({ where: eq(agentMemory.goalId, bogus) });
    expect(rows.length).toBe(0);
  });
});

describe("AIV-MEMORY-GOALID-TYPE-001", () => {
  const hostile: Array<[string, any]> = [
    ["malformed-string", "not-a-uuid"],
    ["number", 12345],
    ["boolean", true],
    ["array", ["11111111-2222-3333-4444-555555555555"]],
    ["object", { id: "11111111-2222-3333-4444-555555555555" }],
    ["float", 1.5],
  ];
  for (const [label, value] of hostile) {
    test(`goalId ${label} → 400 and stores nothing`, async () => {
      const a = await ownerWithAgent("MemMal" + label.slice(0, 4) + uniq());
      const m = `memmal-marker-${uniq()}`;
      const res = await postMemory(a.agentToken, { content: m, goalId: value });
      expect(res.status).toBe(400);
      const rows = await db.query.agentMemory.findMany({ where: eq(agentMemory.agentId, a.agentId) });
      expect(rows.some((r) => r.content === m)).toBe(false);
    });
  }
});

describe("AIV-MEMORY-TYPE-COERCION-001", () => {
  test("control: valid memory stores with null provenance; documented types accepted", async () => {
    const a = await ownerWithAgent("MemAuxCtl" + uniq());
    const m = `memaux-marker-${uniq()}`;
    const res = await postMemory(a.agentToken, { content: m });
    expect(res.status).toBe(201);
    const rows = await db.query.agentMemory.findMany({ where: eq(agentMemory.agentId, a.agentId) });
    const row = rows.find((r) => r.content === m);
    expect(row).toBeTruthy();
    expect(row!.sourceMessageId).toBeNull();
    expect(row!.runId).toBeNull();
    for (const t of ["interaction", "encountered_agent", "conclusion", "goal_note"]) {
      const r = await postMemory(a.agentToken, { content: `typed-${t}-${uniq()}`, type: t });
      expect(r.status).toBe(201);
    }
  });

  test("forged provenance fields in body are never stored and never 500", async () => {
    const a = await ownerWithAgent("MemAuxForge" + uniq());
    const m = `memaux-marker-${uniq()}`;
    const BOGUS_MSG = "11111111-2222-3333-4444-555555555555";
    const BOGUS_RUN = "66666666-7777-8888-9999-000000000000";
    const res = await postMemory(a.agentToken, { content: m, sourceMessageId: BOGUS_MSG, runId: BOGUS_RUN });
    expect(res.status).toBeLessThan(500);
    const rows = await db.query.agentMemory.findMany({ where: eq(agentMemory.agentId, a.agentId) });
    const stored = rows.filter((r) => r.content === m);
    expect(stored.some((r) => r.sourceMessageId === BOGUS_MSG || r.runId === BOGUS_RUN)).toBe(false);
  });

  const hostileTypes: Array<[string, any]> = [
    ["number", 12345],
    ["boolean", true],
    ["array", ["interaction"]],
    ["object", { kind: "interaction" }],
    ["float", 1.5],
    ["undocumented-string", "made_up_type"],
  ];
  for (const [label, value] of hostileTypes) {
    test(`type ${label} → 400 and stores nothing`, async () => {
      const a = await ownerWithAgent("MemAuxT" + label.slice(0, 3) + uniq());
      const m = `memaux-marker-${uniq()}`;
      const res = await postMemory(a.agentToken, { content: m, type: value });
      expect(res.status).toBe(400);
      const rows = await db.query.agentMemory.findMany({ where: eq(agentMemory.agentId, a.agentId) });
      expect(rows.some((r) => r.content === m)).toBe(false);
    });
  }
});

describe("AIV-TRENDING-PROTOTYPE-WINDOW-001", () => {
  test("inherited Object.prototype window keys fall back to the default window (200, never 500)", async () => {
    await resetMemoryStoreForTests();
    const keys = [
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
      "valueOf",
      "toLocaleString",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "__defineGetter__",
    ];
    for (const w of keys) {
      const res = await app.request(`/public/trending?window=${encodeURIComponent(w)}`);
      expect(res.status).toBe(200);
    }
    // Valid windows still work.
    for (const w of ["1h", "24h"]) {
      const res = await app.request(`/public/trending?window=${w}`);
      expect(res.status).toBe(200);
    }
  });
});

describe("AIV-TOPICS-PAGINATION-001", () => {
  test("control: plain and limit=5 requests return 200", async () => {
    const plain = await app.request("/topics/science/messages");
    expect(plain.status).toBe(200);
    const lim = await app.request("/topics/science/messages?limit=5");
    expect(lim.status).toBe(200);
    const off = await app.request("/topics/science/messages?offset=0");
    expect(off.status).toBe(200);
  });

  const bad = ["limit=-1", "limit=abc", "limit=1.5", "limit=0", "offset=-1", "offset=abc", "offset=1.5", "offset=-5", "limit=-100&offset=-100"];
  for (const s of bad) {
    test(`shape ${s} → 400`, async () => {
      const res = await app.request(`/topics/science/messages?${s}`);
      expect(res.status).toBe(400);
    });
  }
});
