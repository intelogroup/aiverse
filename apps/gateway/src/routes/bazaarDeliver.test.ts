import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../app";
import { db } from "../db/client";
import { sql } from "drizzle-orm";

// POST /bazaar/tasks/:id/deliver — atomic delivery (item transfer + task
// completion in one transaction). Motivated by the 2026-11-26 open-day dry
// run: agents transferred items and never took the separate /complete step,
// so no escrow ever settled. These tests pin the atomicity contract: both
// halves land or neither does.

const PRIOR_BAZAAR_MODE = process.env.AIVERSE_BAZAAR_MODE;
process.env.AIVERSE_BAZAAR_MODE = "1";
const app = createApp();

afterAll(() => {
  if (PRIOR_BAZAAR_MODE === undefined) delete process.env.AIVERSE_BAZAAR_MODE;
  else process.env.AIVERSE_BAZAAR_MODE = PRIOR_BAZAAR_MODE;
});

beforeAll(async () => {
  const schemaPath = join(import.meta.dir, "../../../../experiments/bazaar/schema.sql");
  const withoutComments = readFileSync(schemaPath, "utf-8")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
  for (const stmt of withoutComments.split(";").map((s) => s.trim()).filter(Boolean)) {
    await db.execute(sql.raw(stmt));
  }
});

function rows(r: unknown): any[] {
  return ((r as any).rows ?? r) as any[];
}

