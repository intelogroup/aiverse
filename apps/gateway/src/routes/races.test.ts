import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../app";
import { db } from "../db/client";
import { sql } from "drizzle-orm";
import { claimStipends } from "../world/agentEconomy";

// RACE DAY (2026-11-26, Jim-approved). The money paths claim transactional
// safety; the behavior batteries test one request at a time. These races
// fire truly concurrent requests and grade the invariants: exactly one
// winner, escrow conserved, stipends credited exactly once. (Concurrent
// verify and concurrent complete are already covered in bazaar.test.ts;
// these four are not.)

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

const R = Math.random().toString(36).slice(2, 8);
const auth = (token: string) => ({ "content-type": "application/json", authorization: `Bearer ${token}` });

async function registerAgent(name: string): Promise<{ agentToken: string; agentId: string }> {
  const email = `race-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
  return { agentToken: agentToken as string, agentId: agent.id as string };
}

async function seedBazaar(agentId: string, role: string, balance: number) {
  await db.execute(sql`
    INSERT INTO bazaar_roles (agent_id, role) VALUES (${agentId}::uuid, ${role})
    ON CONFLICT (agent_id) DO UPDATE SET role = EXCLUDED.role`);
  await db.execute(sql`
    INSERT INTO bazaar_balances (agent_id, balance) VALUES (${agentId}::uuid, ${balance})
    ON CONFLICT (agent_id) DO UPDATE SET balance = ${balance}`);
}

async function bazaarBalance(agentId: string): Promise<number> {
  const rows = (await db.execute(sql`SELECT balance FROM bazaar_balances WHERE agent_id = ${agentId}::uuid`)) as unknown as Array<{ balance: number }>;
  return rows[0]?.balance ?? 0;
}

async function postTask(poster: { agentToken: string }, title: string, bounty = 20): Promise<string> {
  const res = await app.request("/bazaar/tasks", {
    method: "POST",
    headers: auth(poster.agentToken),
    body: JSON.stringify({ title, description: "race probe, nothing real", bounty_credits: bounty }),
  });
  expect(res.status).toBe(201);
  const { task } = await res.json();
  return task.id as string;
}

describe("RACE DAY", () => {
  test("double-claim: exactly one worker wins the task", async () => {
    const poster = await registerAgent(`race-poster-${R}`);
    const w1 = await registerAgent(`race-w1-${R}`);
    const w2 = await registerAgent(`race-w2-${R}`);
    await seedBazaar(poster.agentId, "artisan", 50);
    await seedBazaar(w1.agentId, "scout", 0);
    await seedBazaar(w2.agentId, "scout", 0);
    const taskId = await postTask(poster, `double-claim ${R}`);

    const [r1, r2] = await Promise.all([
      app.request(`/bazaar/tasks/${taskId}/claim`, { method: "POST", headers: auth(w1.agentToken) }),
      app.request(`/bazaar/tasks/${taskId}/claim`, { method: "POST", headers: auth(w2.agentToken) }),
    ]);
    const wins = [r1.status, r2.status].filter((s) => s === 200).length;
    console.log(`[race] double-claim statuses: ${r1.status}/${r2.status}`);
    expect(wins).toBe(1);
    const rows = (await db.execute(sql`SELECT claimed_by FROM bazaar_tasks WHERE id = ${taskId}::uuid`)) as unknown as Array<{ claimed_by: string }>;
    expect(rows[0].claimed_by).toBeTruthy();
  });

  test("claim-vs-cancel: never claimed AND refunded", async () => {
    const poster = await registerAgent(`race-poster2-${R}`);
    const w = await registerAgent(`race-w3-${R}`);
    await seedBazaar(poster.agentId, "artisan", 50);
    await seedBazaar(w.agentId, "scout", 0);
    const taskId = await postTask(poster, `claim-vs-cancel ${R}`);
    expect(await bazaarBalance(poster.agentId)).toBe(30); // escrow locked

    const [claimRes, cancelRes] = await Promise.all([
      app.request(`/bazaar/tasks/${taskId}/claim`, { method: "POST", headers: auth(w.agentToken) }),
      app.request(`/bazaar/tasks/${taskId}/cancel`, { method: "POST", headers: auth(poster.agentToken) }),
    ]);
    const rows = (await db.execute(sql`SELECT status, claimed_by FROM bazaar_tasks WHERE id = ${taskId}::uuid`)) as unknown as Array<{ status: string; claimed_by: string | null }>;
    const posterNow = await bazaarBalance(poster.agentId);
    console.log(`[race] claim-vs-cancel: claim=${claimRes.status} cancel=${cancelRes.status} final=${rows[0].status} poster=${posterNow}`);
    if (rows[0].status === "canceled" || rows[0].status === "cancelled") {
      expect(rows[0].claimed_by).toBeNull();
      expect(posterNow).toBe(50); // refunded exactly once, claim lost
    } else {
      expect(rows[0].claimed_by).toBe(w.agentId);
      expect(posterNow).toBe(30); // escrow still locked, no refund
    }
  });

  test("double-cancel: escrow refunds exactly once", async () => {
    const poster = await registerAgent(`race-poster3-${R}`);
    await seedBazaar(poster.agentId, "artisan", 50);
    const taskId = await postTask(poster, `double-cancel ${R}`);
    const [c1, c2] = await Promise.all([
      app.request(`/bazaar/tasks/${taskId}/cancel`, { method: "POST", headers: auth(poster.agentToken) }),
      app.request(`/bazaar/tasks/${taskId}/cancel`, { method: "POST", headers: auth(poster.agentToken) }),
    ]);
    const posterNow = await bazaarBalance(poster.agentId);
    console.log(`[race] double-cancel statuses: ${c1.status}/${c2.status} poster=${posterNow}`);
    expect(posterNow).toBe(50); // refunded once, not twice (would be 70)
  });

  test("stipend race: 5 concurrent claims credit exactly once", async () => {
    const agent = await registerAgent(`race-stipend-${R}`);
    const now = new Date();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimStipends(agent.agentId, now)),
    );
    const credited = results.reduce((sum, r) => sum + r.credits, 0);
    const grants = results.filter((r) => r.granted !== null).length;
    const rows = (await db.execute(sql`
      SELECT source FROM verse_progress_events WHERE agent_id = ${agent.agentId}::uuid AND kind = 'stipend'`)) as unknown as Array<{ source: string }>;
    console.log(`[race] stipend race: credited=${credited} grants=${grants} rows=${rows.length} sources=${rows.map((r) => r.source).join(",")}`);
    expect(credited).toBe(1000); // first-login grant, exactly once across 5 racers
    expect(grants).toBe(1);
    expect(rows.length).toBe(1);
    // And a second concurrent batch the same day adds nothing.
    const again = await Promise.all(
      Array.from({ length: 3 }, () => claimStipends(agent.agentId, now)),
    );
    expect(again.reduce((sum, r) => sum + r.credits, 0)).toBe(0);
  });
});
