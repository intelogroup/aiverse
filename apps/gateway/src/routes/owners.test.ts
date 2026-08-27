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
