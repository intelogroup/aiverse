import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../app";
import { db } from "../db/client";
import { sql } from "drizzle-orm";

// FEEFARM re-proof (2026-11-26): the AIV-COLL-FEEFARM scenario replayed
// against the fee-from-bounty fix (Jim's pick). Same ring shape as the
// original proof — poster, worker, critic under three owners, one 20cr
// task, reject cycles. The invariant flips: where the original proof
// measured supply GROWING (50 → 80), this asserts supply is CONSERVED at
// every step and the farm terminates — the ring can only ever move the
// poster's own escrow to the critic, then the task dies.

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
  const email = `feefix-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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

async function seed(agentId: string, role: string, balance: number) {
  await db.execute(sql`
    INSERT INTO bazaar_roles (agent_id, role) VALUES (${agentId}::uuid, ${role})
    ON CONFLICT (agent_id) DO UPDATE SET role = EXCLUDED.role`);
  await db.execute(sql`
    INSERT INTO bazaar_balances (agent_id, balance) VALUES (${agentId}::uuid, ${balance})
    ON CONFLICT (agent_id) DO UPDATE SET balance = ${balance}`);
}

async function balance(agentId: string): Promise<number> {
  const rows = (await db.execute(sql`SELECT balance FROM bazaar_balances WHERE agent_id = ${agentId}::uuid`)) as unknown as Array<{ balance: number }>;
  return rows[0]?.balance ?? 0;
}

describe("FEEFARM re-proof: fee from bounty", () => {
  test("reject cycles conserve supply and the farm terminates", async () => {
    const poster = await registerAgent(`feefix-poster-${R}`);
    const worker = await registerAgent(`feefix-worker-${R}`);
    const critic = await registerAgent(`feefix-critic-${R}`);
    await seed(poster.agentId, "artisan", 50);
    await seed(worker.agentId, "scout", 0);
    await seed(critic.agentId, "critic", 0);

    const supply = async (taskId: string) => {
      const t = (await db.execute(sql`SELECT status, bounty FROM bazaar_tasks WHERE id = ${taskId}::uuid`)) as unknown as Array<{ status: string; bounty: number }>;
      const held = ["open", "claimed", "completed"].includes(t[0].status) ? t[0].bounty : 0;
      return (await balance(poster.agentId)) + (await balance(worker.agentId)) + (await balance(critic.agentId)) + held;
    };

    const post = await app.request("/bazaar/tasks", {
      method: "POST",
      headers: auth(poster.agentToken),
      body: JSON.stringify({ title: `feefarm re-proof ${R}`, description: "same farm, fixed economics", bounty_credits: 20 }),
    });
    expect(post.status).toBe(201);
    const { task } = await post.json();
    expect(await supply(task.id)).toBe(50);

    // Reject cycles: each draws the 2cr fee from the escrow. After 9 the
    // escrow is 2; the 10th consumes it and the task closes as canceled.
    for (let cycle = 1; cycle <= 10; cycle++) {
      expect((await app.request(`/bazaar/tasks/${task.id}/claim`, { method: "POST", headers: auth(worker.agentToken) })).status).toBe(200);
      expect((await app.request(`/bazaar/tasks/${task.id}/complete`, { method: "POST", headers: auth(worker.agentToken), body: JSON.stringify({ evidence: `farm cycle ${cycle}` }) })).status).toBe(200);
      expect((await app.request(`/bazaar/tasks/${task.id}/verify`, { method: "POST", headers: auth(critic.agentToken), body: JSON.stringify({ verdict: "reject" }) })).status).toBe(200);
      expect(await supply(task.id)).toBe(50); // conserved at every step
      console.log(`[feefix] cycle ${cycle}: critic=${await balance(critic.agentId)} supply=50`);
    }
    const finalRow = (await db.execute(sql`SELECT status FROM bazaar_tasks WHERE id = ${task.id}::uuid`)) as unknown as Array<{ status: string }>;
    expect(finalRow[0].status).toBe("canceled"); // escrow exhausted → farm dead
    expect(await balance(critic.agentId)).toBe(20); // exactly the poster's own escrow, no more
    expect(await balance(poster.agentId)).toBe(30);
    expect(await balance(worker.agentId)).toBe(0);
    // An 11th cycle is impossible: nothing left to claim.
    expect((await app.request(`/bazaar/tasks/${task.id}/claim`, { method: "POST", headers: auth(worker.agentToken) })).status).not.toBe(200);

    // Stale cycle on a fresh task: the 10cr escalated fee also comes out
    // of the escrow; the cancel then refunds exactly the remainder.
    const post2 = await app.request("/bazaar/tasks", {
      method: "POST",
      headers: auth(poster.agentToken),
      body: JSON.stringify({ title: `feefix stale ${R}`, description: "stale fee from escrow", bounty_credits: 20 }),
    });
    const { task: task2 } = await post2.json();
    expect((await app.request(`/bazaar/tasks/${task2.id}/claim`, { method: "POST", headers: auth(worker.agentToken) })).status).toBe(200);
    expect((await app.request(`/bazaar/tasks/${task2.id}/complete`, { method: "POST", headers: auth(worker.agentToken), body: JSON.stringify({ evidence: "stale work" }) })).status).toBe(200);
    await db.execute(sql`UPDATE bazaar_tasks SET completed_at = now() - interval '121 minutes' WHERE id = ${task2.id}::uuid`);
    const criticBefore = await balance(critic.agentId);
    expect((await app.request(`/bazaar/tasks/${task2.id}/verify`, { method: "POST", headers: auth(critic.agentToken), body: JSON.stringify({ verdict: "reject" }) })).status).toBe(200);
    expect(await balance(critic.agentId)).toBe(criticBefore + 10); // capped fee, from escrow
    expect(await supply(task2.id)).toBe(50);
    const cancel = await app.request(`/bazaar/tasks/${task2.id}/cancel`, { method: "POST", headers: auth(poster.agentToken) });
    expect(cancel.status).toBe(200);
    expect((await cancel.json()).refunded).toBe(10); // 20 − 10 fee, exactly
    expect(await supply(task2.id)).toBe(50);
  });
});
