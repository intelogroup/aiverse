import { describe, expect, test, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { agentVisits } from "@aiverse/shared/schema";
import { db } from "../db/client";
import { createApp } from "../app";
import { websocket } from "../ws/gateway";
import { sweepVisits, AGENT_OFFLINE_GRACE_MS } from "../jobs/visits";
import { setPresence, clearPresence } from "../presence";

const app = createApp();
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });

afterAll(() => {
  server.stop(true);
});

function json(token?: string) {
  return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

async function ownerWithAgent(name: string) {
  const email = `visit-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", { method: "POST", headers: json(), body: JSON.stringify({ email, password: "password123" }) });
  const { token: ownerToken } = (await reg.json()) as any;
  const created = await app.request("/owners/agents", { method: "POST", headers: json(ownerToken), body: JSON.stringify({ name, capabilities: [] }) });
  const { agent, agentToken } = (await created.json()) as any;
  await app.request(`/owners/agents/${agent.id}/wallet`, { method: "PATCH", headers: json(ownerToken), body: JSON.stringify({ autonomyMode: "autonomous" }) });
  return { ownerToken: ownerToken as string, agentId: agent.id as string, agentToken: agentToken as string };
}

async function startVisit(ownerToken: string, agentId: string, minutes: number, maxActions: number) {
  return app.request(`/owners/agents/${agentId}/visits`, {
    method: "POST",
    headers: json(ownerToken),
    body: JSON.stringify({ minutes, maxActions }),
  });
}

// GET /manifest and POST /goals are convenient, harmless probes for
// "a read" and "a write" respectively — real routes agentAuth already
// protects, not visit-specific test scaffolding.
const readCall = (token: string) => app.request("/manifest", { headers: json(token) });
const writeCall = (token: string) =>
  app.request("/goals", { method: "POST", headers: json(token), body: JSON.stringify({ objective: "test objective for a visit" }) });

describe("POST /owners/agents/:id/visits", () => {
  test("validates minutes and maxActions", async () => {
    const { ownerToken, agentId } = await ownerWithAgent("VisitValidate");
    expect((await startVisit(ownerToken, agentId, 0, 10)).status).toBe(400);
    expect((await startVisit(ownerToken, agentId, 10, 0)).status).toBe(400);
    expect((await startVisit(ownerToken, agentId, 999_999, 10)).status).toBe(400);
    const ok = await startVisit(ownerToken, agentId, 30, 10);
    expect(ok.status).toBe(201);
  });

  test("only one active visit per agent at a time", async () => {
    const { ownerToken, agentId } = await ownerWithAgent("VisitOneActive");
    expect((await startVisit(ownerToken, agentId, 30, 10)).status).toBe(201);
    expect((await startVisit(ownerToken, agentId, 30, 10)).status).toBe(409);
  });

  test("a non-owner cannot start, list, or stop a visit", async () => {
    const mine = await ownerWithAgent("VisitMine");
    const outsider = await ownerWithAgent("VisitOutsider");
    expect((await startVisit(outsider.ownerToken, mine.agentId, 30, 10)).status).toBe(404);
    expect((await app.request(`/owners/agents/${mine.agentId}/visits`, { headers: json(outsider.ownerToken) })).status).toBe(404);
    const real = await startVisit(mine.ownerToken, mine.agentId, 30, 10);
    const { visit } = (await real.json()) as any;
    expect(
      (await app.request(`/owners/agents/${mine.agentId}/visits/${visit.id}/stop`, { method: "POST", headers: json(outsider.ownerToken) })).status,
    ).toBe(404);
  });
});

describe("visit enforcement: action cap", () => {
  test("GET calls never spend the budget; a non-GET call does, and hitting the cap is sticky", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("VisitCap");
    const start = await startVisit(ownerToken, agentId, 30, 1);
    expect(start.status).toBe(201);

    // Reads are free — many of them, cap of 1 untouched.
    for (let i = 0; i < 5; i++) expect((await readCall(agentToken)).status).toBe(200);

    // One write spends the single action.
    const first = await writeCall(agentToken);
    expect(first.status).toBe(201);

    // The next call of ANY kind is refused — not just writes, and not
    // reverted to unrestricted (sticky, per policy/visits.ts).
    const secondWrite = await writeCall(agentToken);
    expect(secondWrite.status).toBe(403);
    expect((await secondWrite.json()).reason).toBe("action_cap");
    const readAfter = await readCall(agentToken);
    expect(readAfter.status).toBe(403);
    expect((await readAfter.json()).reason).toBe("action_cap");

    const visits = (await (await app.request(`/owners/agents/${agentId}/visits`, { headers: json(ownerToken) })).json()) as any;
    expect(visits.visits[0].endedReason).toBe("action_cap");
    expect(visits.visits[0].actionsUsed).toBe(1);
  });
});

describe("visit enforcement: time window", () => {
  test("a visit past its deadline refuses the next call and stays refused", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("VisitDeadline");
    const start = await startVisit(ownerToken, agentId, 30, 100);
    const { visit } = (await start.json()) as any;
    expect((await readCall(agentToken)).status).toBe(200);

    // Force the deadline into the past — no real test should sleep 30 minutes.
    await db.update(agentVisits).set({ endsAt: new Date(Date.now() - 1000) }).where(eq(agentVisits.id, visit.id));

    const afterExpiry = await readCall(agentToken);
    expect(afterExpiry.status).toBe(403);
    expect((await afterExpiry.json()).reason).toBe("time_expired");
    // Sticky: a second call afterward is still refused, from the row's own
    // stored reason, not a fresh deadline re-check.
    expect((await readCall(agentToken)).status).toBe(403);
  });
});

describe("POST /owners/agents/:id/visits/:visitId/stop", () => {
  test("an owner can end a visit early; the agent is refused afterward", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("VisitStop");
    const start = await startVisit(ownerToken, agentId, 30, 100);
    const { visit } = (await start.json()) as any;
    expect((await readCall(agentToken)).status).toBe(200);

    const stop = await app.request(`/owners/agents/${agentId}/visits/${visit.id}/stop`, { method: "POST", headers: json(ownerToken) });
    expect(stop.status).toBe(200);

    expect((await readCall(agentToken)).status).toBe(403);

    // Stopping an already-ended visit is a 409, not a silent success.
    const stopAgain = await app.request(`/owners/agents/${agentId}/visits/${visit.id}/stop`, { method: "POST", headers: json(ownerToken) });
    expect(stopAgain.status).toBe(409);
  });
});

describe("an agent that never had a visit is unrestricted", () => {
  test("no visit row at all — every call behaves exactly as before this feature", async () => {
    const { agentToken } = await ownerWithAgent("VisitNever");
    expect((await readCall(agentToken)).status).toBe(200);
    expect((await writeCall(agentToken)).status).toBe(201);
    expect((await writeCall(agentToken)).status).toBe(201);
  });
});

describe("WS connect refuses an agent whose visit has ended", () => {
  test("a ticket issued before the visit ended is still refused at connect time", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("VisitWs");
    const start = await startVisit(ownerToken, agentId, 30, 100);
    const { visit } = (await start.json()) as any;

    // Ticket issued while the visit is still active — agentAuth on
    // /auth/ws-ticket itself would otherwise refuse it before it's even
    // minted, which is correct but tests a different check than the WS
    // connect handler's own (ws/gateway.ts's onOpen).
    const ticketRes = await app.request("/auth/ws-ticket", { method: "POST", headers: json(agentToken) });
    expect(ticketRes.status).toBe(201);
    const { ticket } = (await ticketRes.json()) as any;

    await app.request(`/owners/agents/${agentId}/visits/${visit.id}/stop`, { method: "POST", headers: json(ownerToken) });

    const ws = new WebSocket(`ws://localhost:${server.port}/agents/ws?ticket=${ticket}`);
    const closeCode = await new Promise<number>((resolve) => {
      ws.onclose = (e) => resolve(e.code);
    });
    expect(closeCode).toBe(4008);
  });
});

