import { describe, expect, test, beforeAll } from "bun:test";
import { createApp } from "../app";
import { ensureNativeAgents } from "../jobs/nativeAgents";

const app = createApp();

function json(token?: string) {
  return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

async function ownerToken() {
  const email = `agentname-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", { method: "POST", headers: json(), body: JSON.stringify({ email, password: "password123" }) });
  return ((await reg.json()) as any).token as string;
}

beforeAll(async () => {
  await ensureNativeAgents();
});

describe("agent name uniqueness at registration", () => {
  test("an omitted name gets a generated one, and two omitted names in a row differ", async () => {
    const owner = await ownerToken();
    const a = await app.request("/owners/agents", { method: "POST", headers: json(owner), body: JSON.stringify({ capabilities: [] }) });
    expect(a.status).toBe(201);
    const nameA = ((await a.json()) as any).agent.name as string;
    expect(nameA.length).toBeGreaterThan(0);

    const b = await app.request("/owners/agents", { method: "POST", headers: json(owner), body: JSON.stringify({ capabilities: [] }) });
    const nameB = ((await b.json()) as any).agent.name as string;
    expect(nameB).not.toBe(nameA);
  });

  test("a blank name is treated the same as an omitted one, not rejected", async () => {
    const owner = await ownerToken();
    const res = await app.request("/owners/agents", { method: "POST", headers: json(owner), body: JSON.stringify({ name: "   ", capabilities: [] }) });
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).agent.name.trim().length).toBeGreaterThan(0);
  });

  test("owner-provisioned registration rejects a taken name, case-insensitively", async () => {
    const owner = await ownerToken();
    const label = `Unique-${Date.now()}`;
    const first = await app.request("/owners/agents", { method: "POST", headers: json(owner), body: JSON.stringify({ name: label, capabilities: [] }) });
    expect(first.status).toBe(201);

    const second = await app.request("/owners/agents", { method: "POST", headers: json(owner), body: JSON.stringify({ name: label.toUpperCase(), capabilities: [] }) });
    expect(second.status).toBe(409);
    expect(((await second.json()) as any).error).toBe("name taken");
  });

  test("self-registration rejects a taken name, and the two registration paths share one namespace", async () => {
    const owner = await ownerToken();
    const label = `CrossPath-${Date.now()}`;
    const viaOwner = await app.request("/owners/agents", { method: "POST", headers: json(owner), body: JSON.stringify({ name: label, capabilities: [] }) });
    expect(viaOwner.status).toBe(201);

    const viaSelfRegister = await app.request("/agents/register", { method: "POST", headers: json(), body: JSON.stringify({ name: label, capabilities: [] }) });
    expect(viaSelfRegister.status).toBe(409);

    const omittedOnSelfRegister = await app.request("/agents/register", { method: "POST", headers: json(), body: JSON.stringify({ capabilities: [] }) });
    expect(omittedOnSelfRegister.status).toBe(201);
    expect(((await omittedOnSelfRegister.json()) as any).agentId).toBeDefined();
  });

  test("a native agent's exact name is refused, so an @-mention can never hit two agents", async () => {
    const owner = await ownerToken();
    const res = await app.request("/owners/agents", { method: "POST", headers: json(owner), body: JSON.stringify({ name: "sage", capabilities: [] }) });
    expect(res.status).toBe(409);
  });
});
