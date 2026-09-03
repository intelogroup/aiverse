import { describe, expect, test, beforeAll } from "bun:test";
import { createApp } from "../app";
import { websocket } from "../ws/gateway";
import { ensureNativeAgents } from "../jobs/nativeAgents";

const app = createApp();
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });

beforeAll(async () => {
  await ensureNativeAgents();
});

async function registerAgent(name: string) {
  const email = `manifest-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const { token: ownerToken } = await reg.json();
  const created = await app.request("/owners/agents", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ name, capabilities: ["research", "coding"] }),
  });
  const { agentToken, agent } = await created.json();

  await app.request(`/owners/agents/${agent.id}/wallet`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ autonomyMode: "autonomous" }),
  });

  return { ownerToken: ownerToken as string, agentToken: agentToken as string, agentId: agent.id as string };
}

describe("mandate + manifest", () => {
  test("agent without a mandate reports null; owner authors one; agent reads it", async () => {
    const { ownerToken, agentToken, agentId } = await registerAgent("MandateAgent");

    // before any mandate: both endpoints report null
    const emptyMandate = await app.request("/mandate", { headers: { authorization: `Bearer ${agentToken}` } });
    expect((await emptyMandate.json()).mandate).toBeNull();

    const emptyGet = await app.request(`/owners/agents/${agentId}/mandate`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect((await emptyGet.json()).mandate).toBeNull();

    // validation: objectives must be an array of reasonable strings
    const badArray = await app.request(`/owners/agents/${agentId}/mandate`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ objectives: "not-an-array" }),
    });
    expect(badArray.status).toBe(400);

    const badPrefs = await app.request(`/owners/agents/${agentId}/mandate`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ objectives: ["a valid objective"], permissions: ["not", "an", "object"] }),
    });
    expect(badPrefs.status).toBe(400);

    // owner authors the mandate
    const putRes = await app.request(`/owners/agents/${agentId}/mandate`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        objectives: [
          "Keep me informed about robotics research",
          "Find specialist agents when I need work done",
        ],
        preferences: { tone: "concise", riskPosture: "conservative" },
        permissions: { initiateGoals: true, unsolicitedMessages: false, delegateToUntrusted: false },
      }),
    });
    expect(putRes.status).toBe(200);

    // agent reads its own mandate
    const mRes = await app.request("/mandate", { headers: { authorization: `Bearer ${agentToken}` } });
    const { mandate } = await mRes.json();
    expect(mandate.objectives.length).toBe(2);
    expect(mandate.objectives[0]).toContain("robotics");
    expect(mandate.permissions.initiateGoals).toBe(true);
    expect(mandate.preferences.tone).toBe("concise");
  });

  test("mandate PUT is an upsert: a second PUT replaces, not appends", async () => {
    const { ownerToken, agentToken, agentId } = await registerAgent("MandateUpsert");

    await app.request(`/owners/agents/${agentId}/mandate`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ objectives: ["first standing objective here"] }),
    });
    const put2 = await app.request(`/owners/agents/${agentId}/mandate`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ objectives: ["second standing objective here"] }),
    });
    expect(put2.status).toBe(200);

    const mRes = await app.request("/mandate", { headers: { authorization: `Bearer ${agentToken}` } });
    const { mandate } = await mRes.json();
    expect(mandate.objectives).toEqual(["second standing objective here"]);
  });

  test("manifest derives mandate + policy + wallet + goals + world in one read", async () => {
    const { ownerToken, agentToken, agentId } = await registerAgent("ManifestAgent");

    // owner authors a mandate and patches policy, then the agent pulls one manifest
    await app.request(`/owners/agents/${agentId}/mandate`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ objectives: ["Get real work done through other agents"] }),
    });
    await app.request(`/owners/agents/${agentId}/policy`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ maxParallelDelegations: 5 }),
    });
    // agent creates a goal so the goals section has content
    await app.request("/goals", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ objective: "Find a robotics specialist for collaboration" }),
    });

    const res = await app.request("/manifest", { headers: { authorization: `Bearer ${agentToken}` } });
    expect(res.status).toBe(200);
    const manifest = await res.json();

    expect(manifest.agent.id).toBe(agentId);
    // an agent could not previously learn its own skills from this
    // onboarding surface — registerAgent above sets capabilities but the
    // response never echoed them back
    expect(manifest.agent.capabilities).toEqual(["research", "coding"]);
    expect(manifest.mandate.objectives[0]).toContain("real work");
    expect(manifest.policy.maxParallelDelegations).toBe(5);
    expect(manifest.policy.trustedAgentIds).toEqual([]);
    expect(manifest.wallet.autonomyMode).toBe("autonomous"); // set by registerAgent
    expect(manifest.wallet.today.tokensUsed).toBe(0);
    expect(manifest.goals.counts.open).toBe(1);
    expect(manifest.goals.total).toBe(1);
    // world: natives exist and are listed by name
    const nativeNames = manifest.world.natives.map((n: any) => n.name);
    expect(nativeNames).toContain("Sage");
    expect(nativeNames).toContain("Fixer");
    expect(typeof manifest.world.onlineAgents).toBe("number");
  });

  test("wrong owner cannot author a mandate — 404, no existence leak", async () => {
    const { ownerToken, agentId } = await registerAgent("MandateVictim");
    const otherReg = await app.request("/owners/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `manifest-other-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
        password: "password123",
      }),
    });
    const { token: otherToken } = await otherReg.json();

    const res = await app.request(`/owners/agents/${agentId}/mandate`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${otherToken}` },
      body: JSON.stringify({ objectives: ["act on my behalf instead"] }),
    });
    expect(res.status).toBe(404);

    // the real owner's view is unaffected
    const getRes = await app.request(`/owners/agents/${agentId}/mandate`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect((await getRes.json()).mandate).toBeNull();
  });
});