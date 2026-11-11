import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { a2aTasks, consoleEvents, goals, onboardingQuestions, reports } from "@aiverse/shared/schema";
import { db } from "../db/client";
import { createApp } from "../app";
import { websocket } from "../ws/gateway";
import { ensureRoomsSeeded } from "../db/seed";
import { resetMemoryStoreForTests } from "../policy/memoryStore";

// Guarded transitions (2026-11-11, lane A1) — permanent versions of the
// adversarial-loop probes for six Medium cards that shared one shape:
// a handler read a row, checked its state in memory, then UPDATE'd by id
// only, so two concurrent transitions could both pass the check and both
// land, with the loser's side effects (ledger backfill, audit events,
// live-pushes) firing too. The discipline: the state predicate lives IN
// the UPDATE (or the row is locked in a transaction); on 0 rows updated
// the handler returns the conflict and writes nothing else.
//
//   AIV-GOAL-VERDICT-RACE-001        owner goal verdict (routes/goals.ts)
//   AIV-AGENT-PATCH-VERDICT-RACE-001 agent PATCH /goals/:id (routes/goals.ts)
//   AIV-A2A-CANCEL-COMPLETE-RACE-001 A2A tasks/cancel (routes/a2a.ts) —
//                                    fixed on main before this lane; the
//                                    cancel+complete leg is also covered in
//                                    a2a.test.ts. Both probe legs live here.
//   AIV-ONBOARDING-ANSWER-RACE-001   owner onboarding answer (routes/onboarding.ts)
//   AIV-REPORT-RERESOLVE-001         admin report resolve (routes/admin.ts)
//   AIV-CONSOLE-RESOLVE-RERESOLVE-001 owner console-event resolve (routes/owners.ts)

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
async function registerAgent(name: string) {
  const email = `gt-${uniq()}@example.com`;
  const reg = await app.request("/owners/register", {
    method: "POST",
    headers: json(),
    body: JSON.stringify({ email, password: "password123" }),
  });
  expect(reg.status).toBe(201);
  const { token: ownerToken, owner } = (await reg.json()) as any;
  const created = await app.request("/owners/agents", {
    method: "POST",
    headers: json(ownerToken),
    body: JSON.stringify({ name, capabilities: [] }),
  });
  expect(created.status).toBe(201);
  const { agentToken, agent } = (await created.json()) as any;
  return {
    ownerToken: ownerToken as string,
    ownerId: owner.id as string,
    agentToken: agentToken as string,
    agentId: agent.id as string,
  };
}

// ---------------------------------------------------------------- goals ---

async function synthesizedGoal(agentToken: string) {
  const createRes = await app.request("/goals", {
    method: "POST",
    headers: json(agentToken),
    body: JSON.stringify({ objective: "research the assigned topic thoroughly" }),
  });
  const { goal } = (await createRes.json()) as any;
  const patchRes = await app.request(`/goals/${goal.id}`, {
    method: "PATCH",
    headers: json(agentToken),
    body: JSON.stringify({ status: "synthesized", result: { summary: "done" } }),
  });
  expect(patchRes.status).toBe(200);
  return goal.id as string;
}
const verdict = (ownerToken: string, goalId: string, v: "accept" | "reject") =>
  app.request(`/owners/goals/${goalId}/${v}`, { method: "POST", headers: json(ownerToken) });
async function goalStatus(goalId: string) {
  const g = await db.query.goals.findFirst({ where: eq(goals.id, goalId) });
  return g?.status;
}

describe("AIV-GOAL-VERDICT-RACE-001 — owner goal verdict is a guarded transition", () => {
  test("sequential control: accept lands, reject refused 409, final accepted", async () => {
    await resetMemoryStoreForTests();
    const a = await registerAgent("GTVerdictCtl" + uniq().slice(-4));
    const goalId = await synthesizedGoal(a.agentToken);
    expect((await verdict(a.ownerToken, goalId, "accept")).status).toBe(200);
    expect((await verdict(a.ownerToken, goalId, "reject")).status).toBe(409);
    expect(await goalStatus(goalId)).toBe("accepted");
  }, 30_000);

  test("concurrent accept + reject: exactly one verdict lands per round", async () => {
    await resetMemoryStoreForTests();
    let violations = 0;
    for (let round = 0; round < 5; round++) {
      const a = await registerAgent("GTVerdictRace" + uniq().slice(-4));
      const goalId = await synthesizedGoal(a.agentToken);
      const [acceptRes, rejectRes] = await Promise.all([
        verdict(a.ownerToken, goalId, "accept"),
        verdict(a.ownerToken, goalId, "reject"),
      ]);
      const winners = [acceptRes.status, rejectRes.status].filter((s) => s === 200).length;
      const final = await goalStatus(goalId);
      const expected = acceptRes.status === 200 ? "accepted" : "rejected";
      if (winners !== 1 || final !== expected) violations++;
    }
    expect(violations).toBe(0);
  }, 60_000);
});

