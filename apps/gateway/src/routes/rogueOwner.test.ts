import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../app";
import { db } from "../db/client";
import { sql } from "drizzle-orm";
import { claimExpirySweepSQL } from "../../../../experiments/bazaar/mechanics";

// ROGUE OWNER battery (2026-11-26, Jim-queued after the FEEFARM fix).
// Threat model: the OWNER is the attacker — their agent's mandate orders
// theft, impersonation, and griefing, and the agent obeys perfectly.
// The agent's word counts for nothing; the question is purely what the
// platform's structure stops. Each probe grades HELD (server refused /
// state untouched) or GAP (with the exact evidence). Probes that merely
// record a by-design residual (lookalike names) say so instead of
// forcing a binary.

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

async function makeOwner(emailPrefix: string): Promise<string> {
  const email = `${emailPrefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const { token } = await reg.json();
  return token as string;
}

async function createAgent(ownerToken: string, name: string): Promise<{ status: number; agentToken?: string; agentId?: string }> {
  const res = await app.request("/owners/agents", {
    method: "POST",
    headers: auth(ownerToken),
    body: JSON.stringify({ name, capabilities: [] }),
  });
  if (res.status !== 201) return { status: res.status };
  const { agentToken, agent } = await res.json();
  return { status: 201, agentToken, agentId: agent.id };
}

describe("ROGUE OWNER", () => {
  test("P1 impersonation: exact/case names blocked, lookalikes graded", async () => {
    const victimOwner = await makeOwner("rogue-victim");
    const rogueOwner = await makeOwner("rogue-owner");
    const victimName = `Beacon-${R}`;
    const v = await createAgent(victimOwner, victimName);
    expect(v.status).toBe(201);

    const attempts: Array<[string, string]> = [
      ["exact", victimName],
      ["lowercase", victimName.toLowerCase()],
      ["uppercase", victimName.toUpperCase()],
      ["trailing-space", `${victimName} `],
      ["leading-space", ` ${victimName}`],
      ["zero-width", `Bea​con-${R}`],
      ["cyrillic-e", `Bеacon-${R}`],
    ];
    for (const [label, name] of attempts) {
      const a = await createAgent(rogueOwner, name);
      console.log(`[rogue] P1 name ${label}: ${a.status === 409 ? "BLOCKED (409)" : a.status === 201 ? "REGISTERED (gap)" : `status ${a.status}`}`);
      if (label === "exact" || label === "lowercase" || label === "uppercase") {
        expect(a.status).toBe(409);
      }
    }
    // Self-registration path enforces the same rule for the exact name.
    const selfReg = await app.request("/agents/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: victimName, capabilities: [] }),
    });
    console.log(`[rogue] P1 self-register exact name: ${selfReg.status}`);
    expect(selfReg.status).toBe(409);
    // isNative is server-side truth: the victim (a normal agent) is
    // false in the database, and no registration path sets it. Checked
    // in the DB rather than the discover roster, whose 50-row cap makes
    // a roster lookup unreliable in a shared test database.
    const rows = (await db.execute(sql`SELECT is_native FROM agents WHERE id = ${v.agentId}::uuid`)) as unknown as Array<{ is_native: boolean }>;
    expect(rows[0]?.is_native).toBe(false);
  });

  test("P2 foreign item transfer is refused, item unmoved", async () => {
    const victimOwner = await makeOwner("rogue-victim2");
    const rogueOwner = await makeOwner("rogue-owner2");
    const v = await createAgent(victimOwner, `Holder-${R}`);
    const x = await createAgent(rogueOwner, `Grabber-${R}`);
    const itemRows = (await db.execute(sql`
      INSERT INTO verse_inventory (agent_id, name) VALUES (${v.agentId}::uuid, 'Golden Compass')
      RETURNING id, revision`)) as unknown as Array<{ id: string; revision: number }>;
    const item = itemRows[0];
    const res = await app.request(`/verse/inventory/${item.id}/transfer`, {
      method: "POST",
      headers: auth(x.agentToken!),
      body: JSON.stringify({ toAgentId: x.agentId, revision: item.revision }),
    });
    console.log(`[rogue] P2 foreign transfer: ${res.status}`);
    expect(res.status).not.toBe(200);
    const after = (await db.execute(sql`SELECT agent_id FROM verse_inventory WHERE id = ${item.id}::uuid`)) as unknown as Array<{ agent_id: string }>;
    expect(after[0].agent_id).toBe(v.agentId);
  });

  test("P3 claim-and-stall: cap holds, TTL sweep releases the squat", async () => {
    const posterOwner = await makeOwner("rogue-poster");
    const rogueOwner = await makeOwner("rogue-owner3");
    const helperOwner = await makeOwner("rogue-helper");
    const poster = await createAgent(posterOwner, `Poster-${R}`);
    const rogue = await createAgent(rogueOwner, `Squatter-${R}`);
    const helper = await createAgent(helperOwner, `Helper-${R}`);
    for (const [a, role, bal] of [[poster, "artisan", 100], [rogue, "scout", 0], [helper, "scout", 0]] as const) {
      await db.execute(sql`
        INSERT INTO bazaar_roles (agent_id, role) VALUES (${a.agentId}::uuid, ${role})
        ON CONFLICT (agent_id) DO UPDATE SET role = EXCLUDED.role`);
      await db.execute(sql`
        INSERT INTO bazaar_balances (agent_id, balance) VALUES (${a.agentId}::uuid, ${bal})
        ON CONFLICT (agent_id) DO UPDATE SET balance = ${bal}`);
    }
    const taskIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await app.request("/bazaar/tasks", {
        method: "POST",
        headers: auth(poster.agentToken!),
        body: JSON.stringify({ title: `stall probe ${i} ${R}`, description: "griefing probe task", bounty_credits: 10 }),
      });
      expect(res.status).toBe(201);
      taskIds.push((await res.json()).task.id);
    }
    // Rogue squats on two (the cap), the third claim is refused.
    expect((await app.request(`/bazaar/tasks/${taskIds[0]}/claim`, { method: "POST", headers: auth(rogue.agentToken!) })).status).toBe(200);
    expect((await app.request(`/bazaar/tasks/${taskIds[1]}/claim`, { method: "POST", headers: auth(rogue.agentToken!) })).status).toBe(200);
    const third = await app.request(`/bazaar/tasks/${taskIds[2]}/claim`, { method: "POST", headers: auth(rogue.agentToken!) });
    console.log(`[rogue] P3 third claim (cap): ${third.status}`);
    expect(third.status).not.toBe(200);
    // Age the first squat past the 25-minute TTL and run the sweep.
    await db.execute(sql`UPDATE bazaar_tasks SET claimed_at = now() - interval '26 minutes' WHERE id = ${taskIds[0]}::uuid`);
    await db.execute(sql.raw(claimExpirySweepSQL(25)));
    const row = (await db.execute(sql`SELECT status, claimed_by FROM bazaar_tasks WHERE id = ${taskIds[0]}::uuid`)) as unknown as Array<{ status: string; claimed_by: string | null }>;
    console.log(`[rogue] P3 after sweep: status=${row[0].status}`);
    expect(row[0].status).toBe("open");
    expect(row[0].claimed_by).toBeNull();
    // And the released task is claimable by an honest worker.
    expect((await app.request(`/bazaar/tasks/${taskIds[0]}/claim`, { method: "POST", headers: auth(helper.agentToken!) })).status).toBe(200);
  });

  test("P4 cross-owner goals and goal-tagged memory are refused", async () => {
    const aOwner = await makeOwner("rogue-goal-a");
    const bOwner = await makeOwner("rogue-goal-b");
    const a = await createAgent(aOwner, `GoalA-${R}`);
    const b = await createAgent(bOwner, `GoalB-${R}`);
    const created = await app.request("/goals", {
      method: "POST",
      headers: auth(a.agentToken!),
      body: JSON.stringify({ objective: "a private objective for the rogue battery" }),
    });
    expect(created.status).toBe(201);
    const { goal } = await created.json();
    const read = await app.request(`/goals/${goal.id}`, { headers: auth(b.agentToken!) });
    const patch = await app.request(`/goals/${goal.id}`, {
      method: "PATCH",
      headers: auth(b.agentToken!),
      body: JSON.stringify({ status: "closed" }),
    });
    const tag = await app.request("/memory", {
      method: "POST",
      headers: auth(b.agentToken!),
      body: JSON.stringify({ content: "planted in a foreign goal", goalId: goal.id }),
    });
    console.log(`[rogue] P4 foreign goal read=${read.status} patch=${patch.status} memory-tag=${tag.status}`);
    expect(read.status).toBe(404);
    expect(patch.status).toBe(404);
    expect(tag.status).toBe(404);
    // The agent also cannot self-accept its own goal (owner-only verdict).
    const verdict = await app.request(`/goals/${goal.id}`, {
      method: "PATCH",
      headers: auth(a.agentToken!),
      body: JSON.stringify({ status: "accepted" }),
    });
    console.log(`[rogue] P4 self-verdict attempt: ${verdict.status}`);
    expect(verdict.status).toBe(403);
  });

  test("P5 agent token cannot drive owner-only surfaces", async () => {
    const aOwner = await makeOwner("rogue-esc-a");
    const a = await createAgent(aOwner, `EscA-${R}`);
    // Owner-only: patch another agent's settings via /owners/agents/:id
    // with an AGENT token (not an owner session).
    const patchAgent = await app.request(`/owners/agents/${a.agentId}`, {
      method: "PATCH",
      headers: auth(a.agentToken!),
      body: JSON.stringify({ name: "Renamed by agent token" }),
    });
    console.log(`[rogue] P5 agent token on owner route: ${patchAgent.status}`);
    expect([401, 403, 404, 405]).toContain(patchAgent.status);
    const row = (await db.execute(sql`SELECT name FROM agents WHERE id = ${a.agentId}::uuid`)) as unknown as Array<{ name: string }>;
    expect(row[0].name).toBe(`EscA-${R}`);
  });
});
