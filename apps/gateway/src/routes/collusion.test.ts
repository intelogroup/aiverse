import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../app";
import { db } from "../db/client";
import { sql } from "drizzle-orm";
import { ensureRoomsSeeded } from "../db/seed";
import { resetMemoryStoreForTests } from "../policy/memoryStore";
import { drainIngestStream } from "../jobs/ingestConsumer";

// AIVerse collusion battery — permanent regression tests for competition
// integrity across the in-game channels (bazaar tasks/delegations, A2A relay,
// conversations, mentions). Scenario IDs are stable: AIV-COLL-001..015 — see
// COLLUSION_BATTERY.md in the aiverse-production-optimization goal files.
//
// Core invariant under test: two agents with the same non-null owner may not
// sit on opposite sides of a paid bazaar interaction (claim, verify,
// delegation), an agent may not claim/verify/delegate to itself, and
// competition payloads (bazaar evidence, private conversation content, A2A
// task content) stay blind to non-participants. Honest cross-owner flows
// must keep working exactly as before.
//
// Same env-flag discipline as bazaar.test.ts: bazaar routes mount only when
// AIVERSE_BAZAAR_MODE=1, and the prior value is restored in afterAll.
const PRIOR_BAZAAR_MODE = process.env.AIVERSE_BAZAAR_MODE;
process.env.AIVERSE_BAZAAR_MODE = "1";
const app = createApp();

afterAll(() => {
  if (PRIOR_BAZAAR_MODE === undefined) delete process.env.AIVERSE_BAZAAR_MODE;
  else process.env.AIVERSE_BAZAAR_MODE = PRIOR_BAZAAR_MODE;
});

beforeAll(async () => {
  // Bazaar tables bootstrap — identical idempotent pattern to bazaar.test.ts.
  const schemaPath = join(import.meta.dir, "../../../../experiments/bazaar/schema.sql");
  const withoutComments = readFileSync(schemaPath, "utf-8")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
  const statements = withoutComments
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    await db.execute(sql.raw(stmt));
  }
  await ensureRoomsSeeded();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

type Agent = { agentToken: string; agentId: string; ownerToken: string; name: string };

async function registerOwner(): Promise<string> {
  const email = `coll-${uniq()}@example.com`;
  const reg = await app.request("/owners/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const { token } = await reg.json();
  return token as string;
}

async function createAgent(ownerToken: string, name: string): Promise<Agent> {
  const created = await app.request("/owners/agents", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ name: `${name}-${uniq()}`, capabilities: [] }),
  });
  const { agentToken, agent } = await created.json();
  return { agentToken: agentToken as string, agentId: agent.id as string, ownerToken, name: agent.name as string };
}

// One owner, several agents — the sybil/ring shape.
async function registerRing(prefix: string, roles: string[]): Promise<Agent[]> {
  const ownerToken = await registerOwner();
  const out: Agent[] = [];
  for (const role of roles) out.push(await createAgent(ownerToken, `${prefix}-${role}`));
  return out;
}

// One agent under its own fresh owner — the honest-party shape.
async function registerSolo(name: string): Promise<Agent> {
  const ownerToken = await registerOwner();
  return createAgent(ownerToken, name);
}

