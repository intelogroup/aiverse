import { randomUUID } from "node:crypto";
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { owners, verseBounties, verseBountyClaims, verseProgressEvents } from "@aiverse/shared/schema";
import { createApp } from "../app";
import { signOwnerSession } from "../auth/session";
import { db } from "../db/client";

const app = createApp();
const request = (path: string, token?: string, body?: unknown) => app.request(path, {
  method: body === undefined ? "GET" : "POST",
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function createAgent(visit = false) {
  const [owner] = await db.insert(owners).values({
    email: `economy-${randomUUID()}@example.com`, passwordHash: "unused-in-route-test",
  }).returning();
  const ownerToken = await signOwnerSession(owner.id, owner.sessionVersion);
  const creation = await request("/owners/agents", ownerToken, { name: `Bag-${randomUUID().slice(0, 12)}` });
  expect(creation.status).toBe(201);
  const { agent, agentToken } = await creation.json();
  if (visit) expect((await request(`/owners/agents/${agent.id}/visits`, ownerToken, { minutes: 5, maxActions: 20 })).status).toBe(201);
  return { id: agent.id as string, ownerToken: ownerToken as string, agentToken: agentToken as string };
}

async function adminToken() {
  const email = "admin-test@example.com";
  await db.insert(owners).values({ email, passwordHash: "unused-in-route-test" }).onConflictDoNothing();
  const admin = await db.query.owners.findFirst({ where: eq(owners.email, email) });
  return signOwnerSession(admin!.id, admin!.sessionVersion);
}

test("inventory is private and a retried or competing transfer cannot copy an item", async () => {
  const [sender, first, second, admin] = await Promise.all([createAgent(), createAgent(), createAgent(), adminToken()]);
  const grant = { agentId: sender.id, name: "Blue ceramic bowl" };
  expect((await request("/admin/verse/inventory", sender.ownerToken, grant)).status).toBe(403);
  const issued = await request("/admin/verse/inventory", admin, grant);
  expect(issued.status).toBe(201);
  const { item } = await issued.json();
  const ownerPath = `/owners/agents/${sender.id}/inventory`;
  expect((await request(ownerPath, first.ownerToken)).status).toBe(404);
  expect((await (await request(ownerPath, sender.ownerToken)).json()).items).toEqual([item]);
  const move = (token: string, toAgentId: string, revision: number) =>
    request(`/verse/inventory/${item.id}/transfer`, token, { toAgentId, revision });
  const moves = await Promise.all([first, second].map((recipient) => move(sender.agentToken, recipient.id, 0)));
  expect(moves.map((r) => r.status).sort()).toEqual([200, 409]);
  const winner = moves[0].ok ? first : second;
  expect((await (await request("/verse/inventory", winner.agentToken)).json()).items)
    .toEqual([{ ...item, agentId: winner.id, revision: 1 }]);
  expect((await move(winner.agentToken, sender.id, 1)).status).toBe(200);
  expect((await move(sender.agentToken, winner.id, 0)).status).toBe(409);
});

test("a claim window deduplicates entrants and concurrent settlement grants one item", async () => {
  const [first, second, late, inactive, admin] = await Promise.all([
    createAgent(true), createAgent(true), createAgent(true), createAgent(), adminToken(),
  ]);
  const creation = await request("/admin/verse/bounties", admin, { title: "City 3 bounty", rewardName: "Ceramic token" });
  expect(creation.status).toBe(201);
  const { bounty } = await creation.json();
  const claim = (token: string) => request(`/verse/bounties/${bounty.id}/claim`, token, {});
  const settle = (token = admin) => request(`/admin/verse/bounties/${bounty.id}/settle`, token, {});
  expect((await claim(inactive.agentToken)).status).toBe(403);
  expect((await settle(first.ownerToken)).status).toBe(403);
  expect((await settle()).status).toBe(409);
  const claims = await Promise.all([first, first, second].map((entrant) => claim(entrant.agentToken)));
  expect(claims.map((r) => r.status)).toEqual([200, 200, 200]);
  expect(await db.select().from(verseBountyClaims).where(eq(verseBountyClaims.bountyId, bounty.id))).toHaveLength(2);
  await db.update(verseBounties).set({ closesAt: new Date(Date.now() - 1000) }).where(eq(verseBounties.id, bounty.id));
  expect((await claim(late.agentToken)).status).toBe(410);
  const results = await Promise.all([settle(), settle(), settle()]);
  expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
  const [a, b, c] = await Promise.all(results.map((r) => r.json()));
  expect(a).toEqual(b);
  expect(a).toEqual(c);
  expect([first.id, second.id]).toContain(a.bounty.winnerAgentId);
  const bags = await Promise.all([first, second, late].map(async (agent) =>
    (await (await request("/verse/inventory", agent.agentToken)).json()).items));
  expect(bags.flat()).toEqual([{ id: a.bounty.rewardItemId, agentId: a.bounty.winnerAgentId, name: "Ceramic token", revision: 0 }]);
});

test("paid sales settle once, preserve credits, reject stale offers, and expose private receipts", async () => {
  const previous = process.env.AIVERSE_VERSE_PROGRESS;
  process.env.AIVERSE_VERSE_PROGRESS = "1";
  try {
    const [seller, first, second, unfunded, admin] = await Promise.all([
      createAgent(), createAgent(), createAgent(), createAgent(), adminToken(),
    ]);
    await db.insert(verseProgressEvents).values([first, second].map((buyer) => ({
      agentId: buyer.id, kind: "pickup", source: "sale-test", credits: 5,
    })));
    const issue = async (name: string) => {
      const response = await request("/admin/verse/inventory", admin, { agentId: seller.id, name });
      expect(response.status).toBe(201);
      return (await response.json()).item;
    };
    const listing = async (itemId: string) => {
      const response = await request("/verse/sales", seller.agentToken, { itemId, revision: 0, price: 4 });
      expect(response.status).toBe(200);
      return (await response.json()).offer;
    };
    const buy = (agent: typeof seller, offerId: string) => request(`/verse/sales/${offerId}/buy`, agent.agentToken, {});
    const inventory = async (agent: typeof seller) =>
      (await request(`/owners/agents/${agent.id}/inventory`, agent.ownerToken)).json();
    const item = await issue("Market bowl");
    const offer = await listing(item.id);
    expect(await listing(item.id)).toEqual(offer);
    expect(await (await buy(seller, offer.id)).json()).toEqual({ error: "own_offer" });
    expect(await (await buy(unfunded, offer.id)).json()).toEqual({ error: "insufficient_credits" });

    const attempts = await Promise.all([buy(first, offer.id), buy(second, offer.id)]);
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = attempts[0].ok ? first : second;
    const loser = attempts[0].ok ? second : first;
    const accepted = await attempts.find((r) => r.ok)!.json();
    expect(await (await buy(winner, offer.id)).json()).toEqual(accepted);

    const bags = await Promise.all([inventory(seller), inventory(winner), inventory(loser)]);
    expect(bags.map((bag) => bag.progress.credits)).toEqual([4, 1, 5]);
    expect(bags.map((bag) => bag.items)).toEqual([[], [{ ...item, agentId: winner.id, revision: 1 }], []]);
    expect(bags.map((bag) => bag.receipts.map((receipt: { side: string }) => receipt.side)))
      .toEqual([["sold"], ["bought"], []]);
    expect((await request(`/owners/agents/${winner.id}/inventory`, loser.ownerToken)).status).toBe(404);

    const staleItem = await issue("Market cup");
    const stale = await listing(staleItem.id);
    expect((await request(`/verse/inventory/${staleItem.id}/transfer`, seller.agentToken, {
      toAgentId: unfunded.id, revision: 0,
    })).status).toBe(200);
    expect(await (await buy(loser, stale.id)).json()).toEqual({ error: "stale_offer" });
    const { offers } = await (await request("/verse/sales", loser.agentToken)).json();
    expect(offers.some((row: { id: string }) => [offer.id, stale.id].includes(row.id))).toBe(false);

    const competing = await Promise.all([issue("Pin"), issue("Badge")]);
    const offersForOneBuyer = await Promise.all(competing.map((row) => listing(row.id)));
    const spending = await Promise.all(offersForOneBuyer.map((row) => buy(loser, row.id)));
    expect(spending.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await inventory(loser)).progress.credits).toBe(1);
  } finally {
    if (previous === undefined) delete process.env.AIVERSE_VERSE_PROGRESS;
    else process.env.AIVERSE_VERSE_PROGRESS = previous;
  }
});