async function registerAgent(name: string): Promise<{ agentToken: string; agentId: string; ownerToken: string }> {
  const email = `deliver-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
  return { agentToken: agentToken as string, agentId: agent.id as string, ownerToken: ownerToken as string };
}

async function setupBazaar(agentId: string, role: string, balance: number) {
  await db.execute(sql`
    INSERT INTO bazaar_roles (agent_id, role) VALUES (${agentId}::uuid, ${role})
    ON CONFLICT (agent_id) DO UPDATE SET role = ${role}
  `);
  await db.execute(sql`
    INSERT INTO bazaar_balances (agent_id, balance) VALUES (${agentId}::uuid, ${balance})
    ON CONFLICT (agent_id) DO UPDATE SET balance = ${balance}
  `);
}

async function getBalance(agentId: string): Promise<number> {
  const r = await db.execute(sql`SELECT balance FROM bazaar_balances WHERE agent_id = ${agentId}::uuid`);
  const rr = rows(r);
  return rr.length ? Number(rr[0].balance) : 0;
}

async function giveItem(agentId: string, name: string): Promise<{ id: string; revision: number }> {
  const r = await db.execute(sql`
    INSERT INTO verse_inventory (agent_id, name) VALUES (${agentId}::uuid, ${name})
    RETURNING id, revision
  `);
  const row = rows(r)[0];
  return { id: row.id, revision: Number(row.revision) };
}

async function itemOwner(itemId: string): Promise<{ agent_id: string; revision: number } | null> {
  const r = await db.execute(sql`SELECT agent_id, revision FROM verse_inventory WHERE id = ${itemId}::uuid`);
  const rr = rows(r);
  return rr.length ? { agent_id: rr[0].agent_id, revision: Number(rr[0].revision) } : null;
}

async function taskRow(taskId: string): Promise<any> {
  const r = await db.execute(sql`SELECT status, evidence FROM bazaar_tasks WHERE id = ${taskId}::uuid`);
  return rows(r)[0];
}

const auth = (token: string) => ({ "content-type": "application/json", authorization: `Bearer ${token}` });

// Poster posts a delivery task; seller (holding the item) claims it.
// Returns everything a deliver call needs.
async function claimedDelivery(bounty = 40) {
  const poster = await registerAgent(`DLV-Poster-${Math.random().toString(36).slice(2, 6)}`);
  const seller = await registerAgent(`DLV-Seller-${Math.random().toString(36).slice(2, 6)}`);
  await setupBazaar(poster.agentId, "artisan", 100);
  await setupBazaar(seller.agentId, "artisan", 10);
  const item = await giveItem(seller.agentId, "Copper Kettle");
  const post = await app.request("/bazaar/tasks", {
    method: "POST",
    headers: auth(poster.agentToken),
    body: JSON.stringify({ title: "Deliver Copper Kettle to me", description: "Bring the kettle to the poster, please.", bounty_credits: bounty }),
  });
  expect(post.status).toBe(201);
  const { task } = await post.json();
  const claim = await app.request(`/bazaar/tasks/${task.id}/claim`, { method: "POST", headers: auth(seller.agentToken) });
  expect(claim.status).toBe(200);
  return { poster, seller, item, taskId: task.id as string, bounty };
}

function deliver(token: string, taskId: string, body: unknown) {
  return app.request(`/bazaar/tasks/${taskId}/deliver`, {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify(body),
  });
}

describe("bazaar deliver (atomic delivery + completion)", () => {
  test("happy path: item moves to poster, task completes, escrow settles on verify", async () => {
    const { poster, seller, item, taskId, bounty } = await claimedDelivery();
    const res = await deliver(seller.agentToken, taskId, { item_id: item.id, revision: item.revision });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task.status).toBe("completed");
    expect(body.item.name).toBe("Copper Kettle");

    const owner = await itemOwner(item.id);
    expect(owner?.agent_id).toBe(poster.agentId);
    expect(owner?.revision).toBe(item.revision + 1);
    const t = await taskRow(taskId);
    expect(t.status).toBe("completed");
    expect(t.evidence).toContain("Copper Kettle");

    // The settlement the open day never reached: critic accepts, escrow pays
    // out of the held bounty (claimer bounty − fee, critic fee), supply conserved.
    const critic = await registerAgent(`DLV-Critic-${Math.random().toString(36).slice(2, 6)}`);
    await setupBazaar(critic.agentId, "critic", 0);
    const verify = await app.request(`/bazaar/tasks/${taskId}/verify`, {
      method: "POST",
      headers: auth(critic.agentToken),
      body: JSON.stringify({ verdict: "accept" }),
    });
    expect(verify.status).toBe(200);
    const sellerBal = await getBalance(seller.agentId);
    const criticBal = await getBalance(critic.agentId);
    const posterBal = await getBalance(poster.agentId);
    expect(sellerBal).toBeGreaterThan(10);
    expect(sellerBal).toBeLessThanOrEqual(10 + bounty);
    expect(posterBal).toBe(100 - bounty);
    expect(sellerBal - 10 + criticBal).toBe(bounty); // payout + fee == held bounty, nothing minted
  });

  test("wrong claimer cannot deliver: 409, item and task untouched", async () => {
    const { seller, item, taskId } = await claimedDelivery();
    const stranger = await registerAgent(`DLV-Stranger-${Math.random().toString(36).slice(2, 6)}`);
    await setupBazaar(stranger.agentId, "artisan", 0);
    const res = await deliver(stranger.agentToken, taskId, { item_id: item.id, revision: item.revision });
    expect(res.status).toBe(409);
    expect((await itemOwner(item.id))?.agent_id).toBe(seller.agentId);
    expect((await taskRow(taskId)).status).toBe("claimed");
  });

  test("poster cannot deliver their own claimed-by-other task", async () => {
    const { poster, item, taskId } = await claimedDelivery();
    const res = await deliver(poster.agentToken, taskId, { item_id: item.id, revision: item.revision });
    expect(res.status).toBe(409);
    expect((await taskRow(taskId)).status).toBe("claimed");
  });

  test("stale revision: 409 and NOTHING settles — task stays claimed, item stays held", async () => {
    const { seller, item, taskId } = await claimedDelivery();
    const res = await deliver(seller.agentToken, taskId, { item_id: item.id, revision: item.revision + 5 });
    expect(res.status).toBe(409);
    const owner = await itemOwner(item.id);
    expect(owner?.agent_id).toBe(seller.agentId);
    expect(owner?.revision).toBe(item.revision);
    expect((await taskRow(taskId)).status).toBe("claimed");
  });

  test("item held by someone else: 409, nothing moves", async () => {
    const { poster, seller, taskId } = await claimedDelivery();
    const foreign = await giveItem(poster.agentId, "Brass Lantern");
    const res = await deliver(seller.agentToken, taskId, { item_id: foreign.id, revision: foreign.revision });
    expect(res.status).toBe(409);
    expect((await itemOwner(foreign.id))?.agent_id).toBe(poster.agentId);
    expect((await taskRow(taskId)).status).toBe("claimed");
  });

  test("double deliver: second call 409s, item stays with the poster", async () => {
    const { poster, seller, item, taskId } = await claimedDelivery();
    const first = await deliver(seller.agentToken, taskId, { item_id: item.id, revision: item.revision });
    expect(first.status).toBe(200);
    const second = await deliver(seller.agentToken, taskId, { item_id: item.id, revision: item.revision + 1 });
    expect(second.status).toBe(409);
    expect((await itemOwner(item.id))?.agent_id).toBe(poster.agentId);
    expect((await taskRow(taskId)).status).toBe("completed");
  });

  test("missing item_id or revision: 400", async () => {
    const { seller, item, taskId } = await claimedDelivery();
    expect((await deliver(seller.agentToken, taskId, { revision: 0 })).status).toBe(400);
    expect((await deliver(seller.agentToken, taskId, { item_id: item.id })).status).toBe(400);
    expect((await taskRow(taskId)).status).toBe("claimed");
  });
});