async function enableWallet(a: Agent) {
  await app.request(`/owners/agents/${a.agentId}/wallet`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${a.ownerToken}` },
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
  const rr = rows(r);
  return rr.length ? Number(rr[0].balance) : 0;
}

async function taskRow(taskId: string) {
  const r = await db.execute(sql`SELECT status, claimed_by, poster_id FROM bazaar_tasks WHERE id = ${taskId}::uuid`);
  return rows(r)[0];
}

const auth = (token: string) => ({ "content-type": "application/json", authorization: `Bearer ${token}` });

async function postTask(poster: Agent, bounty: number, title = "Collusion probe bounty") {
  const res = await app.request("/bazaar/tasks", {
    method: "POST",
    headers: auth(poster.agentToken),
    body: JSON.stringify({ title, description: "Collusion battery test bounty description", bounty_credits: bounty }),
  });
  expect(res.status).toBe(201);
  const { task } = await res.json();
  return task as { id: string };
}

async function claim(a: Agent, taskId: string) {
  return app.request(`/bazaar/tasks/${taskId}/claim`, { method: "POST", headers: auth(a.agentToken) });
}

async function complete(a: Agent, taskId: string, evidence = "Completed work with sufficient evidence text") {
  return app.request(`/bazaar/tasks/${taskId}/complete`, {
    method: "POST",
    headers: auth(a.agentToken),
    body: JSON.stringify({ evidence }),
  });
}

async function verify(a: Agent, taskId: string, verdict: string) {
  return app.request(`/bazaar/tasks/${taskId}/verify`, {
    method: "POST",
    headers: auth(a.agentToken),
    body: JSON.stringify({ verdict }),
  });
}

// A2A delegate helper — mirrors bazaar.test.ts (send-rate bucket is 1/sec).
const rpc = (method: string, params: any) => ({ jsonrpc: "2.0", id: 1, method, params });
async function delegate(payerToken: string, payeeId: string, messageId: string) {
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

// ---------------------------------------------------------------------------
// Bazaar tasks: self-dealing and same-owner (sybil) guards
// ---------------------------------------------------------------------------

describe("collusion: bazaar task sides", () => {
  let ringPoster: Agent, ringWorker: Agent, ringCritic: Agent;
  let hPoster: Agent, hWorker: Agent, hCritic: Agent;

  beforeAll(async () => {
    [ringPoster, ringWorker, ringCritic] = await registerRing("ring", ["poster", "worker", "critic"]);
    hPoster = await registerSolo("honest-poster");
    hWorker = await registerSolo("honest-worker");
    hCritic = await registerSolo("honest-critic");
    await setupBazaar(ringPoster.agentId, "broker", 100);
    await setupBazaar(ringWorker.agentId, "artisan", 100);
    await setupBazaar(ringCritic.agentId, "critic", 100);
    await setupBazaar(hPoster.agentId, "broker", 100);
    await setupBazaar(hWorker.agentId, "artisan", 100);
    await setupBazaar(hCritic.agentId, "critic", 100);
  });

  test("AIV-COLL-001 poster cannot claim its own bounty", async () => {
    const task = await postTask(hPoster, 10);
    const res = await claim(hPoster, task.id);
    expect(res.status).toBe(403);
    const t = await taskRow(task.id);
    expect(t.status).toBe("open");
    expect(t.claimed_by).toBeNull();
    // Escrow still held by the task, not paid back as a fake payout.
    expect(await getBalance(hPoster.agentId)).toBe(90);
    // Cleanup: cancel to release the escrow.
    const cancel = await app.request(`/bazaar/tasks/${task.id}/cancel`, { method: "POST", headers: auth(hPoster.agentToken) });
    expect(cancel.status).toBe(200);
  });

  test("AIV-COLL-002 same-owner agent cannot claim; independent agent can", async () => {
    const task = await postTask(ringPoster, 10);
    const res = await claim(ringWorker, task.id);
    expect(res.status).toBe(403);
    let t = await taskRow(task.id);
    expect(t.status).toBe("open");
    expect(t.claimed_by).toBeNull();

    // Behavior preservation: an unrelated owner's worker claims fine.
    const ok = await claim(hWorker, task.id);
    expect(ok.status).toBe(200);
    t = await taskRow(task.id);
    expect(t.claimed_by).toBe(hWorker.agentId);
    // Resolve to a terminal state so claim caps stay clean for later tests.
    expect((await complete(hWorker, task.id)).status).toBe(200);
    expect((await verify(hCritic, task.id, "reject")).status).toBe(200);
  });

  test("AIV-COLL-003 critic cannot verify its own claim or its own bounty (pre-existing guards)", async () => {
    // A critic-role agent claims someone else's task, completes it, then
    // tries to judge its own work.
    const task1 = await postTask(hPoster, 10);
    expect((await claim(ringCritic, task1.id)).status).toBe(200);
    expect((await complete(ringCritic, task1.id)).status).toBe(200);
    const selfVerify = await verify(ringCritic, task1.id, "accept");
    expect(selfVerify.status).toBe(403);
    // Independent critic resolves it.
    expect((await verify(hCritic, task1.id, "reject")).status).toBe(200);

    // A critic-role agent posts a bounty; a worker completes it; the poster
    // (a critic) tries to judge its own bounty.
    const task2 = await postTask(ringCritic, 10);
    expect((await claim(hWorker, task2.id)).status).toBe(200);
    expect((await complete(hWorker, task2.id)).status).toBe(200);
    const ownBounty = await verify(ringCritic, task2.id, "accept");
    expect(ownBounty.status).toBe(403);
    expect((await verify(hCritic, task2.id, "reject")).status).toBe(200);
  });

  test("AIV-COLL-004 same-owner critic cannot capture a verdict (poster side or worker side)", async () => {
    // Poster side: ring poster posts, honest worker completes junk, ring
    // critic tries to accept → no payout, no fee, task still awaiting verdict.
    const task1 = await postTask(ringPoster, 15);
    expect((await claim(hWorker, task1.id)).status).toBe(200);
    expect((await complete(hWorker, task1.id, "junk evidence padded to length")).status).toBe(200);
    const workerBefore = await getBalance(hWorker.agentId);
    const criticBefore = await getBalance(ringCritic.agentId);
    const captured1 = await verify(ringCritic, task1.id, "accept");
    expect(captured1.status).toBe(403);
    expect((await taskRow(task1.id)).status).toBe("completed");
    expect(await getBalance(hWorker.agentId)).toBe(workerBefore);
    expect(await getBalance(ringCritic.agentId)).toBe(criticBefore);
    // Independent critic can still judge it.
    expect((await verify(hCritic, task1.id, "reject")).status).toBe(200);

    // Worker side: honest poster posts, ring worker completes, ring critic
    // tries to accept → blocked identically.
    const task2 = await postTask(hPoster, 15);
    expect((await claim(ringWorker, task2.id)).status).toBe(200);
    expect((await complete(ringWorker, task2.id, "junk evidence padded to length")).status).toBe(200);
    const ringWorkerBefore = await getBalance(ringWorker.agentId);
    const captured2 = await verify(ringCritic, task2.id, "accept");
    expect(captured2.status).toBe(403);
    expect((await taskRow(task2.id)).status).toBe("completed");
    expect(await getBalance(ringWorker.agentId)).toBe(ringWorkerBefore);
    expect((await verify(hCritic, task2.id, "reject")).status).toBe(200);
  });

  test("AIV-COLL-005 a single-owner ring cannot mint credits end-to-end", async () => {
    const [p, w, c] = await registerRing("ring2", ["poster", "worker", "critic"]);
    await setupBazaar(p.agentId, "broker", 100);
    await setupBazaar(w.agentId, "artisan", 100);
    await setupBazaar(c.agentId, "critic", 100);

    const task = await postTask(p, 20);
    expect((await claim(p, task.id)).status).toBe(403); // self-claim
    expect((await claim(w, task.id)).status).toBe(403); // same-owner claim
    expect((await claim(hWorker, task.id)).status).toBe(200); // honest worker
    expect((await complete(hWorker, task.id, "ring probe evidence text")).status).toBe(200);
    expect((await verify(c, task.id, "accept")).status).toBe(403); // same-owner critic

    // An independent critic rejects: poster refunded in full. That is the
    // ONLY money movement the ring's task may ever cause.
    expect((await verify(hCritic, task.id, "reject")).status).toBe(200);

    // Ring balances: exactly where they started (100 each). No payout, no fee.
    expect(await getBalance(p.agentId)).toBe(100);
    expect(await getBalance(w.agentId)).toBe(100);
    expect(await getBalance(c.agentId)).toBe(100);
    // No fee or payout events were recorded for any ring member on this task.
    const ev = await db.execute(sql`
      SELECT kind FROM bazaar_events
      WHERE task_id = ${task.id}::uuid AND kind IN ('fee','payout')
        AND actor_id IN (${p.agentId}::uuid, ${w.agentId}::uuid, ${c.agentId}::uuid)
    `);
    expect(rows(ev).length).toBe(0);
  });

  test("AIV-COLL-006 escrow cycling is net-zero: post/cancel and offer/cancel restore balances exactly", async () => {
    const start = await getBalance(hPoster.agentId);
    for (let i = 0; i < 3; i++) {
      const task = await postTask(hPoster, 10, `Cycle probe ${i}`);
      expect(await getBalance(hPoster.agentId)).toBe(start - 10);
      const cancel = await app.request(`/bazaar/tasks/${task.id}/cancel`, { method: "POST", headers: auth(hPoster.agentToken) });
      expect(cancel.status).toBe(200);
      expect(await getBalance(hPoster.agentId)).toBe(start);
    }
  });

  test("AIV-COLL-007 honest cross-owner cycle still settles exactly (guard regression check)", async () => {
    // Accept path.
    const task1 = await postTask(hPoster, 15);
    const workerBefore = await getBalance(hWorker.agentId);
    const criticBefore = await getBalance(hCritic.agentId);
    expect((await claim(hWorker, task1.id)).status).toBe(200);
    expect((await complete(hWorker, task1.id)).status).toBe(200);
    expect((await verify(hCritic, task1.id, "accept")).status).toBe(200);
    expect(await getBalance(hWorker.agentId)).toBe(workerBefore + 15);
    expect(await getBalance(hCritic.agentId)).toBe(criticBefore + 2); // base fee, immediate verdict

    // Reject path: refund + reopen.
    const task2 = await postTask(hPoster, 12);
    const posterBefore = await getBalance(hPoster.agentId);
    expect((await claim(hWorker, task2.id)).status).toBe(200);
    expect((await complete(hWorker, task2.id)).status).toBe(200);
    expect((await verify(hCritic, task2.id, "reject")).status).toBe(200);
    expect(await getBalance(hPoster.agentId)).toBe(posterBefore + 12);
    expect((await taskRow(task2.id)).status).toBe("open");
    // Leave it canceled so it doesn't sit open for other tests' board reads.
    const cancel = await app.request(`/bazaar/tasks/${task2.id}/cancel`, { method: "POST", headers: auth(hPoster.agentToken) });
    expect(cancel.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Bazaar delegations: self / same-owner / duplicate escrow
// ---------------------------------------------------------------------------

describe("collusion: bazaar delegations", () => {
  let ringPayer: Agent, ringPayee: Agent;
  let hPayer: Agent, hPayee: Agent;

  beforeAll(async () => {
    [ringPayer, ringPayee] = await registerRing("deleg", ["payer", "payee"]);
    hPayer = await registerSolo("honest-payer");
    hPayee = await registerSolo("honest-payee");
    for (const a of [ringPayer, ringPayee, hPayer, hPayee]) await enableWallet(a);
    await setupBazaar(ringPayer.agentId, "broker", 100);
    await setupBazaar(ringPayee.agentId, "artisan", 100);
    await setupBazaar(hPayer.agentId, "broker", 100);
    await setupBazaar(hPayee.agentId, "artisan", 100);
  });

  test("AIV-COLL-008 same-owner delegation is refused and escrows nothing", async () => {
    const taskId = await delegate(ringPayer.agentToken, ringPayee.agentId, `coll8-${uniq()}`);
    const before = await getBalance(ringPayer.agentId);
    const res = await app.request("/bazaar/delegations", {
      method: "POST",
      headers: auth(ringPayer.agentToken),
      body: JSON.stringify({ a2a_task_id: taskId, payee_id: ringPayee.agentId, amount: 15 }),
    });
    expect(res.status).toBe(403);
    expect(await getBalance(ringPayer.agentId)).toBe(before);
    expect(await getDelegation(taskId)).toBeUndefined();
  });

  test("AIV-COLL-009 self-delegation is refused (pre-existing guard)", async () => {
    const res = await app.request("/bazaar/delegations", {
      method: "POST",
      headers: auth(hPayer.agentToken),
      body: JSON.stringify({ a2a_task_id: "00000000-0000-0000-0000-000000000000", payee_id: hPayer.agentId, amount: 5 }),
    });
    expect(res.status).toBe(400);
    expect(await getBalance(hPayer.agentId)).toBe(100);
  });

  test("AIV-COLL-010 duplicate delegation offer escrows exactly once (AIV-DELEG-DUP-ESCROW-001)", async () => {
    const taskId = await delegate(hPayer.agentToken, hPayee.agentId, `coll10-${uniq()}`);
    const before = await getBalance(hPayer.agentId);
    const body = JSON.stringify({ a2a_task_id: taskId, payee_id: hPayee.agentId, amount: 15 });
    const first = await app.request("/bazaar/delegations", { method: "POST", headers: auth(hPayer.agentToken), body });
    expect(first.status).toBe(201);
    const dup = await app.request("/bazaar/delegations", { method: "POST", headers: auth(hPayer.agentToken), body });
    expect(dup.status).toBe(409);
    expect(await getBalance(hPayer.agentId)).toBe(before - 15); // one debit, not two
    const d = await getDelegation(taskId);
    expect(d.state).toBe("offered");
  });
});

// ---------------------------------------------------------------------------
// Leakage: bazaar evidence, private conversations, mentions, A2A tasks
// ---------------------------------------------------------------------------

describe("collusion: channel blindness", () => {
  let poster: Agent, worker: Agent, critic: Agent, outsider: Agent;

  beforeAll(async () => {
    // Short base names: createAgent appends "-<uniq()>" (20 chars) and the
    // @-mention regex caps names at 32 chars — a longer full name would be
    // truncated by the regex and silently never resolve (COLL-014's control).
    poster = await registerSolo("leakp");
    worker = await registerSolo("leakw");
    critic = await registerSolo("leakc");
    outsider = await registerSolo("leako");
    for (const a of [poster, worker, critic, outsider]) await enableWallet(a);
    await setupBazaar(poster.agentId, "broker", 100);
    await setupBazaar(worker.agentId, "artisan", 100);
    await setupBazaar(critic.agentId, "critic", 100);
    await setupBazaar(outsider.agentId, "artisan", 100);
  });

  test("AIV-COLL-011 the public board never carries description or evidence", async () => {
    const task = await postTask(poster, 10);
    expect((await claim(worker, task.id)).status).toBe(200);
    expect((await complete(worker, task.id, "SECRET-EVIDENCE must not leak to the board")).status).toBe(200);

    for (const status of ["completed", "open"]) {
      const res = await app.request(`/bazaar/tasks?status=${status}`, { headers: auth(outsider.agentToken) });
      expect(res.status).toBe(200);
      const { tasks } = await res.json();
      for (const t of tasks) {
        expect("evidence" in t).toBe(false);
        expect("description" in t).toBe(false);
      }
      const mine = tasks.find((t: any) => t.id === task.id);
      if (status === "completed") expect(mine).toBeDefined();
    }
    // Resolve so later tests see a clean board state for this task.
    expect((await verify(critic, task.id, "reject")).status).toBe(200);
  });

  test("AIV-COLL-012 pending-verification evidence is visible to critics only", async () => {
    const task = await postTask(poster, 10);
    expect((await claim(worker, task.id)).status).toBe(200);
    expect((await complete(worker, task.id, "SECRET-EVIDENCE for critics only here")).status).toBe(200);

    // Non-critic (the claimer, the poster, an outsider artisan): no queue.
    for (const a of [worker, poster, outsider]) {
      const res = await app.request("/bazaar/context", { headers: auth(a.agentToken) });
      const ctx = await res.json();
      expect(ctx.pending_verifications).toEqual([]);
    }
    // The judging channel itself works as designed: an independent critic
    // sees the pending task WITH evidence (that's what judging means).
    const res = await app.request("/bazaar/context", { headers: auth(critic.agentToken) });
    const ctx = await res.json();
    const pv = ctx.pending_verifications.find((t: any) => t.id === task.id);
    expect(pv).toBeDefined();
    expect(pv.evidence).toContain("SECRET-EVIDENCE");
    expect((await verify(critic, task.id, "reject")).status).toBe(200);
  });

  test("AIV-COLL-013 private conversation content is blind to non-participants and public surfaces", async () => {
    await resetMemoryStoreForTests();
    const secret = `blindprobe-${uniq()}`;
    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: auth(poster.agentToken),
      body: JSON.stringify({ isPublic: false, name: "blind-probe", participantIds: [worker.agentId] }),
    });
    expect(createRes.status).toBe(201);
    const { conversation } = await createRes.json();

    const post = await app.request(`/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: auth(poster.agentToken),
      body: JSON.stringify({ content: `the secret word is ${secret}` }),
    });
    expect(post.status).toBe(201);
    await drainIngestStream();

    // Non-participant agent read → 403.
    const read = await app.request(`/conversations/${conversation.id}/messages`, {
      headers: { authorization: `Bearer ${outsider.agentToken}` },
    });
    expect(read.status).toBe(403);

    // Unauthenticated public transcript → 404 (private conversation).
    const pub = await app.request(`/public/conversations/${conversation.id}`);
    expect(pub.status).toBe(404);

    // Agent search (public-only) must not surface the secret. (The response
    // echoes q back, so assert on the results array, not the raw body.)
    const search = await app.request(`/search?q=${secret}`, {
      headers: { authorization: `Bearer ${outsider.agentToken}` },
    });
    const sbody = await search.json();
    expect(sbody.results).toEqual([]);
    expect(sbody.count).toBe(0);

    // Participant control: the worker CAN read it.
    const ok = await app.request(`/conversations/${conversation.id}/messages`, {
      headers: { authorization: `Bearer ${worker.agentToken}` },
    });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(await ok.json())).toContain(secret);
  });

  test("AIV-COLL-014 a mention inside a private conversation never reaches a non-participant", async () => {
    await resetMemoryStoreForTests();
    const createRes = await app.request("/conversations", {
      method: "POST",
      headers: auth(poster.agentToken),
      body: JSON.stringify({ participantIds: [worker.agentId] }), // dm shape: private, 2-party
    });
    // 201 fresh, or 200 when the pair's DM already exists (idempotent reuse —
    // COLL-013 already opened one between this pair).
    expect([200, 201]).toContain(createRes.status);
    const { conversation } = await createRes.json();

    const post = await app.request(`/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: auth(poster.agentToken),
      body: JSON.stringify({ content: `@${outsider.name} private coordination probe text` }),
    });
    expect(post.status).toBe(201);
    await drainIngestStream();

    const m = await db.execute(sql`SELECT count(*)::int AS n FROM mentions WHERE target_agent_id = ${outsider.agentId}::uuid AND conversation_id = ${conversation.id}::uuid`);
    expect(Number(rows(m)[0].n)).toBe(0);

    // Positive control: the same mention in a PUBLIC conversation does land.
    await resetMemoryStoreForTests();
    const pubCreate = await app.request("/conversations", {
      method: "POST",
      headers: auth(poster.agentToken),
      body: JSON.stringify({ isPublic: true, name: `mention-probe-${uniq()}`, participantIds: [worker.agentId] }),
    });
    expect(pubCreate.status).toBe(201);
    const { conversation: pubConv } = await pubCreate.json();
    const pubPost = await app.request(`/conversations/${pubConv.id}/messages`, {
      method: "POST",
      headers: auth(poster.agentToken),
      body: JSON.stringify({ content: `@${outsider.name} public coordination probe text` }),
    });
    expect(pubPost.status).toBe(201);
    await drainIngestStream();
    const m2 = await db.execute(sql`SELECT count(*)::int AS n FROM mentions WHERE target_agent_id = ${outsider.agentId}::uuid AND conversation_id = ${pubConv.id}::uuid`);
    expect(Number(rows(m2)[0].n)).toBe(1);
  });

  test("AIV-COLL-015 A2A task content is readable and actionable only by its two parties", async () => {
    const taskId = await delegate(poster.agentToken, worker.agentId, `coll15-${uniq()}`);

    // Third party polls the task → JSON-RPC task-not-found (404 / -32001).
    const peek = await app.request(`/a2a/agents/${worker.agentId}`, {
      method: "POST",
      headers: auth(outsider.agentToken),
      body: JSON.stringify(rpc("tasks/get", { id: taskId })),
    });
    const peekBody = await peek.json();
    expect(peek.status).toBe(404);
    expect(peekBody.error?.code).toBe(-32001);

    // Third party tries to complete it → 403 (only the target may update).
    const hijack = await app.request(`/a2a/tasks/${taskId}`, {
      method: "PATCH",
      headers: auth(outsider.agentToken),
      body: JSON.stringify({ state: "completed", resultMessage: "hijacked" }),
    });
    expect(hijack.status).toBe(403);

    // Control: the target can read it.
    const ok = await app.request(`/a2a/agents/${poster.agentId}`, {
      method: "POST",
      headers: auth(worker.agentToken),
      body: JSON.stringify(rpc("tasks/get", { id: taskId })),
    });
    const okBody = await ok.json();
    expect(ok.status).toBe(200);
    expect(okBody.result?.id).toBe(taskId);
  });
});
