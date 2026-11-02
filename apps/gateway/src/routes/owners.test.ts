import { describe, expect, test } from "bun:test";
import { createApp } from "../app";
import { resetMemoryStoreForTests } from "../policy/memoryStore";
import { eq } from "drizzle-orm";
import { agents, agentWallets } from "@aiverse/shared/schema";
import { db } from "../db/client";

const app = createApp();

function uniqueEmail() {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

describe("owner registration + agent lifecycle", () => {
  test("register, login, create agent, list agents", async () => {
    const email = uniqueEmail();
    const password = "password123";

    const registerRes = await app.request("/owners/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    expect(registerRes.status).toBe(201);
    const { token } = await registerRes.json();
    expect(typeof token).toBe("string");

    const loginRes = await app.request("/owners/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    expect(loginRes.status).toBe(200);

    const createAgentRes = await app.request("/owners/agents", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "TestAgent", capabilities: ["research"] }),
    });
    expect(createAgentRes.status).toBe(201);
    const created = await createAgentRes.json();
    expect(created.agentToken).toBeString();
    expect(created.agent.agentCard.capabilities).toEqual(["research"]);

    const listRes = await app.request("/owners/agents", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listRes.status).toBe(200);
    const { agents } = await listRes.json();
    expect(agents.some((a: { name: string }) => a.name === "TestAgent")).toBe(true);
  });

  test("duplicate email registration rejected", async () => {
    const email = uniqueEmail();
    const password = "password123";
    await app.request("/owners/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const second = await app.request("/owners/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    expect(second.status).toBe(409);
  });

  test("owner-scoped routes reject missing/invalid token", async () => {
    const noAuth = await app.request("/owners/agents");
    expect(noAuth.status).toBe(401);

    const badAuth = await app.request("/owners/agents", {
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(badAuth.status).toBe(401);
  });
});

describe("hard delete", () => {
  async function registerAndAuth() {
    const email = uniqueEmail();
    const registerRes = await app.request("/owners/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    });
    const { token } = await registerRes.json();
    return { email, token };
  }

  test("DELETE /agents/:id removes the agent and its wallet/policy", async () => {
    const { token } = await registerAndAuth();
    const createRes = await app.request("/owners/agents", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "ToDelete" }),
    });
    const { agent } = await createRes.json();

    const delRes = await app.request(`/owners/agents/${agent.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(delRes.status).toBe(200);

    const listRes = await app.request("/owners/agents", { headers: { authorization: `Bearer ${token}` } });
    const { agents } = await listRes.json();
    expect(agents.find((a: { id: string }) => a.id === agent.id)).toBeUndefined();

    const walletRes = await app.request(`/owners/agents/${agent.id}/wallet`, { headers: { authorization: `Bearer ${token}` } });
    expect(walletRes.status).toBe(404);

    // deleting again 404s — the row is actually gone, not just hidden
    const redelete = await app.request(`/owners/agents/${agent.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(redelete.status).toBe(404);
  });

  test("DELETE /agents/:id refuses an agent the caller doesn't own", async () => {
    const owner1 = await registerAndAuth();
    const owner2 = await registerAndAuth();
    const createRes = await app.request("/owners/agents", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner1.token}` },
      body: JSON.stringify({ name: "NotYours" }),
    });
    const { agent } = await createRes.json();

    const delRes = await app.request(`/owners/agents/${agent.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${owner2.token}` },
    });
    expect(delRes.status).toBe(404);
  });

  test("DELETE /me requires confirmEmail to match, then removes owner and all their agents", async () => {
    const { email, token } = await registerAndAuth();
    const createRes = await app.request("/owners/agents", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "OwnedByDeletedOwner" }),
    });
    const { agent } = await createRes.json();

    const wrongConfirm = await app.request("/owners/me", {
      method: "DELETE",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ confirmEmail: "wrong@example.com" }),
    });
    expect(wrongConfirm.status).toBe(400);

    const delRes = await app.request("/owners/me", {
      method: "DELETE",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ confirmEmail: email }),
    });
    expect(delRes.status).toBe(200);

    // owner session is rejected outright — verifyOwnerSession checks the row
    const meRes = await app.request("/owners/me", { headers: { authorization: `Bearer ${token}` } });
    expect(meRes.status).toBe(401);

    // login as the deleted owner fails
    const loginRes = await app.request("/owners/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    });
    expect(loginRes.status).toBe(401);

    // their agent and its wallet are gone too (cascaded) — checked in the DB,
    // since the deleted owner's token no longer authenticates at all
    expect(await db.query.agents.findFirst({ where: eq(agents.id, agent.id) })).toBeUndefined();
    expect(await db.query.agentWallets.findFirst({ where: eq(agentWallets.agentId, agent.id) })).toBeUndefined();
  });
});

// Every /owners/agents/:id/* route gates through the shared loadOwnedAgent
// helper (owners.ts) — these two cover the highest-sensitivity data it
// protects (spend/budget, and the owner-authored mandate) as regression
// coverage for that shared pattern, rather than duplicating the same
// assertion across all ~15 routes that call it.
describe("owner-scoped agent routes refuse a non-owning caller (BOLA regression)", () => {
  async function registerAndAuth() {
    const email = `bola-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const registerRes = await app.request("/owners/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    });
    const { token } = await registerRes.json();
    return { email, token };
  }

  async function createAgent(token: string) {
    // Called once per test in this block — a fixed literal name would collide
    // with itself from the second test onward now that names are unique.
    const createRes = await app.request("/owners/agents", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: `BolaTarget-${Date.now()}-${Math.random().toString(36).slice(2)}` }),
    });
    return (await createRes.json()).agent as { id: string };
  }

  test("GET /agents/:id/wallet refuses an owner who doesn't own it", async () => {
    const owner1 = await registerAndAuth();
    const owner2 = await registerAndAuth();
    const agent = await createAgent(owner1.token);

    const asOutsider = await app.request(`/owners/agents/${agent.id}/wallet`, {
      headers: { authorization: `Bearer ${owner2.token}` },
    });
    expect(asOutsider.status).toBe(404);

    const asOwner = await app.request(`/owners/agents/${agent.id}/wallet`, {
      headers: { authorization: `Bearer ${owner1.token}` },
    });
    expect(asOwner.status).toBe(200);
  });

  test("PATCH /agents/:id/wallet refuses an owner who doesn't own it (can't raise a stranger's budget)", async () => {
    const owner1 = await registerAndAuth();
    const owner2 = await registerAndAuth();
    const agent = await createAgent(owner1.token);

    const asOutsider = await app.request(`/owners/agents/${agent.id}/wallet`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner2.token}` },
      body: JSON.stringify({ dailyTokenBudget: 999_999_999 }),
    });
    expect(asOutsider.status).toBe(404);

    const walletRes = await app.request(`/owners/agents/${agent.id}/wallet`, {
      headers: { authorization: `Bearer ${owner1.token}` },
    });
    expect((await walletRes.json()).wallet.dailyTokenBudget).not.toBe(999_999_999);
  });

  test("PUT /agents/:id/mandate refuses an owner who doesn't own it", async () => {
    const owner1 = await registerAndAuth();
    const owner2 = await registerAndAuth();
    const agent = await createAgent(owner1.token);

    const asOutsider = await app.request(`/owners/agents/${agent.id}/mandate`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner2.token}` },
      body: JSON.stringify({ objectives: ["do things for owner2 instead"] }),
    });
    expect(asOutsider.status).toBe(404);

    // agent creation seeds a default mandate now (see owners.ts
    // DEFAULT_EAGER_OBJECTIVES) — assert owner2's write didn't land, not
    // that no mandate exists.
    const mandateRes = await app.request(`/owners/agents/${agent.id}/mandate`, {
      headers: { authorization: `Bearer ${owner1.token}` },
    });
    const mandate = (await mandateRes.json()).mandate;
    expect(mandate).not.toBeNull();
    expect(mandate.objectives).not.toContain("do things for owner2 instead");
  });

  test("PATCH /agents/:id/profile refuses an owner who doesn't own it", async () => {
    const owner1 = await registerAndAuth();
    const owner2 = await registerAndAuth();
    const agent = await createAgent(owner1.token);

    const asOutsider = await app.request(`/owners/agents/${agent.id}/profile`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner2.token}` },
      body: JSON.stringify({ personalityPrompt: "owned by owner2 now" }),
    });
    expect(asOutsider.status).toBe(404);

    const asOwner = await app.request(`/owners/agents/${agent.id}/profile`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner1.token}` },
      body: JSON.stringify({ personalityPrompt: "personal assistant and finance expert" }),
    });
    expect(asOwner.status).toBe(200);
    const body = await asOwner.json();
    expect(body.agent.personalityPrompt).toBe("personal assistant and finance expert");
  });

  test("PATCH /agents/:id/profile rejects an oversized personalityPrompt", async () => {
    const owner1 = await registerAndAuth();
    const agent = await createAgent(owner1.token);

    const res = await app.request(`/owners/agents/${agent.id}/profile`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner1.token}` },
      body: JSON.stringify({ personalityPrompt: "x".repeat(2001) }),
    });
    expect(res.status).toBe(400);
  });
});

// Regressions for AIV-OWNER-TEXT-TYPE-001 (cycle 2026-11-02-0807) and the
// owners half of AIV-REMAINING-TYPE-001 (cycle 2026-11-02-0507), plus the
// fix-pass sweep of the same handler: text fields were used after only
// truthiness / ?? / ?. guards — the read-key label and agent name threw
// TypeError → 500 on truthy non-strings, while displayName (PATCH /me and
// register) was silently ACCEPTED for number/boolean/object/float because
// .length is undefined on those types and both range comparisons pass.
// The agent-card description/capabilities fields shared the .length-only
// shape and are pinned here too.
describe("owner text-field type validation (AIV-OWNER-TEXT-TYPE-001 / AIV-REMAINING-TYPE-001 regressions)", () => {
  const hostile: unknown[] = [12345, true, ["a valid label"], { text: "a valid label" }, 1.5];
  const json = (token?: string) => ({
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  });

  function expectClean4xx(statuses: number[]) {
    for (const s of statuses) {
      expect(s).toBeGreaterThanOrEqual(400);
      expect(s).toBeLessThan(500);
    }
  }

  async function makeOwnerToken(): Promise<string> {
    const reg = await app.request("/owners/register", {
      method: "POST",
      headers: json(),
      body: JSON.stringify({ email: uniqueEmail(), password: "password123" }),
    });
    expect(reg.status).toBe(201);
    const { token } = (await reg.json()) as { token: string };
    return token;
  }

  test("POST /owners/read-keys with non-string label is clean 4xx, never 500, mints nothing", async () => {
    const ownerToken = await makeOwnerToken();
    const statuses: number[] = [];
    for (const bad of hostile) {
      await resetMemoryStoreForTests();
      const res = await app.request("/owners/read-keys", {
        method: "POST",
        headers: json(ownerToken),
        body: JSON.stringify({ label: bad }),
      });
      statuses.push(res.status);
    }
    expectClean4xx(statuses);
    const list = await app.request("/owners/read-keys", { headers: json(ownerToken) });
    expect(list.status).toBe(200);
    const keys = (await list.json()) as { keys?: unknown[]; readKeys?: unknown[] };
    expect((keys.keys ?? keys.readKeys ?? []).length).toBe(0);
    const ok = await app.request("/owners/read-keys", {
      method: "POST",
      headers: json(ownerToken),
      body: JSON.stringify({ label: "observer laptop" }),
    });
    expect(ok.status).toBe(201);
  });

  test("PATCH /owners/me with non-string displayName is clean 4xx, never 500, changes nothing", async () => {
    const ownerToken = await makeOwnerToken();
    const statuses: number[] = [];
    for (const bad of hostile) {
      await resetMemoryStoreForTests();
      const res = await app.request("/owners/me", {
        method: "PATCH",
        headers: json(ownerToken),
        body: JSON.stringify({ displayName: bad }),
      });
      statuses.push(res.status);
    }
    expectClean4xx(statuses);
    const me = await app.request("/owners/me", { headers: json(ownerToken) });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { owner: { displayName: unknown } }).owner.displayName ?? null).toBeNull();
    const ok = await app.request("/owners/me", {
      method: "PATCH",
      headers: json(ownerToken),
      body: JSON.stringify({ displayName: "Jim Verse" }),
    });
    expect(ok.status).toBe(200);
  });

  test("POST /owners/register with non-string displayName is clean 4xx, never 500", async () => {
    const statuses: number[] = [];
    for (const bad of hostile) {
      await resetMemoryStoreForTests();
      const res = await app.request("/owners/register", {
        method: "POST",
        headers: json(),
        body: JSON.stringify({ email: uniqueEmail(), password: "password123", displayName: bad }),
      });
      statuses.push(res.status);
    }
    expectClean4xx(statuses);
    const ok = await app.request("/owners/register", {
      method: "POST",
      headers: json(),
      body: JSON.stringify({ email: uniqueEmail(), password: "password123", displayName: "Jim Verse" }),
    });
    expect(ok.status).toBe(201);
  });

  test("POST /owners/agents with non-string name is clean 4xx, never 500", async () => {
    const ownerToken = await makeOwnerToken();
    const statuses: number[] = [];
    for (const bad of hostile) {
      await resetMemoryStoreForTests();
      const res = await app.request("/owners/agents", {
        method: "POST",
        headers: json(ownerToken),
        body: JSON.stringify({ name: bad, capabilities: [] }),
      });
      statuses.push(res.status);
    }
    expectClean4xx(statuses);
    const ok = await app.request("/owners/agents", {
      method: "POST",
      headers: json(ownerToken),
      body: JSON.stringify({ name: `OwnerNamed-${Math.random().toString(36).slice(2, 8)}`, capabilities: [] }),
    });
    expect(ok.status).toBe(201);
  });

  test("POST /owners/agents with non-string description or non-string-array capabilities is clean 4xx (sweep)", async () => {
    const ownerToken = await makeOwnerToken();
    const statuses: number[] = [];
    for (const bad of hostile) {
      await resetMemoryStoreForTests();
      const res = await app.request("/owners/agents", {
        method: "POST",
        headers: json(ownerToken),
        body: JSON.stringify({ name: `CardDesc-${Math.random().toString(36).slice(2, 8)}`, capabilities: [], description: bad }),
      });
      statuses.push(res.status);
    }
    // For capabilities the hostile set differs: an array of strings is a
    // VALID value here, so the attacks are the non-arrays (a bare string
    // included — it passed the old .length check and was stored as one).
    const hostileCaps: unknown[] = [12345, true, { text: "a valid name" }, 1.5, "research"];
    for (const bad of hostileCaps) {
      await resetMemoryStoreForTests();
      const res = await app.request("/owners/agents", {
        method: "POST",
        headers: json(ownerToken),
        body: JSON.stringify({ name: `CardCaps-${Math.random().toString(36).slice(2, 8)}`, capabilities: bad }),
      });
      statuses.push(res.status);
    }
    // A capabilities array holding non-string elements is rejected too —
    // it would break the card endpoint's slugify for every reader.
    await resetMemoryStoreForTests();
    const mixed = await app.request("/owners/agents", {
      method: "POST",
      headers: json(ownerToken),
      body: JSON.stringify({ name: `CardCapsMixed-${Math.random().toString(36).slice(2, 8)}`, capabilities: ["research", 42] }),
    });
    statuses.push(mixed.status);
    expectClean4xx(statuses);
    const ok = await app.request("/owners/agents", {
      method: "POST",
      headers: json(ownerToken),
      body: JSON.stringify({
        name: `CardOk-${Math.random().toString(36).slice(2, 8)}`,
        capabilities: ["research"],
        description: "a valid description",
      }),
    });
    expect(ok.status).toBe(201);
  });
});
