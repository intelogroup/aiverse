import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { owners, verseAgentState, verseInventory, verseProgressEvents } from "@aiverse/shared/schema";
import { env } from "@aiverse/shared/env";
import { createApp } from "../app";
import { db } from "../db/client";
import type { SimClient } from "./simClient";
import { getAgentEconomyState, levelForXp, xpForLevel } from "./agentEconomy";

// ── level derivation (pure) ─────────────────────────────────────────────

describe("levelForXp", () => {
  test("level 1 below the first threshold, then square thresholds", () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(99)).toBe(1);
    expect(levelForXp(100)).toBe(2);
    expect(levelForXp(399)).toBe(2);
    expect(levelForXp(400)).toBe(3);
    expect(levelForXp(899)).toBe(3);
    expect(levelForXp(900)).toBe(4);
    expect(levelForXp(10_000)).toBe(11);
  });

  test("xpForLevel is the exact inverse at thresholds", () => {
    for (const level of [1, 2, 3, 4, 5, 10]) {
      expect(xpForLevel(level)).toBe(100 * (level - 1) ** 2);
      expect(levelForXp(xpForLevel(level))).toBe(level);
      if (level > 1) expect(levelForXp(xpForLevel(level) - 1)).toBe(level - 1);
    }
  });

  test("degenerate inputs stay at level 1 and never go backwards", () => {
    expect(levelForXp(-50)).toBe(1);
    expect(levelForXp(Number.NaN)).toBe(1);
    let prev = 0;
    for (let xp = 0; xp <= 5_000; xp += 37) {
      const level = levelForXp(xp);
      expect(level).toBeGreaterThanOrEqual(prev);
      prev = level;
    }
  });
});

// ── economy state assembly (real DB) ────────────────────────────────────

async function createAgentRow() {
  const { agents } = await import("@aiverse/shared/schema");
  const [owner] = await db.insert(owners).values({
    email: `economy-state-${randomUUID()}@example.com`, passwordHash: "unused-in-test",
  }).returning();
  const [agent] = await db.insert(agents).values({
    ownerId: owner.id, name: `Eco-${randomUUID().slice(0, 8)}`, apiKeyHash: randomUUID(),
  }).returning();
  return agent;
}

describe("getAgentEconomyState", () => {
  test("a fresh agent reads defaults: full energy, no credits/xp/wants, empty bag", async () => {
    const agent = await createAgentRow();
    const state = await getAgentEconomyState(agent.id);
    expect(state).toEqual({
      energy: 100, credits: 0, xp: 0, level: 1, nextLevelXp: 100, wants: [], bag: [],
    });
    // The read materializes the state row so later phases have somewhere to write.
    const rows = await db.select().from(verseAgentState).where(eq(verseAgentState.agentId, agent.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].energy).toBe(100);
  });

  test("credits and xp come from the progress ledger; level derives from xp; bag lists inventory", async () => {
    const agent = await createAgentRow();
    await db.insert(verseProgressEvents).values([
      { agentId: agent.id, kind: "pickup", source: "garden-keepsake", credits: 3, xp: 5 },
      { agentId: agent.id, kind: "sale", source: "offer-1", credits: 247, xp: 445 },
    ]);
    const [jar] = await db.insert(verseInventory).values({ agentId: agent.id, name: "Stone Cabin tea jar" }).returning();
    const state = await getAgentEconomyState(agent.id);
    expect(state.credits).toBe(250);
    expect(state.xp).toBe(450);
    expect(state.level).toBe(3);
    expect(state.nextLevelXp).toBe(900);
    expect(state.bag).toEqual([{ id: jar.id, name: "Stone Cabin tea jar" }]);
  });

  test("stored energy and wants are read back verbatim", async () => {
    const agent = await createAgentRow();
    await db.insert(verseAgentState).values({
      agentId: agent.id, energy: 37, wants: [{ item: "Lantern", maxPrice: 50 }, { item: "Tea" }],
    });
    const state = await getAgentEconomyState(agent.id);
    expect(state.energy).toBe(37);
    expect(state.wants).toEqual([{ item: "Lantern", maxPrice: 50 }, { item: "Tea" }]);
  });
});

// ── migration on a fresh database ───────────────────────────────────────

describe("migration 0060 on a fresh DB", () => {
  const adminUrl = env.DATABASE_URL.replace(/\/[^/]+$/, "/postgres");
  const scratchName = `aiverse_migtest_${Math.random().toString(36).slice(2, 10)}`;
  const scratchUrl = env.DATABASE_URL.replace(/\/[^/]+$/, `/${scratchName}`);

  afterAll(async () => {
    const admin = postgres(adminUrl, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${scratchName}`);
    await admin.end();
  });

  test("the full migration chain creates verse_agent_state with the phase-1 defaults", async () => {
    const admin = postgres(adminUrl, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${scratchName}`);
    await admin.end();

    const sql = postgres(scratchUrl, { max: 1 });
    const fresh = drizzle(sql);
    await migrate(fresh, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });

    const cols = await sql`
      SELECT column_name, column_default, is_nullable
      FROM information_schema.columns WHERE table_name = 'verse_agent_state'
      ORDER BY ordinal_position`;
    expect(cols.map((c) => c.column_name)).toEqual(["agent_id", "energy", "wants", "updated_at"]);
    const byName = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    expect(byName.energy.column_default).toContain("100");
    expect(byName.wants.column_default).toContain("[]");
    expect(byName.energy.is_nullable).toBe("NO");

    const fk = await sql`
      SELECT 1 FROM information_schema.referential_constraints rc
      JOIN information_schema.constraint_column_usage ccu ON rc.constraint_name = ccu.constraint_name
      WHERE ccu.table_name = 'agents' LIMIT 1`;
    expect(fk.length).toBeGreaterThan(0);
    await sql.end();
  }, 60_000);
});

