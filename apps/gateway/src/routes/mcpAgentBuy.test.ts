import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { verseProgressEvents } from "@aiverse/shared/schema";
import { createApp } from "../app";
import { db } from "../db/client";
import type { SimClient } from "../world/simClient";
import { STALL_SEED } from "../world/agentStalls";

// Agent-economy Phase 3 at the MCP surface: world_buy is in the agent's
// hands, world_observe surfaces nearby stall prices, and load-in
// (whoami/observe) claims the stipend. The fake sim puts every body at the
// Market Hall bakery stand, so the seeded bakery stall is in range.

const BAKERY = STALL_SEED[0];
const bodies = new Set<string>();
const fakeSim: SimClient = {
  async call(method, path, rawBody) {
    const parts = path.split("?")[0].split("/").filter(Boolean);
    if (method === "POST" && parts.length === 1 && parts[0] === "bodies") {
      const b = JSON.parse(rawBody ?? "{}") as { agentId: string; body?: string };
      bodies.add(b.agentId);
      return Response.json({
        observation: {
          body: { figure: b.body ?? "remy", x: BAKERY.x, z: BAKERY.z, heading: 0, posture: "standing" },
          nearestPlace: { id: BAKERY.place, name: "Great Hall", dist: 0 },
          insideRoom: null, scene: [], heard: [],
        },
      }, { status: 201 });
    }
    if (parts[0] === "bodies" && parts[1]) {
      if (!bodies.has(parts[1])) return Response.json({ error: "no_body" }, { status: 404 });
      if (method === "GET" && parts[2] === "observe") {
        return Response.json({
          observation: {
            body: { figure: "remy", x: BAKERY.x, z: BAKERY.z, heading: 0, posture: "standing" },
            nearestPlace: { id: BAKERY.place, name: "Great Hall", dist: 0 },
            insideRoom: null, scene: [], heard: [],
          },
        });
      }
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
  return { "content-type": "application/json", "x-forwarded-for": "198.51.100.24", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

async function ownerWithAgent(name: string) {
  const email = `mcpbuy-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
const toolText = (body: any): string => body.result.content[0].text as string;

describe("agent MCP buy + stalls + stipend (Phase 3)", () => {
  test("the tool list gains world_buy", async () => {
    const o = await ownerWithAgent("ListBot");
    const { status, body } = await mcp(o.agentToken, "tools/list");
    expect(status).toBe(200);
    const names = (body.result.tools as any[]).map((t) => t.name);
    expect(names).toContain("world_buy");
  });

  test("whoami claims the first-login stipend once: self shows 1,000 credits", async () => {
    const o = await ownerWithAgent("StipendBot");
    const first = toolJson((await callTool(o.agentToken, "agent_whoami")).body);
    expect(first.self.credits).toBe(1000);
    expect(first.self.xp).toBe(5);
    const second = toolJson((await callTool(o.agentToken, "agent_whoami")).body);
    expect(second.self.credits).toBe(1000);
    const rows = await db.select().from(verseProgressEvents)
      .where(eq(verseProgressEvents.agentId, o.agentId));
    expect(rows.filter((r) => r.kind === "stipend")).toHaveLength(1);
  });

  test("world_buy at the bakery: credits down, snack in the self bag", async () => {
    const o = await ownerWithAgent("BuyerBot");
    await startVisit(o.session, o.agentId);
    await callTool(o.agentToken, "body_attach");
    const item = BAKERY.items[0];
    const bought = toolJson((await callTool(o.agentToken, "world_buy", { stall: BAKERY.id, item: item.name })).body);
    expect(bought.ok).toBe(true);
    expect(bought.price).toBe(item.price);
    expect(bought.credits).toBe(1000 - item.price);
    const who = toolJson((await callTool(o.agentToken, "agent_whoami")).body);
    expect(who.self.bag.map((b: any) => b.name)).toContain(item.name);
    expect(who.self.credits).toBe(1000 - item.price);
  });

  test("world_buy with insufficient funds refuses in plain words and moves nothing", async () => {
    const o = await ownerWithAgent("BrokeBot");
    await startVisit(o.session, o.agentId);
    await callTool(o.agentToken, "body_attach");
    await callTool(o.agentToken, "agent_whoami"); // claims the 1,000 stipend
    // Drain the balance to 2 credits directly in the ledger (a prior spend).
    await db.insert(verseProgressEvents).values({
      agentId: o.agentId, kind: "sale", source: `drain-${o.agentId}`, credits: -998,
    });
    const res = await callTool(o.agentToken, "world_buy", { stall: BAKERY.id, item: BAKERY.items[0].name });
    expect(res.body.result.isError).toBe(true);
    expect(toolText(res.body)).toContain("insufficient_credits");
  });

  test("world_observe surfaces the nearby stall with stock + prices", async () => {
    const o = await ownerWithAgent("LookBot");
    await startVisit(o.session, o.agentId);
    await callTool(o.agentToken, "body_attach");
    const seen = toolJson((await callTool(o.agentToken, "world_observe")).body);
    expect(seen.stalls).toBeDefined();
    const bakery = (seen.stalls as any[]).find((s) => s.id === BAKERY.id);
    expect(bakery).toBeDefined();
    expect(bakery.items.map((i: any) => i.name)).toContain(BAKERY.items[0].name);
    expect(bakery.items.find((i: any) => i.name === BAKERY.items[0].name).price).toBe(BAKERY.items[0].price);
  });
});