describe("sweepVisits", () => {
  test("ends a visit past its deadline with no request ever arriving", async () => {
    const { ownerToken, agentId } = await ownerWithAgent("VisitSweepDeadline");
    const start = await startVisit(ownerToken, agentId, 30, 100);
    const { visit } = (await start.json()) as any;
    await db.update(agentVisits).set({ endsAt: new Date(Date.now() - 1000) }).where(eq(agentVisits.id, visit.id));

    const result = await sweepVisits();
    expect(result.endedByDeadlineOrCap).toBeGreaterThanOrEqual(1);

    const row = await db.query.agentVisits.findFirst({ where: eq(agentVisits.id, visit.id) });
    expect(row?.endedReason).toBe("time_expired");
  });

  test("ends a visit whose agent's presence has lapsed past the grace period", async () => {
    const { ownerToken, agentId } = await ownerWithAgent("VisitSweepPresence");
    const start = await startVisit(ownerToken, agentId, 30, 100);
    const { visit } = (await start.json()) as any;
    await clearPresence(agentId);

    // First sweep: agent offline, no prior offlineSince — starts the clock,
    // does not end the visit yet.
    await sweepVisits();
    let row = await db.query.agentVisits.findFirst({ where: eq(agentVisits.id, visit.id) });
    expect(row?.endedAt).toBeNull();
    expect(row?.offlineSince).not.toBeNull();

    // A tick where the agent IS online clears the clock instead of ending it.
    await setPresence(agentId);
    await sweepVisits();
    row = await db.query.agentVisits.findFirst({ where: eq(agentVisits.id, visit.id) });
    expect(row?.offlineSince).toBeNull();
    expect(row?.endedAt).toBeNull();
    await clearPresence(agentId);

    // Back offline, and simulate the grace period having already elapsed
    // (real test can't wait 10 real minutes) by backdating offlineSince.
    await sweepVisits();
    await db
      .update(agentVisits)
      .set({ offlineSince: new Date(Date.now() - AGENT_OFFLINE_GRACE_MS - 1000) })
      .where(eq(agentVisits.id, visit.id));

    const result = await sweepVisits();
    expect(result.endedByPresence).toBeGreaterThanOrEqual(1);
    row = await db.query.agentVisits.findFirst({ where: eq(agentVisits.id, visit.id) });
    expect(row?.endedReason).toBe("presence_expired");
  });
});
