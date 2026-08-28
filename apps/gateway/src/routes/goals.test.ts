import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { websocket } from "../ws/gateway";
import { resetMemoryStoreForTests } from "../policy/memoryStore";
import { db } from "../db/client";
import { a2aTasks, taskOutcomes } from "@aiverse/shared/schema";
import { reconcileTaskOutcomes } from "../jobs/outcomeLedger";

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

describe("goal verdicts (owner-only acceptance)", () => {
  test("agent cannot transition a goal to accepted/rejected, and unknown statuses are 400", async () => {
    const { agentToken } = await registerAgent("VerdictForbidden");
    const createRes = await app.request("/goals", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ objective: "Test owner-only verdict transitions" }),
    });
    const { goal } = await createRes.json();

    for (const forbidden of ["accepted", "rejected"]) {
      const res = await app.request(`/goals/${goal.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
        body: JSON.stringify({ status: forbidden }),
      });
      expect(res.status).toBe(403);
    }

    const bogusRes = await app.request(`/goals/${goal.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ status: "definitely-not-a-status" }),
    });
    expect(bogusRes.status).toBe(400);
  });

  test("owner accept/reject enforces the state machine; verdicts are terminal", async () => {
    const { ownerToken, agentToken } = await registerAgent("VerdictFlow");

    const createRes = await app.request("/goals", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ objective: "State machine test goal" }),
    });
    const { goal } = await createRes.json();

    // verdict before the agent proposes → 409
    const earlyRes = await app.request(`/owners/goals/${goal.id}/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(earlyRes.status).toBe(409);

    // agent proposes
    await app.request(`/goals/${goal.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ status: "synthesized", result: { summary: "here you go" } }),
    });

    // owner disposes
    const acceptRes = await app.request(`/owners/goals/${goal.id}/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(acceptRes.status).toBe(200);
    const { goal: accepted } = await acceptRes.json();
    expect(accepted.status).toBe("accepted");
    expect(accepted.acceptedAt).toBeTruthy();

    // verdict is terminal: agent can't revise, owner can't re-verdict
    const agentReviseRes = await app.request(`/goals/${goal.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ status: "open" }),
    });
    expect(agentReviseRes.status).toBe(409);

    const reAcceptRes = await app.request(`/owners/goals/${goal.id}/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(reAcceptRes.status).toBe(409);

    // reject path on a fresh goal: rejected, no acceptedAt
    const create2 = await app.request("/goals", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ objective: "Reject path test goal" }),
    });
    const { goal: goal2 } = await create2.json();
    await app.request(`/goals/${goal2.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ status: "synthesized", result: { summary: "bad answer" } }),
    });
    const rejectRes = await app.request(`/owners/goals/${goal2.id}/reject`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(rejectRes.status).toBe(200);
    const { goal: rejected } = await rejectRes.json();
    expect(rejected.status).toBe("rejected");
    expect(rejected.acceptedAt).toBeNull();
  });

  test("owner verdict backfills the outcome ledger; other owners get 404", async () => {
    const { ownerToken, agentToken, agentId } = await registerAgent("VerdictLedger");
    const { ownerToken: otherToken } = await registerAgent("VerdictOtherOwner");

    const createRes = await app.request("/goals", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ objective: "Ledger backfill test goal" }),
    });
    const { goal } = await createRes.json();

    // a completed task inside this goal's context, materialized into the ledger
    await db.insert(a2aTasks).values({
      contextId: goal.contextId,
      targetAgentId: agentId,
      callerAgentId: agentId,
      state: "completed",
      requestMessage: {},
    });
    await reconcileTaskOutcomes();

    // wrong owner: 404 (must not leak goal existence)
    const otherRes = await app.request(`/owners/goals/${goal.id}/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(otherRes.status).toBe(404);

    // agent proposes, then owner disposes
    await app.request(`/goals/${goal.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ status: "synthesized", result: { summary: "work done" } }),
    });

    // owner accept → ledger rows in this context get stamped
    const acceptRes = await app.request(`/owners/goals/${goal.id}/accept`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(acceptRes.status).toBe(200);

    const rows = await db.query.taskOutcomes.findMany({ where: eq(taskOutcomes.contextId, goal.contextId) });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) expect(row.goalAccepted).toBe(true);
  });
});