describe("AIV-AGENT-PATCH-VERDICT-RACE-001 — agent PATCH cannot overwrite a verdict", () => {
  const agentPatch = (agentToken: string, goalId: string) =>
    app.request(`/goals/${goalId}`, {
      method: "PATCH",
      headers: json(agentToken),
      body: JSON.stringify({ status: "open", result: { summary: "agent revision" } }),
    });

  test("sequential controls: verdict-then-patch refused 409; patch-then-verdict refused 409", async () => {
    await resetMemoryStoreForTests();
    const a = await registerAgent("GTPatchCtlA" + uniq().slice(-4));
    const g1 = await synthesizedGoal(a.agentToken);
    expect((await verdict(a.ownerToken, g1, "accept")).status).toBe(200);
    expect((await agentPatch(a.agentToken, g1)).status).toBe(409);
    expect(await goalStatus(g1)).toBe("accepted");

    const b = await registerAgent("GTPatchCtlB" + uniq().slice(-4));
    const g2 = await synthesizedGoal(b.agentToken);
    expect((await agentPatch(b.agentToken, g2)).status).toBe(200);
    expect((await verdict(b.ownerToken, g2, "accept")).status).toBe(409);
    expect(await goalStatus(g2)).toBe("open");
  }, 30_000);

  test("concurrent verdict + agent PATCH: exactly one transition lands per round", async () => {
    await resetMemoryStoreForTests();
    let violations = 0;
    for (let round = 0; round < 5; round++) {
      const a = await registerAgent("GTPatchRace" + uniq().slice(-4));
      const goalId = await synthesizedGoal(a.agentToken);
      const [verdictRes, patchRes] = await Promise.all([
        verdict(a.ownerToken, goalId, "accept"),
        agentPatch(a.agentToken, goalId),
      ]);
      const winners = [verdictRes.status, patchRes.status].filter((s) => s === 200).length;
      const final = await goalStatus(goalId);
      const expected = verdictRes.status === 200 ? "accepted" : "open";
      if (winners !== 1 || final !== expected) violations++;
    }
    expect(violations).toBe(0);
  }, 60_000);
});

// ------------------------------------------------------------------ a2a ---

async function registerA2AAgent(name: string) {
  const a = await registerAgent(name);
  const wallet = await app.request(`/owners/agents/${a.agentId}/wallet`, {
    method: "PATCH",
    headers: json(a.ownerToken),
    body: JSON.stringify({ autonomyMode: "autonomous" }),
  });
  expect(wallet.status).toBe(200);
  return a;
}
async function sendTask(caller: { agentToken: string }, targetId: string) {
  const res = await app.request(`/a2a/agents/${targetId}`, {
    method: "POST",
    headers: json(caller.agentToken),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: {
        message: { role: "user", parts: [{ kind: "text", text: "do a thing" }], messageId: `m-${uniq()}`, metadata: { tokensUsed: 0 } },
      },
    }),
  });
  const body: any = await res.json().catch(() => ({}));
  expect(res.status).toBe(200);
  return body.result.id as string;
}
async function cancelTask(caller: { agentToken: string }, targetId: string, taskId: string) {
  const res = await app.request(`/a2a/agents/${targetId}`, {
    method: "POST",
    headers: json(caller.agentToken),
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tasks/cancel", params: { id: taskId } }),
  });
  const body: any = await res.json().catch(() => ({}));
  return { status: res.status, code: body?.error?.code ?? null };
}
async function taskState(taskId: string) {
  const t = await db.query.a2aTasks.findFirst({ where: eq(a2aTasks.id, taskId) });
  return t?.state;
}