// ── MCP surface: whoami + observe carry the self block ──────────────────

const fakeBodies = new Map<string, { figure: string }>();
const fakeObservation = (agentId: string) => ({
  t: 0,
  body: { figure: fakeBodies.get(agentId)!.figure, x: 0, z: 0, heading: 0, posture: "standing" },
  nearestPlace: null, insideRoom: null, scene: [], lastAct: null, heard: [],
});
const noBody = () => Response.json({ error: "no_body", message: "no body: attach one first" }, { status: 404 });

const fakeSim: SimClient = {
  async call(method, path, rawBody) {
    if (method === "GET" && path === "/clips") return Response.json({ clips: [] });
    if (method === "GET" && path === "/places") return Response.json({ places: [] });
    const parts = path.split("?")[0].split("/").filter(Boolean);
    if (method === "POST" && parts.length === 1 && parts[0] === "bodies") {
      const b = JSON.parse(rawBody ?? "{}") as { agentId: string; body?: string };
      if (!fakeBodies.has(b.agentId)) fakeBodies.set(b.agentId, { figure: b.body ?? "remy" });
      return Response.json({ observation: fakeObservation(b.agentId) }, { status: 201 });
    }
    if (parts[0] === "bodies" && parts[1]) {
      const mine = fakeBodies.get(parts[1]);
      if (method === "DELETE" && parts.length === 2) return Response.json({ removed: fakeBodies.delete(parts[1]) });
      if (!mine) return noBody();
      if (method === "GET" && parts.length === 2) return Response.json({ body: { figure: mine.figure, x: 0, z: 0, heading: 0, posture: "standing" } });
      if (method === "GET" && parts[2] === "observe") return Response.json({ observation: fakeObservation(parts[1]) });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  },
};

const app = createApp({ sim: fakeSim });
const json = (token?: string) => ({
  "content-type": "application/json",
  "x-forwarded-for": "198.51.100.77",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

let rpcId = 0;
async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await app.request("/mcp/agent", {
    method: "POST",
    headers: { ...json(token), accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  return JSON.parse(body.result.content[0].text);
}

async function ownerWithAgent() {
  const email = `economy-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", { method: "POST", headers: json(), body: JSON.stringify({ email, password: "password123" }) });
  expect(reg.status).toBe(201);
  const { token: session } = (await reg.json()) as any;
  const created = await app.request("/owners/agents", { method: "POST", headers: json(session), body: JSON.stringify({ name: `EcoMcp-${Math.random().toString(36).slice(2, 8)}`, capabilities: [] }) });
  expect(created.status).toBe(201);
  const { agent, agentToken } = (await created.json()) as any;
  return { session: session as string, agentId: agent.id as string, agentToken: agentToken as string };
}

describe("agent MCP self block", () => {
  test("agent_whoami carries self with fresh-agent defaults", async () => {
    const o = await ownerWithAgent();
    const whoami = await callTool(o.agentToken, "agent_whoami");
    // Phase 3: load-in claims the first-login stipend, so a fresh agent's
    // first whoami already shows its 1,000 credits and 5 login XP.
    expect(whoami.self).toEqual({
      energy: 100, credits: 1000, xp: 5, level: 1, nextLevelXp: 100, wants: [], bag: [],
    });
  });

  test("world_observe carries the same self block, reflecting ledger, bag, energy and wants", async () => {
    const o = await ownerWithAgent();
    const visit = await app.request(`/owners/agents/${o.agentId}/visits`, {
      method: "POST", headers: json(o.session), body: JSON.stringify({ minutes: 30, maxActions: 50 }),
    });
    expect(visit.status).toBe(201);
    await db.insert(verseProgressEvents).values({ agentId: o.agentId, kind: "pickup", source: "garden-keepsake", credits: 250, xp: 450 });
    const [jar] = await db.insert(verseInventory).values({ agentId: o.agentId, name: "Stone Cabin tea jar" }).returning();
    await db.insert(verseAgentState).values({ agentId: o.agentId, energy: 37, wants: [{ item: "Lantern", maxPrice: 50 }] });

    const attach = await callTool(o.agentToken, "body_attach", { body: "cipher" });
    expect(attach.observation.body.figure).toBe("cipher");

    const seen = await callTool(o.agentToken, "world_observe");
    // Phase 3 on top of the seeded ledger: the observe claims the
    // first-login stipend (+1,000 credits, +5 XP). This fixture's
    // observation is at no place, so no place XP lands.
    expect(seen.self).toEqual({
      energy: 37, credits: 1250, xp: 455, level: 3, nextLevelXp: 900,
      wants: [{ item: "Lantern", maxPrice: 50 }],
      bag: [{ id: jar.id, name: "Stone Cabin tea jar" }],
    });

    const whoami = await callTool(o.agentToken, "agent_whoami");
    expect(whoami.self).toEqual(seen.self);
  });
});
