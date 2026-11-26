import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../app";
import { ingestConsumerTick, newIngestConsumerState } from "../jobs/ingestConsumer";
import { db } from "../db/client";
import { sql } from "drizzle-orm";

// CANARY SWEEP (2026-11-26, Jim-approved). AgentLeak's lesson: leaks live
// in side channels, and output-only audits miss them. Plant a unique
// canary in each private store of a victim agent, then read EVERY surface
// an outsider (a third owner's agent, plus unauthenticated public routes)
// can reach, and grep for canaries. One control canary sits in a public
// bazaar task title: it MUST be found, proving the sweep can detect.
// Grading is mechanical: private canary present in any outsider response
// = LEAKED (test goes red); absent everywhere = BLIND.

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
const CANARY = {
  conv: `CANARY-CONV-${R}`,
  mem: `CANARY-MEM-${R}`,
  evid: `CANARY-EVID-${R}`,
  title: `CANARY-TITLE-${R}`, // control: public by design, MUST be found
};

async function registerAgent(name: string): Promise<{ agentToken: string; agentId: string }> {
  const email = `canary-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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

const auth = (token: string) => ({ "content-type": "application/json", authorization: `Bearer ${token}` });

async function body(path: string, token?: string): Promise<string> {
  const res = await app.request(path, token ? { headers: auth(token) } : {});
  return await res.text();
}

describe("CANARY SWEEP", () => {
  test("private canaries stay blind on every outsider surface", async () => {
    const V = await registerAgent(`canary-victim-${R}`);
    const F = await registerAgent(`canary-friend-${R}`);
    const X = await registerAgent(`canary-outsider-${R}`);

    // Plant 1: private DM between V and F.
    const convo = await app.request("/conversations", {
      method: "POST",
      headers: auth(V.agentToken),
      body: JSON.stringify({ kind: "dm", participantIds: [F.agentId] }),
    });
    expect(convo.status).toBeLessThan(300);
    const convoJson = await convo.json();
    const dmId = (convoJson.conversation?.id ?? convoJson.id) as string;
    expect(dmId).toBeTruthy();
    const send = await app.request(`/conversations/${dmId}/messages`, {
      method: "POST",
      headers: auth(V.agentToken),
      body: JSON.stringify({ content: `quiet word between us: ${CANARY.conv}` }),
    });
    expect(send.status).toBeLessThan(300);
    // Sends are durably buffered in the Redis ingest stream; the consumer
    // job lands them in Postgres. Drain it so the canary is really stored
    // before any surface is graded (same call the repo's own tests use).
    await ingestConsumerTick(newIngestConsumerState(`canary-${Date.now()}`), { blockMs: 10 });

    // Plant 2: V's private agent memory.
    const mem = await app.request("/memory", {
      method: "POST",
      headers: auth(V.agentToken),
      body: JSON.stringify({ content: `owner note to self: ${CANARY.mem}` }),
    });
    expect(mem.status).toBeLessThan(300);

    // Plant 3: bazaar evidence (private work product) + control title.
    await db.execute(sql`
      INSERT INTO bazaar_roles (agent_id, role) VALUES (${V.agentId}::uuid, 'artisan'), (${F.agentId}::uuid, 'scout')
      ON CONFLICT (agent_id) DO UPDATE SET role = EXCLUDED.role`);
    await db.execute(sql`
      INSERT INTO bazaar_balances (agent_id, balance) VALUES (${V.agentId}::uuid, 50)
      ON CONFLICT (agent_id) DO UPDATE SET balance = 50`);
    const post = await app.request("/bazaar/tasks", {
      method: "POST",
      headers: auth(V.agentToken),
      body: JSON.stringify({ title: `Sweep probe ${CANARY.title}`, description: "canary sweep task, nothing real", bounty_credits: 10 }),
    });
    expect(post.status).toBe(201);
    const { task } = await post.json();
    const claim = await app.request(`/bazaar/tasks/${task.id}/claim`, { method: "POST", headers: auth(F.agentToken) });
    expect(claim.status).toBe(200);
    const complete = await app.request(`/bazaar/tasks/${task.id}/complete`, {
      method: "POST",
      headers: auth(F.agentToken),
      body: JSON.stringify({ evidence: `finished; internal detail ${CANARY.evid}` }),
    });
    expect(complete.status).toBe(200);

    // Sanity: the plants are really stored (DB is ground truth — the
    // sender's own API read is cursor-based and legitimately shows []).
    const stored = (await db.execute(sql`
      SELECT (SELECT count(*)::int FROM messages WHERE content LIKE '%CANARY-CONV%') AS conv,
             (SELECT count(*)::int FROM agent_memory WHERE content LIKE '%CANARY-MEM%') AS mem`)) as unknown as Array<{ conv: number; mem: number }>;
    expect(stored[0].conv).toBeGreaterThan(0);
    expect(stored[0].mem).toBeGreaterThan(0);

    // Probe every outsider surface.
    const surfaces: Array<[string, string]> = [
      ["public/activity (anon)", await body("/public/activity")],
      ["public/trending (anon)", await body("/public/trending")],
      ["public/search?q=canary (anon)", await body(`/public/search?q=CANARY`)],
      ["public/conversations/:dmId (anon)", await body(`/public/conversations/${dmId}`)],
      ["agents/discover (X)", await body("/agents/discover", X.agentToken)],
      ["agents/discover?q=CANARY (X)", await body("/agents/discover?q=CANARY", X.agentToken)],
      ["agent-card.json of V (X)", await body(`/agents/${V.agentId}/agent-card.json`, X.agentToken)],
      ["conversations list (X)", await body("/conversations", X.agentToken)],
      ["DM messages direct (X)", await body(`/conversations/${dmId}/messages`, X.agentToken)],
      ["memory/recall?q=CANARY (X)", await body("/memory/recall?q=CANARY", X.agentToken)],
      ["verse/memory (X)", await body("/verse/memory", X.agentToken)],
      ["bazaar board completed (X)", await body("/bazaar/tasks?status=completed", X.agentToken)],
      ["bazaar board open (X)", await body("/bazaar/tasks?status=open", X.agentToken)],
    ];

    let controlFound = false;
    const leaks: string[] = [];
    for (const [name, text] of surfaces) {
      const found = Object.entries(CANARY).filter(([, v]) => text.includes(v)).map(([k]) => k);
      if (found.includes("title")) controlFound = true;
      const privateFound = found.filter((k) => k !== "title");
      console.log(`[canary] ${name}: ${privateFound.length ? "LEAKED " + privateFound.join(",") : "blind"}${found.includes("title") ? " (+control)" : ""}`);
      for (const k of privateFound) leaks.push(`${name} -> ${k}`);
    }
    expect(controlFound).toBe(true); // sweep can detect what is public
    expect(leaks).toEqual([]); // nothing private escaped
  });
});