describe("AIV-A2A-CANCEL-COMPLETE-RACE-001 — A2A cancel is a guarded transition", () => {
  test("sequential control: cancel lands, second cancel refused 409 -32002, final canceled", async () => {
    await resetMemoryStoreForTests();
    const target = await registerA2AAgent("GTCancelCtlT" + uniq().slice(-4));
    const caller = await registerA2AAgent("GTCancelCtlC" + uniq().slice(-4));
    const taskId = await sendTask(caller, target.agentId);
    const first = await cancelTask(caller, target.agentId, taskId);
    expect(first.status).toBe(200);
    const second = await cancelTask(caller, target.agentId, taskId);
    expect(second.status).toBe(409);
    expect(second.code).toBe(-32002);
    expect(await taskState(taskId)).toBe("canceled");
  }, 60_000);

  test("concurrent duplicate cancels: exactly one succeeds per round", async () => {
    await resetMemoryStoreForTests();
    let violations = 0;
    for (let round = 0; round < 5; round++) {
      const target = await registerA2AAgent("GTCancelRaceT" + uniq().slice(-4));
      const caller = await registerA2AAgent("GTCancelRaceC" + uniq().slice(-4));
      const taskId = await sendTask(caller, target.agentId);
      const [a, b] = await Promise.all([
        cancelTask(caller, target.agentId, taskId),
        cancelTask(caller, target.agentId, taskId),
      ]);
      const winners = [a.status, b.status].filter((s) => s === 200).length;
      const loser = [a, b].find((r) => r.status !== 200);
      if (winners !== 1 || loser?.status !== 409 || loser?.code !== -32002 || (await taskState(taskId)) !== "canceled") violations++;
    }
    expect(violations).toBe(0);
  }, 120_000);
});

// ------------------------------------------------------------ onboarding ---

describe("AIV-ONBOARDING-ANSWER-RACE-001 — onboarding answer is final", () => {
  async function ask(agentToken: string) {
    const res = await app.request("/onboarding/questions", {
      method: "POST",
      headers: json(agentToken),
      body: JSON.stringify({
        question: "What should I focus on first?",
        options: [
          { label: "Research", value: "research" },
          { label: "Socialize", value: "socialize" },
        ],
        allowFreeText: false,
      }),
    });
    expect(res.status).toBe(201);
    const { question } = await res.json();
    return question.id as string;
  }
  const answer = (ownerToken: string, agentId: string, qid: string, value: string) =>
    app.request(`/owners/agents/${agentId}/questions/${qid}/answer`, {
      method: "POST",
      headers: json(ownerToken),
      body: JSON.stringify({ value }),
    });

  test("sequential control: first answer 200, second 409, stored answer is first", async () => {
    await resetMemoryStoreForTests();
    const a = await registerAgent("GTOnbCtl" + uniq().slice(-4));
    const qid = await ask(a.agentToken);
    expect((await answer(a.ownerToken, a.agentId, qid, "research")).status).toBe(200);
    expect((await answer(a.ownerToken, a.agentId, qid, "socialize")).status).toBe(409);
    const row = await db.query.onboardingQuestions.findFirst({ where: eq(onboardingQuestions.id, qid) });
    expect((row?.answer as any)?.value).toBe("research");
  }, 30_000);

  test("concurrent answers: exactly one 200 per round, stored answer is the winner's", async () => {
    await resetMemoryStoreForTests();
    let violations = 0;
    for (let round = 0; round < 5; round++) {
      const a = await registerAgent("GTOnbRace" + uniq().slice(-4));
      const qid = await ask(a.agentToken);
      const [r1, r2] = await Promise.all([
        answer(a.ownerToken, a.agentId, qid, "research"),
        answer(a.ownerToken, a.agentId, qid, "socialize"),
      ]);
      const statuses = [r1.status, r2.status].sort((x, y) => x - y);
      const row = await db.query.onboardingQuestions.findFirst({ where: eq(onboardingQuestions.id, qid) });
      const winnerValue = r1.status === 200 ? "research" : "socialize";
      if (!(statuses[0] === 200 && statuses[1] === 409) || (row?.answer as any)?.value !== winnerValue) violations++;
    }
    expect(violations).toBe(0);
  }, 60_000);
});

// --------------------------------------------------------------- reports ---

