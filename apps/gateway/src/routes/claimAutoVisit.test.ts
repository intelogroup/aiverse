import { describe, expect, test, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { agentVisits, owners } from "@aiverse/shared/schema";
import { db } from "../db/client";
import { createApp } from "../app";
import { websocket } from "../ws/gateway";
import { resetMemoryStoreForTests } from "../policy/memoryStore";
import { STARTER_VISIT_MINUTES, STARTER_VISIT_ACTIONS } from "../policy/visits";

// Claim is where signup becomes presence (2026-11-10): the gateway
// auto-starts a starter visit in the claim response so the agent can
// take a body with zero further owner calls. These tests pin the four
// contract points: it starts, it never double-starts, its failure never
// fails the claim, and owner-create (POST /owners/agents) does NOT
// auto-start — provision.ts creates agents there and starts its own
// budgeted visit, which an auto-visit would 409.

const app = createApp();
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });

afterAll(() => {
  server.stop(true);
});

beforeEach(async () => {
  // The claim route is rate-limited per IP (5/15min, one shared
  // "unknown" bucket under app.request) — reset or later files starve.
  await resetMemoryStoreForTests();
});

function json(token?: string) {
  return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function makeOwner() {
  const email = `claim-auto-${uniq()}@example.com`;
  const reg = await app.request("/owners/register", {
    method: "POST",
    headers: json(),
    body: JSON.stringify({ email, password: "password123" }),
  });
  expect(reg.status).toBe(201);
  const { token } = (await reg.json()) as any;
  const owner = await db.query.owners.findFirst({ where: eq(owners.email, email) });
  return { ownerToken: token as string, ownerId: owner!.id as string };
}

async function selfRegisteredAgent(name: string) {
  const reg = await app.request("/agents/register", {
    method: "POST",
    headers: json(),
    body: JSON.stringify({ name }),
  });
  expect(reg.status).toBe(201);
  return (await reg.json()) as { agentId: string; agentToken: string; claimCode: string };
}

async function claim(ownerToken: string, claimCode: string) {
  return app.request("/owners/agents/claim", {
    method: "POST",
    headers: json(ownerToken),
    body: JSON.stringify({ claimCode }),
  });
}

async function listVisits(ownerToken: string, agentId: string) {
  const res = await app.request(`/owners/agents/${agentId}/visits`, { headers: json(ownerToken) });
  expect(res.status).toBe(200);
  return ((await res.json()) as any).visits as any[];
}

describe("POST /owners/agents/claim auto-visit", () => {
  test("claim auto-starts a starter visit with the starter defaults", async () => {
    const { ownerToken } = await makeOwner();
    const reg = await selfRegisteredAgent(`ClaimAutoStart-${uniq()}`);

    const res = await claim(ownerToken, reg.claimCode);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.agent.id).toBe(reg.agentId);
    expect(body.visit).not.toBeNull();
    expect(body.visit.agentId).toBe(reg.agentId);
    expect(body.visit.maxActions).toBe(STARTER_VISIT_ACTIONS);
    expect(body.visit.endedAt).toBeNull();
    const windowMs = new Date(body.visit.endsAt).getTime() - new Date(body.visit.startedAt).getTime();
    expect(windowMs).toBeGreaterThan((STARTER_VISIT_MINUTES - 1) * 60_000);
    expect(windowMs).toBeLessThan((STARTER_VISIT_MINUTES + 1) * 60_000);

    const visits = await listVisits(ownerToken, reg.agentId);
    expect(visits).toHaveLength(1);
    expect(visits[0].id).toBe(body.visit.id);
  });

  test("claim does not double-start when a visit is already active", async () => {
    const { ownerToken, ownerId } = await makeOwner();
    const reg = await selfRegisteredAgent(`ClaimNoDouble-${uniq()}`);

    // An already-active visit row for this agent (the state the
    // auto-start must respect rather than stack a second visit on).
    const [existing] = await db
      .insert(agentVisits)
      .values({ agentId: reg.agentId, ownerId, endsAt: new Date(Date.now() + 45 * 60_000), maxActions: 50 })
      .returning();

    const res = await claim(ownerToken, reg.claimCode);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.visit?.id).toBe(existing.id);

    const visits = await listVisits(ownerToken, reg.agentId);
    expect(visits).toHaveLength(1);
    expect(visits[0].id).toBe(existing.id);
  });

  test("an auto-start failure leaves the claim successful", async () => {
    const { ownerToken } = await makeOwner();
    const reg = await selfRegisteredAgent(`ClaimAutoFail-${uniq()}`);

    // Inject the failure at exactly the visit insert — every other
    // insert in the claim path (audit rows) must still succeed.
    const originalInsert = db.insert.bind(db);
    (db as any).insert = (table: any) => {
      if (table === agentVisits) throw new Error("injected visit insert failure");
      return originalInsert(table);
    };
    let res: Response;
    try {
      res = await claim(ownerToken, reg.claimCode);
    } finally {
      (db as any).insert = originalInsert;
    }

    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.agent.id).toBe(reg.agentId);
    expect(body.visit).toBeNull();
    expect(body.visitError).toContain("injected visit insert failure");

    // The claim really committed — the agent is owned, with no visit.
    expect(await listVisits(ownerToken, reg.agentId)).toHaveLength(0);
  });

  test("a repeat claim by the same owner returns the current state instead of 404 (retry-safe claim)", async () => {
    const { ownerToken } = await makeOwner();
    const reg = await selfRegisteredAgent(`ClaimRetry-${uniq()}`);

    const first = await claim(ownerToken, reg.claimCode);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as any;

    // The response was "lost" — the owner retries with the same code.
    const retry = await claim(ownerToken, reg.claimCode);
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as any;
    expect(retryBody.alreadyClaimed).toBe(true);
    expect(retryBody.agent.id).toBe(reg.agentId);
    expect(retryBody.visit?.id).toBe(firstBody.visit.id); // the same starter visit, not a new one
    expect(await listVisits(ownerToken, reg.agentId)).toHaveLength(1);
  });

  test("a repeat claim by a DIFFERENT owner is still a plain 404 (the tombstone leaks nothing)", async () => {
    const { ownerToken } = await makeOwner();
    const { ownerToken: strangerToken } = await makeOwner();
    const reg = await selfRegisteredAgent(`ClaimStranger-${uniq()}`);

    expect((await claim(ownerToken, reg.claimCode)).status).toBe(200);
    const stranger = await claim(strangerToken, reg.claimCode);
    expect(stranger.status).toBe(404);
    expect(((await stranger.json()) as any).alreadyClaimed).toBeUndefined();
  });

  test("owner-create does NOT auto-start a visit", async () => {
    const { ownerToken } = await makeOwner();
    const created = await app.request("/owners/agents", {
      method: "POST",
      headers: json(ownerToken),
      body: JSON.stringify({ name: `OwnerCreateNoAuto-${uniq()}`, capabilities: [] }),
    });
    expect(created.status).toBe(201);
    const { agent } = (await created.json()) as any;
    expect(await listVisits(ownerToken, agent.id)).toHaveLength(0);
  });
});
