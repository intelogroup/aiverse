import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { verseAgentState, verseInventory } from "@aiverse/shared/schema";
import { createApp } from "../app";
import { db } from "../db/client";
import type { SimClient } from "../world/simClient";

// Agent-economy Phase 2 at the MCP surface: world_act drains energy and is
// refused when exhausted; world_rest refills anywhere; world_use eats from
// the bag. The fake sim is the minimal body ledger these tools reach —
// attach + act accepted (202) — everything else is the real gateway.

const bodies = new Set<string>();
const fakeSim: SimClient = {
  async call(method, path, rawBody) {
    const parts = path.split("?")[0].split("/").filter(Boolean);
    if (method === "POST" && parts.length === 1 && parts[0] === "bodies") {
      const b = JSON.parse(rawBody ?? "{}") as { agentId: string; body?: string };
      bodies.add(b.agentId);
      return Response.json({ observation: { body: { figure: b.body ?? "remy" } } }, { status: 201 });
    }
    if (parts[0] === "bodies" && parts[1]) {
      if (!bodies.has(parts[1])) return Response.json({ error: "no_body" }, { status: 404 });
      if (method === "POST" && parts[2] === "act") {
        const b = JSON.parse(rawBody ?? "{}") as { id: string; action: unknown };
        return Response.json({ act: { id: b.id, action: b.action, state: "running", startedAt: 0 } }, { status: 202 });
      }
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  },
};

const app = createApp({ sim: fakeSim });

function json(token?: string) {
  return { "content-type": "application/json", "x-forwarded-for": "198.51.100.23", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

async function ownerWithAgent(name: string) {
  const email = `mcpenergy-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", { method: "POST", headers: json(), body: JSON.stringify({ email, password: "password123" }) });
  expect(reg.status).toBe(201);
  const { token: session } = (await reg.json()) as any;
  const created = await app.request("/owners/agents", { method: "POST", headers: json(session), body: JSON.stringify({ name: `${name}-${Math.random().toString(36).slice(2, 8)}`, capabilities: [] }) });
  expect(created.status).toBe(201);
  const { agent, agentToken } = (await created.json()) as any;
  return { session: session as string, agentId: agent.id as string, agentToken: agentToken as string };
}

const startVisit = async (ownerToken: string, agentId: string) =>
  ((await (await app.request(`/owners/agents/${agentId}/visits`, { method: "POST", headers: json(ownerToken), body: JSON.stringify({ minutes: 30, maxActions: 50 }) })).json()) as any).visit;

let rpcId = 0;
async function mcp(token: string, method: string, params: Record<string, unknown> = {}) {
  const res = await app.request("/mcp/agent", {
    method: "POST",
    headers: { ...json(token), accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return { status: res.status, body: res.status === 200 ? ((await res.json()) as any) : null };
}
const callTool = (token: string, name: string, args: Record<string, unknown> = {}) =>
  mcp(token, "tools/call", { name, arguments: args });
const toolJson = (body: any): any => JSON.parse(body.result.content[0].text as string);

async function setEnergy(agentId: string, energy: number) {
  await db.insert(verseAgentState).values({ agentId, energy })
    .onConflictDoUpdate({ target: verseAgentState.agentId, set: { energy } });
}
async function energyOf(agentId: string) {
  const [row] = await db.select().from(verseAgentState).where(eq(verseAgentState.agentId, agentId));
  return row.energy;
}

describe("agent MCP energy (Phase 2)", () => {
  test("the tool list gains world_rest and world_use", async () => {
    const o = await ownerWithAgent("ListBot");
    const { status, body } = await mcp(o.agentToken, "tools/list");
    expect(status).toBe(200);
    const names = (body.result.tools as any[]).map((t) => t.name);
    expect(names).toContain("world_rest");
    expect(names).toContain("world_use");
  });

  test("world_act drains energy on success; whoami self shows the spend", async () => {
    const o = await ownerWithAgent("DrainBot");
    await startVisit(o.session, o.agentId);
    await callTool(o.agentToken, "body_attach", {});
    const acted = toolJson((await callTool(o.agentToken, "world_act", { action: { type: "go_to", place: "plaza" } })).body);
    expect(acted.energy).toBe(96);
    const who = toolJson((await callTool(o.agentToken, "agent_whoami")).body);
    expect(who.self.energy).toBe(96);
  });

  test("at zero energy world_act is refused exhausted, but world_rest and world_use still work", async () => {
    const o = await ownerWithAgent("TiredBot");
    await startVisit(o.session, o.agentId);
    await callTool(o.agentToken, "body_attach", {});
    await setEnergy(o.agentId, 0);

    const refused = toolJson((await callTool(o.agentToken, "world_act", { action: { type: "go_to", place: "plaza" } })).body);
    expect(refused.outcome).toBe("exhausted");
    expect(refused.energy).toBe(0);
    expect(await energyOf(o.agentId)).toBe(0);

    const rested = toolJson((await callTool(o.agentToken, "world_rest", { seconds: 8 })).body);
    expect(rested.energy).toBe(7);

    await setEnergy(o.agentId, 0);
    await db.insert(verseInventory).values({ agentId: o.agentId, name: "Market Hall bakery sample" });
    const used = toolJson((await callTool(o.agentToken, "world_use", { item: "Market Hall bakery sample" })).body);
    expect(used.energy).toBe(25);
    // and with energy back, acting works again
    const acted = toolJson((await callTool(o.agentToken, "world_act", { action: { type: "go_to", place: "plaza" } })).body);
    expect(acted.energy).toBe(21);
  });

  test("world_use refuses a non-edible item as a tool error", async () => {
    const o = await ownerWithAgent("RelicBot");
    await db.insert(verseInventory).values({ agentId: o.agentId, name: "Sun Relic" });
    const res = await callTool(o.agentToken, "world_use", { item: "Sun Relic" });
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toContain("not_edible");
  });
});
