import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { createApp } from "../app";
import { db } from "../db/client";
import { sql } from "drizzle-orm";

// Bazaar route tests — run against the isolated test DB only.
// These verify the accounting hardening: atomic verify, no double-pay,
// solvent delegation settlement.

const app = createApp();

async function registerAgent(name: string): Promise<{ agentToken: string; agentId: string; ownerToken: string }> {
  const email = `bazaar-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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

async function enableWallet(ownerToken: string, agentId: string) {
  // A2A message/send requires a caller wallet row to exist.
  await app.request(`/owners/agents/${agentId}/wallet`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ autonomyMode: "autonomous" }),
  });
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

function rows(r: unknown): any[] {
  return ((r as any).rows ?? r) as any[];
}

async function getBalance(agentId: string): Promise<number> {
  const r = await db.execute(sql`SELECT balance FROM bazaar_balances WHERE agent_id = ${agentId}::uuid`);
  const rows = (r as any).rows ?? r;
  return rows.length ? Number(rows[0].balance) : 0;
}

const auth = (token: string) => ({ "content-type": "application/json", authorization: `Bearer ${token}` });

describe("bazaar accounting", () => {
  let poster: { agentToken: string; agentId: string };
  let worker: { agentToken: string; agentId: string };
  let critic: { agentToken: string; agentId: string };

  beforeAll(async () => {
    poster = await registerAgent("bazaar-poster");
    worker = await registerAgent("bazaar-worker");
    critic = await registerAgent("bazaar-critic");
    await setupBazaar(poster.agentId, "broker", 100);
    await setupBazaar(worker.agentId, "artisan", 100);
    await setupBazaar(critic.agentId, "critic", 100);
  });

  test("post escrows bounty from poster balance", async () => {
    const res = await app.request("/bazaar/tasks", {
      method: "POST",
      headers: auth(poster.agentToken),
      body: JSON.stringify({ title: "Write a haiku", description: "A haiku about markets, 5-7-5 syllables", bounty_credits: 10 }),
    });
    expect(res.status).toBe(201);
    expect(await getBalance(poster.agentId)).toBe(90);
  });

  test("post fails with insufficient balance", async () => {
    const res = await app.request("/bazaar/tasks", {
      method: "POST",
      headers: auth(poster.agentToken),
      body: JSON.stringify({ title: "Expensive", description: "Too rich for my blood", bounty_credits: 1000 }),
    });
    expect(res.status).toBe(400); // over MAX_BOUNTY
  });

  test("full cycle: claim → complete → verify(accept) → payout", async () => {
    // Post
    const postRes = await app.request("/bazaar/tasks", {
      method: "POST",
      headers: auth(poster.agentToken),
      body: JSON.stringify({ title: "Cycle test", description: "Full cycle verification test", bounty_credits: 15 }),
    });
    const { task } = await postRes.json();
    const posterBefore = await getBalance(poster.agentId);

    // Claim
    const claimRes = await app.request(`/bazaar/tasks/${task.id}/claim`, {
      method: "POST",
      headers: auth(worker.agentToken),
    });
    expect(claimRes.status).toBe(200);

    // Complete
    const completeRes = await app.request(`/bazaar/tasks/${task.id}/complete`, {
      method: "POST",
      headers: auth(worker.agentToken),
      body: JSON.stringify({ evidence: "Did the thing, here is proof of completion" }),
    });
    expect(completeRes.status).toBe(200);

    // Verify accept
    const workerBefore = await getBalance(worker.agentId);
    const criticBefore = await getBalance(critic.agentId);
    const verifyRes = await app.request(`/bazaar/tasks/${task.id}/verify`, {
      method: "POST",
      headers: auth(critic.agentToken),
      body: JSON.stringify({ verdict: "accept", note: "Looks good" }),
    });
    expect(verifyRes.status).toBe(200);

    // Balances: worker +15, critic +2 (fee), poster unchanged (already escrowed)
    expect(await getBalance(worker.agentId)).toBe(workerBefore + 15);
    expect(await getBalance(critic.agentId)).toBe(criticBefore + 2);
    expect(await getBalance(poster.agentId)).toBe(posterBefore);
  });

  test("verify reject refunds poster and reopens task", async () => {
    const postRes = await app.request("/bazaar/tasks", {
      method: "POST",
      headers: auth(poster.agentToken),
      body: JSON.stringify({ title: "Reject test", description: "This will be rejected", bounty_credits: 12 }),
    });
    const { task } = await postRes.json();
    const posterBefore = await getBalance(poster.agentId);

    await app.request(`/bazaar/tasks/${task.id}/claim`, { method: "POST", headers: auth(worker.agentToken) });
    await app.request(`/bazaar/tasks/${task.id}/complete`, {
      method: "POST",
      headers: auth(worker.agentToken),
      body: JSON.stringify({ evidence: "Insufficient evidence here" }),
    });

    const verifyRes = await app.request(`/bazaar/tasks/${task.id}/verify`, {
      method: "POST",
      headers: auth(critic.agentToken),
      body: JSON.stringify({ verdict: "reject", note: "Not good enough" }),
    });
    expect(verifyRes.status).toBe(200);

    // Poster refunded the 12
    expect(await getBalance(poster.agentId)).toBe(posterBefore + 12);

    // Task is open again
    const listRes = await app.request("/bazaar/tasks?status=open", { headers: auth(poster.agentToken) });
    const { tasks } = await listRes.json();
    expect(tasks.some((t: any) => t.id === task.id)).toBe(true);
  });

  test("concurrent verify: exactly one payout", async () => {
    const postRes = await app.request("/bazaar/tasks", {
      method: "POST",
      headers: auth(poster.agentToken),
      body: JSON.stringify({ title: "Race test", description: "Concurrent verification race", bounty_credits: 20 }),
    });
    const { task } = await postRes.json();

    await app.request(`/bazaar/tasks/${task.id}/claim`, { method: "POST", headers: auth(worker.agentToken) });
    await app.request(`/bazaar/tasks/${task.id}/complete`, {
      method: "POST",
      headers: auth(worker.agentToken),
      body: JSON.stringify({ evidence: "Race condition test evidence" }),
    });

    // Register a second critic
    const critic2 = await registerAgent("bazaar-critic2");
    await setupBazaar(critic2.agentId, "critic", 100);

    const workerBefore = await getBalance(worker.agentId);

    // Fire two verifies concurrently
    const [r1, r2] = await Promise.all([
      app.request(`/bazaar/tasks/${task.id}/verify`, {
        method: "POST",
        headers: auth(critic.agentToken),
        body: JSON.stringify({ verdict: "accept" }),
      }),
      app.request(`/bazaar/tasks/${task.id}/verify`, {
        method: "POST",
        headers: auth(critic2.agentToken),
        body: JSON.stringify({ verdict: "accept" }),
      }),
    ]);

    // Exactly one succeeds, one gets 409
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);

    // Worker paid exactly once
    expect(await getBalance(worker.agentId)).toBe(workerBefore + 20);
  });

  test("cancel refunds escrow", async () => {
    const postRes = await app.request("/bazaar/tasks", {
      method: "POST",
      headers: auth(poster.agentToken),
      body: JSON.stringify({ title: "Cancel me", description: "This will be canceled", bounty_credits: 8 }),
    });
    const { task } = await postRes.json();
    const before = await getBalance(poster.agentId);

    const cancelRes = await app.request(`/bazaar/tasks/${task.id}/cancel`, {
      method: "POST",
      headers: auth(poster.agentToken),
    });
    expect(cancelRes.status).toBe(200);
    expect(await getBalance(poster.agentId)).toBe(before + 8);
  });

  test("non-critic cannot verify", async () => {
    const postRes = await app.request("/bazaar/tasks", {
      method: "POST",
      headers: auth(poster.agentToken),
      body: JSON.stringify({ title: "Role test", description: "Non-critic verify attempt", bounty_credits: 5 }),
    });
    const { task } = await postRes.json();
    await app.request(`/bazaar/tasks/${task.id}/claim`, { method: "POST", headers: auth(worker.agentToken) });
    await app.request(`/bazaar/tasks/${task.id}/complete`, {
      method: "POST",
      headers: auth(worker.agentToken),
      body: JSON.stringify({ evidence: "Some evidence here" }),
    });

    const res = await app.request(`/bazaar/tasks/${task.id}/verify`, {
      method: "POST",
      headers: auth(worker.agentToken), // worker, not critic
      body: JSON.stringify({ verdict: "accept" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("bazaar delegation accounting", () => {
  let payer: { agentToken: string; agentId: string; ownerToken: string };
  let payee: { agentToken: string; agentId: string; ownerToken: string };
  let critic: { agentToken: string; agentId: string; ownerToken: string };

  const rpc = (method: string, params: any) => ({ jsonrpc: "2.0", id: 1, method, params });

  async function delegate(payerToken: string, payeeId: string, messageId: string) {
    // The agent send-rate bucket is 1 msg/sec; retry briefly on 429.
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await app.request(`/a2a/agents/${payeeId}`, {
        method: "POST",
        headers: auth(payerToken),
        body: JSON.stringify(rpc("message/send", {
          message: { role: "user", parts: [{ kind: "text", text: "do the work" }], messageId },
        })),
      });
      const body = await res.json();
      if (body.result?.id) return body.result.id as string;
      if (res.status !== 429) throw new Error(`delegate failed: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("delegate failed: rate limited after retries");
  }

  async function getDelegation(a2aTaskId: string) {
    const r = await db.execute(sql`SELECT id, state, escrowed, amount FROM bazaar_delegations WHERE a2a_task_id = ${a2aTaskId}::uuid`);
    return rows(r)[0] as any;
  }

  beforeAll(async () => {
    payer = await registerAgent("bazaar-payer");
    payee = await registerAgent("bazaar-payee");
    critic = await registerAgent("bazaar-dcritic");
    await enableWallet(payer.ownerToken, payer.agentId);
    await enableWallet(payee.ownerToken, payee.agentId);
    await setupBazaar(payer.agentId, "broker", 100);
    await setupBazaar(payee.agentId, "artisan", 100);
    await setupBazaar(critic.agentId, "critic", 100);
  });

  test("offer escrows immediately; settle credits payee from escrow", async () => {
    const taskId = await delegate(payer.agentToken, payee.agentId, `esc1-${Date.now()}`);
    const payerBefore = await getBalance(payer.agentId);

    const offer = await app.request("/bazaar/delegations", {
      method: "POST",
      headers: auth(payer.agentToken),
      body: JSON.stringify({ a2a_task_id: taskId, payee_id: payee.agentId, amount: 15 }),
    });
    expect(offer.status).toBe(201);
    // Escrowed at offer time
    expect(await getBalance(payer.agentId)).toBe(payerBefore - 15);
    expect((await getDelegation(taskId)).escrowed).toBe(true);

    const payeeBefore = await getBalance(payee.agentId);
    const patch = await app.request(`/a2a/tasks/${taskId}`, {
      method: "PATCH",
      headers: auth(payee.agentToken),
      body: JSON.stringify({ state: "completed", resultMessage: "done" }),
    });
    expect(patch.status).toBe(200);

    expect((await getDelegation(taskId)).state).toBe("settled");
    expect(await getBalance(payee.agentId)).toBe(payeeBefore + 15);
    // Payer already debited at offer; settle moves escrow only
    expect(await getBalance(payer.agentId)).toBe(payerBefore - 15);
  });

  test("concurrent completes settle exactly once", async () => {
    const taskId = await delegate(payer.agentToken, payee.agentId, `esc2-${Date.now()}`);
    await app.request("/bazaar/delegations", {
      method: "POST",
      headers: auth(payer.agentToken),
      body: JSON.stringify({ a2a_task_id: taskId, payee_id: payee.agentId, amount: 10 }),
    });
    const payeeBefore = await getBalance(payee.agentId);

    // Two concurrent PATCHes to completed: the first transitions submitted→completed
    // and settles; the second gets 409 (terminal state). Payee credited once.
    const [r1, r2] = await Promise.all([
      app.request(`/a2a/tasks/${taskId}`, {
        method: "PATCH",
        headers: auth(payee.agentToken),
        body: JSON.stringify({ state: "completed", resultMessage: "done" }),
      }),
      app.request(`/a2a/tasks/${taskId}`, {
        method: "PATCH",
        headers: auth(payee.agentToken),
        body: JSON.stringify({ state: "completed", resultMessage: "done again" }),
      }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect((await getDelegation(taskId)).state).toBe("settled");
    expect(await getBalance(payee.agentId)).toBe(payeeBefore + 10);
  });

  test("bazaar tables absent (prod): a2a completion still commits", async () => {
    // Simulates prod, where the bazaar_* tables never exist. The completion
    // must persist — a missing-table error raised INSIDE the transaction
    // would abort it and turn COMMIT into a silent rollback while the
    // service still returns 200, so the table check must happen before the
    // transaction opens. Assert on the DB row itself, not just the status.
    const taskId = await delegate(payer.agentToken, payee.agentId, `nodel-${Date.now()}`);
    await db.execute(sql`ALTER TABLE bazaar_delegations RENAME TO bazaar_delegations_hidden`);
    try {
      const patch = await app.request(`/a2a/tasks/${taskId}`, {
        method: "PATCH",
        headers: auth(payee.agentToken),
        body: JSON.stringify({ state: "completed", resultMessage: "done" }),
      });
      expect(patch.status).toBe(200);
      const t = await db.execute(sql`SELECT state FROM a2a_tasks WHERE id = ${taskId}::uuid`);
      expect(rows(t)[0].state).toBe("completed");
    } finally {
      await db.execute(sql`ALTER TABLE bazaar_delegations_hidden RENAME TO bazaar_delegations`);
    }
  });

  test("insolvent offer rejected with 402, no delegation row", async () => {    const poor = await registerAgent("bazaar-poor");
    await enableWallet(poor.ownerToken, poor.agentId);
    await setupBazaar(poor.agentId, "broker", 5);
    const taskId = await delegate(poor.agentToken, payee.agentId, `esc3-${Date.now()}`);
    const offer = await app.request("/bazaar/delegations", {
      method: "POST",
      headers: auth(poor.agentToken),
      body: JSON.stringify({ a2a_task_id: taskId, payee_id: payee.agentId, amount: 50 }),
    });
    expect(offer.status).toBe(402);
    expect(await getDelegation(taskId)).toBeUndefined();
    expect(await getBalance(poor.agentId)).toBe(5);
  });

  test("concurrent offers cannot over-commit the payer (escrow race)", async () => {
    const t1 = await delegate(payer.agentToken, payee.agentId, `esc4a-${Date.now()}`);
    const t2 = await delegate(payer.agentToken, payee.agentId, `esc4b-${Date.now()}`);
    const payerBefore = await getBalance(payer.agentId);
    // Payer can afford exactly one 60-credit offer twice? No — 2x60 must fail once
    // unless balance covers both. Use amounts that exceed half the balance.
    const amount = Math.floor(payerBefore / 2) + 1;
    const [r1, r2] = await Promise.all([
      app.request("/bazaar/delegations", {
        method: "POST",
        headers: auth(payer.agentToken),
        body: JSON.stringify({ a2a_task_id: t1, payee_id: payee.agentId, amount }),
      }),
      app.request("/bazaar/delegations", {
        method: "POST",
        headers: auth(payer.agentToken),
        body: JSON.stringify({ a2a_task_id: t2, payee_id: payee.agentId, amount }),
      }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 402]);
    expect(await getBalance(payer.agentId)).toBe(payerBefore - amount);
  });

  test("ownership mismatch: payee must be the a2a task target", async () => {
    const taskId = await delegate(payer.agentToken, payee.agentId, `esc5-${Date.now()}`);
    const offer = await app.request("/bazaar/delegations", {
      method: "POST",
      headers: auth(payer.agentToken),
      body: JSON.stringify({ a2a_task_id: taskId, payee_id: critic.agentId, amount: 5 }),
    });
    expect(offer.status).toBe(403);
    expect(await getDelegation(taskId)).toBeUndefined();
  });

  test("legacy non-escrowed delegation: insolvent payer fails, creates no money", async () => {
    const poor = await registerAgent("bazaar-poor2");
    await enableWallet(poor.ownerToken, poor.agentId);
    await setupBazaar(poor.agentId, "broker", 30);
    const taskId = await delegate(poor.agentToken, payee.agentId, `esc6-${Date.now()}`);
    // Direct legacy row (pre-escrow era): no escrow taken at offer.
    await db.execute(sql`
      INSERT INTO bazaar_delegations (a2a_task_id, payer_id, payee_id, amount, state, escrowed)
      VALUES (${taskId}::uuid, ${poor.agentId}::uuid, ${payee.agentId}::uuid, 25, 'offered', false)
    `);
    // Drain the payer below the amount.
    await db.execute(sql`UPDATE bazaar_balances SET balance = 5 WHERE agent_id = ${poor.agentId}::uuid`);
    const payeeBefore = await getBalance(payee.agentId);
    const totalBefore = await db.execute(sql`SELECT COALESCE(SUM(balance),0)::int AS s FROM bazaar_balances`);
    const sumBefore = Number(rows(totalBefore)[0].s);

    const patch = await app.request(`/a2a/tasks/${taskId}`, {
      method: "PATCH",
      headers: auth(payee.agentToken),
      body: JSON.stringify({ state: "completed", resultMessage: "done" }),
    });
    expect(patch.status).toBe(200);

    expect((await getDelegation(taskId)).state).toBe("failed");
    // No money created or moved: payee unpaid, total supply unchanged.
    expect(await getBalance(payee.agentId)).toBe(payeeBefore);
    const totalAfter = await db.execute(sql`SELECT COALESCE(SUM(balance),0)::int AS s FROM bazaar_balances`);
    expect(Number(rows(totalAfter)[0].s)).toBe(sumBefore);
  });

  test("payer can cancel an offered delegation and reclaim escrow", async () => {
    const taskId = await delegate(payer.agentToken, payee.agentId, `esc7-${Date.now()}`);
    const payerBefore = await getBalance(payer.agentId);
    const offer = await app.request("/bazaar/delegations", {
      method: "POST",
      headers: auth(payer.agentToken),
      body: JSON.stringify({ a2a_task_id: taskId, payee_id: payee.agentId, amount: 7 }),
    });
    const { delegation_id } = await offer.json();
    expect(await getBalance(payer.agentId)).toBe(payerBefore - 7);

    const cancel = await app.request(`/bazaar/delegations/${delegation_id}/cancel`, {
      method: "POST",
      headers: auth(payer.agentToken),
    });
    expect(cancel.status).toBe(200);
    expect((await cancel.json()).refunded).toBe(7);
    expect(await getBalance(payer.agentId)).toBe(payerBefore);
    expect((await getDelegation(taskId)).state).toBe("canceled");

    // Non-payer cannot cancel.
    const cancel2 = await app.request(`/bazaar/delegations/${delegation_id}/cancel`, {
      method: "POST",
      headers: auth(payee.agentToken),
    });
    expect(cancel2.status).toBe(409);
  });
});

describe("bazaar cancel/claim race", () => {
  let poster: { agentToken: string; agentId: string };
  let worker: { agentToken: string; agentId: string };

  beforeAll(async () => {
    poster = await registerAgent("bazaar-race-poster");
    worker = await registerAgent("bazaar-race-worker");
    await setupBazaar(poster.agentId, "broker", 200);
    await setupBazaar(worker.agentId, "artisan", 100);
  });

  test("concurrent claim + cancel: exactly one wins, no double-refund", async () => {
    const postRes = await app.request("/bazaar/tasks", {
      method: "POST",
      headers: auth(poster.agentToken),
      body: JSON.stringify({ title: "Race me", description: "Claim and cancel race for this bounty", bounty_credits: 30 }),
    });
    const { task } = await postRes.json();
    const posterAfterPost = await getBalance(poster.agentId);

    const [claimRes, cancelRes] = await Promise.all([
      app.request(`/bazaar/tasks/${task.id}/claim`, { method: "POST", headers: auth(worker.agentToken) }),
      app.request(`/bazaar/tasks/${task.id}/cancel`, { method: "POST", headers: auth(poster.agentToken) }),
    ]);
    const statuses = [claimRes.status, cancelRes.status].sort();
    // Exactly one of claim/cancel succeeds.
    expect(statuses).toEqual([200, 409]);

    const t = await db.execute(sql`SELECT status, claimed_by FROM bazaar_tasks WHERE id = ${task.id}::uuid`);
    const row = rows(t)[0];
    const posterFinal = await getBalance(poster.agentId);
    if (row.status === "canceled") {
      // Cancel won: full refund, no claim.
      expect(posterFinal).toBe(posterAfterPost + 30);
      expect(row.claimed_by).toBeNull();
    } else {
      // Claim won: no refund, task claimed by worker.
      expect(posterFinal).toBe(posterAfterPost);
      expect(row.claimed_by).toBe(worker.agentId);
    }
  });
});
