// A person can have OWNER_MAX_ACTIVE_AGENTS (2) agents in the world at once, counted by identity key, not by owner id.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { agentVisits } from "@aiverse/shared/schema";
import { createApp } from "../app";
import { websocket } from "../ws/gateway";
import { clearAuthCaches } from "../auth/authCache";
import { OWNER_MAX_ACTIVE_AGENTS, startVisitIfNoneActive } from "../policy/visits";

const app = createApp();
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
afterAll(() => { server.stop(true); });
beforeEach(() => clearAuthCaches());

const json = (token?: string) => ({ "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) });
const uniq = () => `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;

async function register(email: string) {
  const reg = await app.request("/owners/register", { method: "POST", headers: json(), body: JSON.stringify({ email, password: "password123" }) });
  expect(reg.status).toBe(201);
  const { token, owner } = (await reg.json()) as any;
  return { ownerToken: token as string, ownerId: owner.id as string };
}
async function agentFor(ownerToken: string, label: string) {
  const res = await app.request("/owners/agents", { method: "POST", headers: json(ownerToken), body: JSON.stringify({ name: `${label}${uniq()}` }) });
  expect(res.status).toBe(201);
  return ((await res.json()) as any).agent.id as string;
}
const start = (ownerToken: string, agentId: string) =>
  app.request(`/owners/agents/${agentId}/visits`, { method: "POST", headers: json(ownerToken), body: JSON.stringify({ minutes: 30, maxActions: 100 }) });
const stop = (ownerToken: string, agentId: string, visitId: string) =>
  app.request(`/owners/agents/${agentId}/visits/${visitId}/stop`, { method: "POST", headers: json(ownerToken) });

describe("the cap of agents in the world per person", () => {
  test("the default is 2", () => { expect(OWNER_MAX_ACTIVE_AGENTS).toBe(2); });

  test("a third start is refused with owner_cap and names the two that hold the slots; stopping one frees a slot", async () => {
    const { ownerToken } = await register(`cap-${uniq()}@example.com`);
    const [a, b, c] = [await agentFor(ownerToken, "CapA"), await agentFor(ownerToken, "CapB"), await agentFor(ownerToken, "CapC")];
    const first = await start(ownerToken, a);
    expect(first.status).toBe(201);
    expect((await start(ownerToken, b)).status).toBe(201);
    const refused = await start(ownerToken, c);
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as any;
    expect(body.error).toBe("owner_cap");
    expect(body.limit).toBe(2);
    expect([...body.activeAgentIds].sort()).toEqual([a, b].sort());
    const { visit } = (await first.json()) as any;
    expect((await stop(ownerToken, a, visit.id)).status).toBe(200);
    expect((await start(ownerToken, c)).status).toBe(201);
  });

  test("a second account that is the same mailbox shares the allowance", async () => {
    const id = uniq();
    const one = await register(`cap.${id}@gmail.com`);
    const alias = await register(`cap${id}+second@gmail.com`);
    expect(one.ownerId).not.toBe(alias.ownerId);
    expect((await start(one.ownerToken, await agentFor(one.ownerToken, "AliasA"))).status).toBe(201);
    expect((await start(alias.ownerToken, await agentFor(alias.ownerToken, "AliasB"))).status).toBe(201);
    const refused = await start(alias.ownerToken, await agentFor(alias.ownerToken, "AliasC"));
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as any).error).toBe("owner_cap");
  });

  test("a different mailbox is not affected", async () => {
    const full = await register(`capfull-${uniq()}@example.com`);
    await start(full.ownerToken, await agentFor(full.ownerToken, "FullA"));
    await start(full.ownerToken, await agentFor(full.ownerToken, "FullB"));
    const other = await register(`capother-${uniq()}@example.com`);
    expect((await start(other.ownerToken, await agentFor(other.ownerToken, "Other"))).status).toBe(201);
  });

  test("four starts at the same moment let exactly two in", async () => {
    const { ownerToken } = await register(`caprace-${uniq()}@example.com`);
    const agents = await Promise.all([1, 2, 3, 4].map((n) => agentFor(ownerToken, `Race${n}`)));
    const results = await Promise.all(agents.map((a) => start(ownerToken, a)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 409, 409]);
  });

  test("a visit past its deadline that the sweep has not ended yet holds no slot", async () => {
    const { ownerToken } = await register(`capexp-${uniq()}@example.com`);
    const [a, b, c] = [await agentFor(ownerToken, "ExpA"), await agentFor(ownerToken, "ExpB"), await agentFor(ownerToken, "ExpC")];
    const { visit } = (await (await start(ownerToken, a)).json()) as any;
    await start(ownerToken, b);
    expect((await start(ownerToken, c)).status).toBe(409);
    await db.update(agentVisits).set({ endsAt: new Date(Date.now() - 1000) }).where(eq(agentVisits.id, visit.id));
    expect((await start(ownerToken, c)).status).toBe(201);
  });

  test("the shared start path (claim auto-start, owner presence) reports the cap instead of throwing", async () => {
    const { ownerToken, ownerId } = await register(`capfn-${uniq()}@example.com`);
    await start(ownerToken, await agentFor(ownerToken, "FnA"));
    await start(ownerToken, await agentFor(ownerToken, "FnB"));
    const third = await agentFor(ownerToken, "FnC");
    const out = await startVisitIfNoneActive(third, ownerId, 30, 100);
    expect(out.visit).toBeNull();
    expect(out.created).toBe(false);
    expect(out.capped?.limit).toBe(2);
    expect(out.capped?.agentIds.length).toBe(2);
  });
});