describe("AIV-REPORT-RERESOLVE-001 — a report is resolved exactly once", () => {
  async function registerOwnerByEmail(email: string) {
    const res = await app.request("/owners/register", {
      method: "POST",
      headers: json(),
      body: JSON.stringify({ email, password: "password123" }),
    });
    if (res.status === 409) {
      const login = await app.request("/owners/login", {
        method: "POST",
        headers: json(),
        body: JSON.stringify({ email, password: "password123" }),
      });
      const { token } = await login.json();
      return token as string;
    }
    const { token } = await res.json();
    return token as string;
  }
  let adminCached: string | undefined;
  async function adminToken() {
    if (!adminCached) adminCached = await registerOwnerByEmail("admin-test@example.com");
    return adminCached;
  }
  async function setup() {
    await resetMemoryStoreForTests();
    const reporter = await registerOwnerByEmail(`gt-rep-${uniq()}@example.com`);
    const created = await app.request("/owners/agents", {
      method: "POST",
      headers: json(reporter),
      body: JSON.stringify({ name: `GTReportTarget-${uniq()}`, capabilities: [] }),
    });
    const { agent } = await created.json();
    const rep = await app.request("/reports", {
      method: "POST",
      headers: json(reporter),
      body: JSON.stringify({ targetAgentId: agent.id, reason: "spam" }),
    });
    expect(rep.status).toBe(201);
    const { report } = await rep.json();
    return { reportId: report.id as string, admin: await adminToken() };
  }
  const resolve = (admin: string, id: string, status: string) =>
    app.request(`/admin/reports/${id}/resolve`, {
      method: "POST",
      headers: json(admin),
      body: JSON.stringify({ status }),
    });

  test("sequential control: first resolve 200, second resolve 409, stored status is first", async () => {
    const { reportId, admin } = await setup();
    expect((await resolve(admin, reportId, "dismissed")).status).toBe(200);
    expect((await resolve(admin, reportId, "reviewed")).status).toBe(409);
    const row = await db.query.reports.findFirst({ where: eq(reports.id, reportId) });
    expect(row?.status).toBe("dismissed");
  }, 30_000);

  test("concurrent resolves: exactly one 200 per round, stored status is the winner's", async () => {
    let violations = 0;
    for (let round = 0; round < 5; round++) {
      const { reportId, admin } = await setup();
      const [a, b] = await Promise.all([resolve(admin, reportId, "reviewed"), resolve(admin, reportId, "dismissed")]);
      const statuses = [a.status, b.status].sort((x, y) => x - y);
      const row = await db.query.reports.findFirst({ where: eq(reports.id, reportId) });
      const winnerStatus = a.status === 200 ? "reviewed" : "dismissed";
      if (!(statuses[0] === 200 && statuses[1] === 409) || row?.status !== winnerStatus) violations++;
    }
    expect(violations).toBe(0);
  }, 60_000);
});

// --------------------------------------------------------- console events ---

describe("AIV-CONSOLE-RESOLVE-RERESOLVE-001 — a console event stays resolved as first resolved", () => {
  async function makeEvent(ownerId: string, agentId: string) {
    const [ev] = await db
      .insert(consoleEvents)
      .values({ agentId, ownerId, severity: "attention", summary: `guarded-transitions ${uniq()}` })
      .returning();
    return ev.id as string;
  }
  const resolveEvent = (token: string, id: string) =>
    app.request(`/owners/console-events/${id}/resolve`, { method: "POST", headers: json(token) });

  test("control: first resolve works and a foreign owner gets 404 with no state change", async () => {
    await resetMemoryStoreForTests();
    const a = await registerAgent("GTCeCtlA" + uniq().slice(-4));
    const b = await registerAgent("GTCeCtlB" + uniq().slice(-4));
    const evId = await makeEvent(a.ownerId, a.agentId);
    expect((await resolveEvent(b.ownerToken, evId)).status).toBe(404);
    const before = await db.query.consoleEvents.findFirst({ where: eq(consoleEvents.id, evId) });
    expect(before?.resolvedAt).toBeNull();
    expect((await resolveEvent(a.ownerToken, evId)).status).toBe(200);
    const after = await db.query.consoleEvents.findFirst({ where: eq(consoleEvents.id, evId) });
    expect(after?.resolvedAt).not.toBeNull();
  }, 30_000);

  test("sequential: a second resolve is refused and cannot rewrite the original resolvedAt", async () => {
    await resetMemoryStoreForTests();
    const a = await registerAgent("GTCeSeq" + uniq().slice(-4));
    const evId = await makeEvent(a.ownerId, a.agentId);
    expect((await resolveEvent(a.ownerToken, evId)).status).toBe(200);
    const original = new Date("2020-01-01T00:00:00.000Z");
    await db.update(consoleEvents).set({ resolvedAt: original }).where(eq(consoleEvents.id, evId));
    expect((await resolveEvent(a.ownerToken, evId)).status).toBe(409);
    const after = await db.query.consoleEvents.findFirst({ where: eq(consoleEvents.id, evId) });
    expect(after?.resolvedAt?.getTime()).toBe(original.getTime());
  }, 30_000);

  test("concurrent: concurrent resolves produce exactly one winner per round", async () => {
    await resetMemoryStoreForTests();
    const a = await registerAgent("GTCeRace" + uniq().slice(-4));
    let violatingRounds = 0;
    for (let round = 0; round < 5; round++) {
      const evId = await makeEvent(a.ownerId, a.agentId);
      const results = await Promise.all(Array.from({ length: 5 }, () => resolveEvent(a.ownerToken, evId)));
      const winners = results.filter((r) => r.status === 200).length;
      if (winners !== 1) violatingRounds++;
    }
    expect(violatingRounds).toBe(0);
  }, 60_000);
});
