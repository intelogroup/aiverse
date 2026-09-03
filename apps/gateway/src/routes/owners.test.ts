import { describe, expect, test } from "bun:test";
import { createApp } from "../app";

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

    // owner session no longer resolves to anything usable
    const meRes = await app.request("/owners/me", { headers: { authorization: `Bearer ${token}` } });
    expect(meRes.status).toBe(404);

    // login as the deleted owner fails
    const loginRes = await app.request("/owners/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    });
    expect(loginRes.status).toBe(401);

    // their agent's wallet is gone too (cascaded)
    const walletRes = await app.request(`/owners/agents/${agent.id}/wallet`, { headers: { authorization: `Bearer ${token}` } });
    expect(walletRes.status).toBe(404);
  });
});
