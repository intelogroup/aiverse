import { describe, expect, test } from "bun:test";
import { createApp } from "../app";
import { websocket } from "../ws/gateway";
import { resetMemoryStoreForTests } from "../policy/memoryStore";

const app = createApp();
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });

function rpc(method: string, params: unknown, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

async function registerAgent(name: string) {
  const email = `goals-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const { token: ownerToken } = await reg.json();
  const created = await app.request("/owners/agents", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ name, capabilities: [] }),
  });
  const { agentToken, agent } = await created.json();

  await app.request(`/owners/agents/${agent.id}/wallet`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ autonomyMode: "autonomous" }),
  });

  return { ownerToken: ownerToken as string, agentToken: agentToken as string, agentId: agent.id as string };
}

describe("goals", () => {
  test("agent creates and patches a goal, owner watches it", async () => {
    const { ownerToken, agentToken } = await registerAgent("GoalAgent");

    const createRes = await app.request("/goals", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ objective: "Find Alabama driving school regulations" }),
    });
    expect(createRes.status).toBe(201);
    const { goal } = await createRes.json();
    expect(goal.status).toBe("open");
    expect(goal.contextId).toBeTruthy();

    const patchRes = await app.request(`/goals/${goal.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ status: "synthesized", result: { summary: "done" } }),
    });
    expect(patchRes.status).toBe(200);
    const { goal: patched } = await patchRes.json();
    expect(patched.status).toBe("synthesized");
    expect(patched.result.summary).toBe("done");

    const ownerListRes = await app.request("/owners/goals", {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(ownerListRes.status).toBe(200);
    const { goals } = await ownerListRes.json();
    expect(goals.some((g: any) => g.id === goal.id)).toBe(true);

    const ownerGetRes = await app.request(`/owners/goals/${goal.id}`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(ownerGetRes.status).toBe(200);
    const { goal: ownerGoal } = await ownerGetRes.json();
    expect(ownerGoal.id).toBe(goal.id);
  });

  test("goal.contextId reused in an A2A task correlates goal <-> task", async () => {
    await resetMemoryStoreForTests();
    const { agentToken: callerToken } = await registerAgent("GoalCaller");
    const { agentId: targetId } = await registerAgent("GoalTarget");

    const createRes = await app.request("/goals", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${callerToken}` },
      body: JSON.stringify({ objective: "Recruit a specialist for research" }),
    });
    const { goal } = await createRes.json();

    const sendRes = await app.request(`/a2a/agents/${targetId}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${callerToken}` },
      body: JSON.stringify(rpc("message/send", { message: { role: "user", parts: [{ text: "help" }] }, contextId: goal.contextId })),
    });
    expect(sendRes.status).toBe(200);
    const sendBody = await sendRes.json();
    expect(sendBody.result.contextId).toBe(goal.contextId);

    const goalGetRes = await app.request(`/goals/${goal.id}`, {
      headers: { authorization: `Bearer ${callerToken}` },
    });
    const { tasks, taskCount } = await goalGetRes.json();
    expect(taskCount).toBe(1);
    expect(tasks[0].contextId).toBe(goal.contextId);
  });
});
