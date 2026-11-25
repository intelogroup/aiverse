import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { verseInventory, verseSaleOffers } from "@aiverse/shared/schema";
import { createApp } from "../app";
import { db } from "../db/client";
import type { SimClient } from "../world/simClient";
import { STALL_SEED } from "../world/agentStalls";
import { progress } from "../world/verseProgress";

// Agent-economy Phase 4 at the MCP surface: world_wants gives the agent a
// write path for its wants, world_listings shows the agent-to-agent sales
// board with want matches marked, and world_buy with a listing target
// completes the want-driven purchase through the SAME sales transaction
// the REST board uses. Sales are behind the verse-progress flag, like REST.

process.env.AIVERSE_VERSE_PROGRESS = "1";

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
  return { "content-type": "application/json", "x-forwarded-for": "198.51.100.25", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

async function ownerWithAgent(name: string) {
  const email = `mcpwants-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", { method: "POST", headers: json(), body: JSON.stringify({ email, password: "password123" }) });
  expect(reg.status).toBe(201);
  const { token: session } = (await reg.json()) as any;
  const created = await app.request("/owners/agents", { method: "POST", headers: json(session), body: JSON.stringify({ name: `${name}-${Math.random().toString(36).slice(2, 8)}`, capabilities: [] }) });
  expect(created.status).toBe(201);
  const { agent, agentToken } = (await created.json()) as any;
  return { session: session as string, agentId: agent.id as string, agentToken: agentToken as string };
}

/** Give the seller an item and list it on the real REST sales board. */
async function listForSale(seller: { agentId: string; agentToken: string }, name: string, price: number) {
  const [item] = await db.insert(verseInventory).values({ agentId: seller.agentId, name }).returning();
  const res = await app.request("/verse/sales", {
    method: "POST", headers: json(seller.agentToken),
    body: JSON.stringify({ itemId: item.id, revision: item.revision, price }),
  });
  expect(res.status).toBe(200);
  const { offer } = (await res.json()) as any;
  return { item, offer };
}

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

describe("agent MCP wants + trade (Phase 4)", () => {
  test("the tool list gains world_wants and world_listings", async () => {
    const o = await ownerWithAgent("ListBot");
    const { status, body } = await mcp(o.agentToken, "tools/list");
    expect(status).toBe(200);
    const names = (body.result.tools as any[]).map((t) => t.name);
    expect(names).toContain("world_wants");
    expect(names).toContain("world_listings");
  });

  test("world_wants set / list / clear round-trip, mirrored in the whoami self block", async () => {
    const o = await ownerWithAgent("WantBot");
    const set = toolJson((await callTool(o.agentToken, "world_wants", {
      action: "set", wants: [{ item: "Brass Key", maxPrice: 40 }, { item: "Golden Egg" }],
    })).body);
    expect(set.wants).toEqual([{ item: "Brass Key", maxPrice: 40 }, { item: "Golden Egg" }]);
    const listed = toolJson((await callTool(o.agentToken, "world_wants", { action: "list" })).body);
    expect(listed.wants).toEqual(set.wants);
    const who = toolJson((await callTool(o.agentToken, "agent_whoami")).body);
    expect(who.self.wants).toEqual(set.wants);
    const clearedOne = toolJson((await callTool(o.agentToken, "world_wants", { action: "clear", item: "Golden Egg" })).body);
    expect(clearedOne.wants).toEqual([{ item: "Brass Key", maxPrice: 40 }]);
    const clearedAll = toolJson((await callTool(o.agentToken, "world_wants", { action: "clear" })).body);
    expect(clearedAll.wants).toEqual([]);
  });

  test("world_wants refuses an invalid want and keeps the old list", async () => {
    const o = await ownerWithAgent("CarefulBot");
    await callTool(o.agentToken, "world_wants", { action: "set", wants: [{ item: "Kept" }] });
    const res = await callTool(o.agentToken, "world_wants", { action: "set", wants: [{ item: "X", maxPrice: 0 }] });
    expect(res.body.result.isError).toBe(true);
    expect(toolText(res.body)).toContain("invalid_want");
    const listed = toolJson((await callTool(o.agentToken, "world_wants", { action: "list" })).body);
    expect(listed.wants).toEqual([{ item: "Kept" }]);
  });

  test("want-driven purchase end-to-end: listings mark the match, world_buy completes it, want clears", async () => {
    const seller = await ownerWithAgent("SellerBot");
    const buyer = await ownerWithAgent("BuyerBot");
    const { item, offer } = await listForSale(seller, "Brass Key", 30);
    await callTool(buyer.agentToken, "agent_whoami"); // claims the 1,000 stipend
    await callTool(buyer.agentToken, "world_wants", { action: "set", wants: [{ item: "Brass Key", maxPrice: 40 }] });

    const board = toolJson((await callTool(buyer.agentToken, "world_listings")).body);
    const mine = (board.listings as any[]).find((l) => l.id === offer.id);
    expect(mine).toBeDefined();
    expect(mine.matches_want).toBe(true);
    expect(mine.price).toBe(30);

    const bought = toolJson((await callTool(buyer.agentToken, "world_buy", { listing: offer.id })).body);
    expect(bought.ok).toBe(true);
    expect(bought.price).toBe(30);
    expect(bought.credits).toBe(970);

    const who = toolJson((await callTool(buyer.agentToken, "agent_whoami")).body);
    expect(who.self.bag.map((b: any) => b.name)).toContain("Brass Key");
    expect(who.self.wants).toEqual([]); // satisfied
    expect((await progress(seller.agentId)).credits).toBe(30);
    const [moved] = await db.select().from(verseInventory).where(eq(verseInventory.id, item.id));
    expect(moved.agentId).toBe(buyer.agentId);
    const [closed] = await db.select().from(verseSaleOffers).where(eq(verseSaleOffers.id, offer.id));
    expect(closed.buyerId).toBe(buyer.agentId);
  });

  test("maxPrice: a listing above the ceiling is not marked a match and the buy is refused", async () => {
    const seller = await ownerWithAgent("PriceyBot");
    const buyer = await ownerWithAgent("CappedBot");
    const { offer } = await listForSale(seller, "Golden Egg", 500);
    await callTool(buyer.agentToken, "agent_whoami");
    await callTool(buyer.agentToken, "world_wants", { action: "set", wants: [{ item: "Golden Egg", maxPrice: 100 }] });

    const board = toolJson((await callTool(buyer.agentToken, "world_listings")).body);
    expect((board.listings as any[]).find((l) => l.id === offer.id).matches_want).toBe(false);

    const res = await callTool(buyer.agentToken, "world_buy", { listing: offer.id });
    expect(res.body.result.isError).toBe(true);
    expect(toolText(res.body)).toContain("above_max_price");
    expect((await progress(buyer.agentId)).credits).toBe(1000);
    expect((await progress(seller.agentId)).credits).toBe(0);
  });

  test("NO-WANT REGRESSION: a want-less agent is not pushed into a trade", async () => {
    const seller = await ownerWithAgent("QuietSeller");
    const buyer = await ownerWithAgent("NoWantBot");
    const { item, offer } = await listForSale(seller, "Shiny Relic", 10);
    await callTool(buyer.agentToken, "agent_whoami"); // funded, but wants nothing

    const board = toolJson((await callTool(buyer.agentToken, "world_listings")).body);
    expect((board.listings as any[]).find((l) => l.id === offer.id).matches_want).toBe(false);

    const res = await callTool(buyer.agentToken, "world_buy", { listing: offer.id });
    expect(res.body.result.isError).toBe(true);
    expect(toolText(res.body)).toContain("no_matching_want");
    const [still] = await db.select().from(verseInventory).where(eq(verseInventory.id, item.id));
    expect(still.agentId).toBe(seller.agentId);
    expect((await progress(buyer.agentId)).credits).toBe(1000);
  });

  test("world_observe marks stall items that match the agent's wants", async () => {
    const o = await ownerWithAgent("StallWatcher");
    await callTool(o.agentToken, "world_wants", { action: "set", wants: [{ item: BAKERY.items[0].name, maxPrice: 5 }] });
    const visit = await (await app.request(`/owners/agents/${o.agentId}/visits`, {
      method: "POST", headers: json(o.session), body: JSON.stringify({ minutes: 30, maxActions: 50 }),
    })).json() as any;
    expect(visit.visit).toBeDefined();
    await callTool(o.agentToken, "body_attach");
    const seen = toolJson((await callTool(o.agentToken, "world_observe")).body);
    const bakery = (seen.stalls as any[]).find((s) => s.id === BAKERY.id);
    expect(bakery.items.find((i: any) => i.name === BAKERY.items[0].name).matches_want).toBe(true);
    expect(bakery.items.find((i: any) => i.name === BAKERY.items[1].name).matches_want).toBe(false);
  });
});
