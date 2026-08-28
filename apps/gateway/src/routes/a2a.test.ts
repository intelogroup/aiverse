import { describe, expect, test, afterAll } from "bun:test";
import { createApp } from "../app";
import { websocket } from "../ws/gateway";
import { resetMemoryStoreForTests } from "../policy/memoryStore";

const app = createApp();
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });

afterAll(() => {
  server.stop(true);
});

async function registerAgent(name: string, capabilities: string[] = []) {
  const email = `a2a-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const { token: ownerToken } = await reg.json();
  const created = await app.request("/owners/agents", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ name, capabilities }),
  });
  const { agentToken, agent } = await created.json();

  await app.request(`/owners/agents/${agent.id}/wallet`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ autonomyMode: "autonomous" }),
  });

  return { agentToken: agentToken as string, agentId: agent.id as string };
}

function rpc(method: string, params: unknown, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

describe("agent-card.json discovery", () => {
  test("returns a spec-shaped Agent Card that discloses it is a relay", async () => {
    const { agentId } = await registerAgent("CardAgent", ["pdf-to-markdown"]);

    const res = await app.request(`/agents/${agentId}/agent-card.json`);
    expect(res.status).toBe(200);
    const card = await res.json();

    expect(card.protocolVersion).toBe("0.3.0");
    expect(card.name).toBe("CardAgent");
    expect(card.preferredTransport).toBe("JSONRPC");
    expect(card.skills[0].name).toBe("pdf-to-markdown");
    expect(card.url).toContain(`/a2a/agents/${agentId}`);
    // must not look like the agent's own server
    expect(card["x-aiverse-relay"]).toBe(true);
    expect(typeof card["x-aiverse-note"]).toBe("string");
    // required AgentCard fields the relay was previously missing
    expect(card.defaultInputModes).toEqual(["text/plain"]);
    expect(card.defaultOutputModes).toEqual(["text/plain"]);
    // message/stream isn't implemented — must never claim streaming support,
    // even for a currently-connected agent (regression: this used to be
    // isAgentConnected(agent.id), a lie about capability, not connectivity).
    expect(card.capabilities.streaming).toBe(false);
  });
});

describe("network-level well-known agent card (cold-start bootstrap)", () => {
  test("GET /.well-known/agent-card.json hands an unfamiliar agent the directory endpoints, not a fake skill set", async () => {
    const res = await app.request("/.well-known/agent-card.json");
    expect(res.status).toBe(200);
    const card = await res.json();

    expect(card.name).toBe("AIVerse");
    expect(card.skills).toEqual([]);
    expect(card.capabilities.streaming).toBe(false);
    expect(typeof card["x-aiverse-directory"].register).toBe("string");
    expect(typeof card["x-aiverse-directory"].agentCard).toBe("string");
    expect(card["x-aiverse-directory"].protocols).toEqual(["A2A"]);
  });
});

describe("GET /agents/discover", () => {
  test("finds a claimed agent by a substring match on its capabilities, excludes unrelated/unclaimed agents", async () => {
    await registerAgent("DiscoverablePolyglot", ["portuguese translation", "spanish translation"]);
    await registerAgent("DiscoverableUnrelated", ["pdf-to-markdown"]);

    const res = await app.request("/agents/discover?skill=portuguese");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.skill).toBe("portuguese");
    const names = body.matches.map((m: { name: string }) => m.name);
    expect(names).toContain("DiscoverablePolyglot");
    expect(names).not.toContain("DiscoverableUnrelated");

    const match = body.matches.find((m: { name: string }) => m.name === "DiscoverablePolyglot");
    expect(match.status).toBe("offline"); // registered, never connected
    expect(match.capabilities).toContain("portuguese translation");
    expect(match.agentCardUrl).toContain("/agent-card.json");
  });

  test("missing skill query param is a 400, not a silent empty result", async () => {
    const res = await app.request("/agents/discover");
    expect(res.status).toBe(400);
  });

  test("?q= fuzzy trigram match ranks the closer capability first and tolerates a typo", async () => {
    const unique = `Zynth${Date.now()}`;
    await registerAgent(`${unique}Exact`, [`${unique} portuguese translation`]);
    // deliberately no shared prefix with `unique` — an unrelated agent name
    // must not trigram-match just because both agents happen to share a
    // test-run id.
    await registerAgent(`UnrelatedAgent${Math.random().toString(36).slice(2)}`, ["pdf-to-markdown"]);

    // typo: "portugese" vs "portuguese" — substring .includes() would never
    // match this; trigram similarity should.
    const res = await app.request(`/agents/discover?q=${unique}%20portugese`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const names = body.matches.map((m: { name: string }) => m.name);
    expect(names).toContain(`${unique}Exact`);
  });

  test("?skill= behavior is unchanged (exact/substring, not fuzzy) — regression check", async () => {
    const unique = `Skillcheck${Date.now()}`;
    await registerAgent(`${unique}Agent`, [`${unique} portuguese translation`]);

    // a typo against ?skill= must NOT match — substring semantics preserved.
    const res = await app.request(`/agents/discover?skill=${unique}%20portugese`);
    const body = await res.json();
    const names = body.matches.map((m: { name: string }) => m.name);
    expect(names).not.toContain(`${unique}Agent`);
  });
});

describe("A2A relay: message/send + tasks/get + tasks/cancel", () => {
  test("message/send creates a submitted task and pushes a2a_task_request over WS", async () => {
    await resetMemoryStoreForTests();
    const caller = await registerAgent("A2ACaller");
    const target = await registerAgent("A2ATarget");

    const wsTarget = new WebSocket(`ws://localhost:${server.port}/agents/ws?token=${target.agentToken}`);
    const received = new Promise<any>((resolve) => {
      wsTarget.onmessage = (e) => {
        const evt = JSON.parse(String(e.data));
        if (evt.type === "a2a_task_request") resolve(evt);
      };
    });
    await new Promise<void>((resolve) => (wsTarget.onopen = () => resolve()));

    const res = await app.request(`/a2a/agents/${target.agentId}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${caller.agentToken}` },
      body: JSON.stringify(
        rpc("message/send", {
          message: { role: "user", parts: [{ kind: "text", text: "convert this pdf" }], messageId: "m1" },
        }),
      ),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.status.state).toBe("submitted");
    // required Task fields the relay was previously missing
    expect(body.result.kind).toBe("task");
    expect(typeof body.result.contextId).toBe("string");
    expect(body.result.contextId.length).toBeGreaterThan(0);
    const taskId = body.result.id;

    const pushed = await received;
    expect(pushed.payload.taskId).toBe(taskId);
    expect(pushed.payload.fromAgentId).toBe(caller.agentId);
    wsTarget.close();

    const getRes = await app.request(`/a2a/agents/${target.agentId}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${caller.agentToken}` },
      body: JSON.stringify(rpc("tasks/get", { id: taskId }, 2)),
    });
    const getBody = await getRes.json();
    expect(getBody.result.status.state).toBe("submitted");
  });

  test("target agent explicitly rejects a task via PATCH, caller sees rejected", async () => {
    await resetMemoryStoreForTests();
    const caller = await registerAgent("A2ACaller2");
    const target = await registerAgent("A2ATarget2");

    const send = await app.request(`/a2a/agents/${target.agentId}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${caller.agentToken}` },
      body: JSON.stringify(
        rpc("message/send", {
          message: { role: "user", parts: [{ kind: "text", text: "hi" }], messageId: "m2" },
        }),
      ),
    });
    const taskId = (await send.json()).result.id;

    const patch = await app.request(`/a2a/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${target.agentToken}` },
      body: JSON.stringify({ state: "rejected" }),
    });
    expect(patch.status).toBe(200);
    expect((await patch.json()).task.status.state).toBe("rejected");

    const getRes = await app.request(`/a2a/agents/${target.agentId}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${caller.agentToken}` },
      body: JSON.stringify(rpc("tasks/get", { id: taskId }, 3)),
    });
    expect((await getRes.json()).result.status.state).toBe("rejected");

    // rejected is terminal — a late PATCH is refused
    const late = await app.request(`/a2a/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${target.agentToken}` },
      body: JSON.stringify({ state: "completed" }),
    });
    expect(late.status).toBe(409);
  });

  test("caller can cancel a task; cancel on an already-terminal task fails", async () => {
    await resetMemoryStoreForTests();
    const caller = await registerAgent("A2ACaller3");
    const target = await registerAgent("A2ATarget3");

    const send = await app.request(`/a2a/agents/${target.agentId}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${caller.agentToken}` },
      body: JSON.stringify(
        rpc("message/send", {
          message: { role: "user", parts: [{ kind: "text", text: "hi" }], messageId: "m3" },
        }),
      ),
    });
    const taskId = (await send.json()).result.id;

    const cancel = await app.request(`/a2a/agents/${target.agentId}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${caller.agentToken}` },
      body: JSON.stringify(rpc("tasks/cancel", { id: taskId }, 4)),
    });
    expect((await cancel.json()).result.status.state).toBe("canceled");

    const cancelAgain = await app.request(`/a2a/agents/${target.agentId}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${caller.agentToken}` },
      body: JSON.stringify(rpc("tasks/cancel", { id: taskId }, 5)),
    });
    expect(cancelAgain.status).toBe(409);
  });

  test("an unanswered task stays 'submitted' — nothing auto-runs it", async () => {
    await resetMemoryStoreForTests();
    const caller = await registerAgent("A2ACaller4");
    const target = await registerAgent("A2ATarget4");

    const send = await app.request(`/a2a/agents/${target.agentId}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${caller.agentToken}` },
      body: JSON.stringify(
        rpc("message/send", {
          message: { role: "user", parts: [{ kind: "text", text: "hi" }], messageId: "m4" },
        }),
      ),
    });
    const taskId = (await send.json()).result.id;

    const getRes = await app.request(`/a2a/agents/${target.agentId}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${caller.agentToken}` },
      body: JSON.stringify(rpc("tasks/get", { id: taskId }, 6)),
    });
    expect((await getRes.json()).result.status.state).toBe("submitted");
  });

  test("observe-mode caller is blocked from sending a task (same gate as room messages)", async () => {
    await resetMemoryStoreForTests();

    // raw registration, left at the default 'observe' autonomy mode — no
    // wallet PATCH, unlike the registerAgent() test helper above.
    const email = `a2a-observe-${Date.now()}@example.com`;
    const reg = await app.request("/owners/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    });
    const { token: ownerToken } = await reg.json();
    const created = await app.request("/owners/agents", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ name: "A2AObserveCaller", capabilities: [] }),
    });
    const { agentToken: observeToken } = await created.json();

    const target = await registerAgent("A2AObserveTarget");

    const res = await app.request(`/a2a/agents/${target.agentId}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${observeToken}` },
      body: JSON.stringify(
        rpc("message/send", {
          message: { role: "user", parts: [{ kind: "text", text: "hi" }], messageId: "m5" },
        }),
      ),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toBe("autonomy_observe_blocks_send");
  });
});

// Exercised directly against admitAndCreateTask, not through POST
// /a2a/agents/:id — a real concurrent HTTP burst from one caller is mostly
// absorbed by the pre-existing, unrelated per-agent send-rate gate (1
// msg/sec, checked earlier in the route), which would make "N truly
// concurrent requests" nearly impossible to produce over HTTP and would
// test that rate gate, not the delegation cap's atomicity. Calling the
// primitive directly is what actually exercises the invariant under test.
describe("parallel-delegation cap (admitAndCreateTask)", () => {
  async function activeCount(callerAgentId: string, contextId: string) {
    const { db } = await import("../db/client");
    const { a2aTasks } = await import("@aiverse/shared/schema");
    const { and, eq, inArray, gt } = await import("drizzle-orm");
    const rows = await db.query.a2aTasks.findMany({
      where: and(
        eq(a2aTasks.callerAgentId, callerAgentId),
        eq(a2aTasks.contextId, contextId),
        inArray(a2aTasks.state, ["submitted", "working"]),
        gt(a2aTasks.delegationLeaseExpiresAt, new Date()),
      ),
    });
    return rows.length;
  }

  async function admitConcurrent(callerAgentId: string, targetIds: string[], contextId: string, maxParallel: number) {
    const { admitAndCreateTask } = await import("../policy/gate");
    return Promise.all(
      targetIds.map((targetAgentId) =>
        admitAndCreateTask({
          callerAgentId,
          contextId,
          maxParallel,
          task: { contextId, targetAgentId, callerAgentId, requestMessage: { role: "user", parts: [] } },
        }),
      ),
    );
  }

  test("default cap (3): exactly 3 of 5 concurrent admissions succeed, repeated across fresh contextIds", async () => {
    const caller = await registerAgent("DelegationCaller");
    const targets = await Promise.all(Array.from({ length: 5 }, (_, i) => registerAgent(`DelegationTarget${i}`)));
    const targetIds = targets.map((t) => t.agentId);

    for (let iter = 0; iter < 5; iter++) {
      const contextId = crypto.randomUUID();
      const results = await admitConcurrent(caller.agentId, targetIds, contextId, 3);
      const succeeded = results.filter((r) => r.allowed);
      const rejected = results.filter((r) => !r.allowed);
      expect(succeeded.length).toBe(3);
      expect(rejected.length).toBe(2);
      expect(rejected.every((r) => !r.allowed && r.reason === "parallel_delegation_limit")).toBe(true);
      expect(await activeCount(caller.agentId, contextId)).toBeLessThanOrEqual(3);
    }
  }, 15000); // 6 registrations + 5 iterations of network-serialized advisory-lock txns over the Neon branch — 5s default is too tight

  test("adversarial: 10 concurrent admissions against one caller/context never exceed the cap", async () => {
    const caller = await registerAgent("DelegationCaller10");
    const targets = await Promise.all(Array.from({ length: 10 }, (_, i) => registerAgent(`DelegationTarget10-${i}`)));
    const contextId = crypto.randomUUID();

    const results = await admitConcurrent(caller.agentId, targets.map((t) => t.agentId), contextId, 3);
    expect(results.filter((r) => r.allowed).length).toBe(3);
    expect(await activeCount(caller.agentId, contextId)).toBeLessThanOrEqual(3);
  });

  test("two different callers sharing one contextId do not block each other", async () => {
    const callerA = await registerAgent("DelegationCallerA");
    const callerB = await registerAgent("DelegationCallerB");
    const targetsA = await Promise.all(Array.from({ length: 3 }, (_, i) => registerAgent(`DelegationTargetA${i}`)));
    const targetsB = await Promise.all(Array.from({ length: 3 }, (_, i) => registerAgent(`DelegationTargetB${i}`)));
    const sharedContextId = crypto.randomUUID();

    const [resultsA, resultsB] = await Promise.all([
      admitConcurrent(callerA.agentId, targetsA.map((t) => t.agentId), sharedContextId, 3),
      admitConcurrent(callerB.agentId, targetsB.map((t) => t.agentId), sharedContextId, 3),
    ]);
    // cap is per (callerAgentId, contextId) — both callers get their own full allowance
    expect(resultsA.filter((r) => r.allowed).length).toBe(3);
    expect(resultsB.filter((r) => r.allowed).length).toBe(3);
  });

  test("an expired delegation lease frees a slot without touching the underlying task's state", async () => {
    const { db } = await import("../db/client");
    const { a2aTasks } = await import("@aiverse/shared/schema");
    const { admitAndCreateTask } = await import("../policy/gate");

    const caller = await registerAgent("DelegationExpiryCaller");
    const targets = await Promise.all(Array.from({ length: 4 }, (_, i) => registerAgent(`DelegationExpiryTarget${i}`)));
    const contextId = crypto.randomUUID();

    // 2 real active admissions + 1 already-expired-lease row inserted
    // directly (bypassing the primitive) — the expired one must not count
    // toward the cap, and its state must remain untouched.
    const [firstTwo, [expired]] = await Promise.all([
      admitConcurrent(caller.agentId, [targets[0].agentId, targets[1].agentId], contextId, 3),
      db
        .insert(a2aTasks)
        .values({
          contextId,
          targetAgentId: targets[2].agentId,
          callerAgentId: caller.agentId,
          requestMessage: { role: "user", parts: [] },
          delegationLeaseExpiresAt: new Date(Date.now() - 60_000), // already expired
        })
        .returning(),
    ]);
    expect(firstTwo.filter((r) => r.allowed).length).toBe(2);

    // 3rd admission should still succeed: 2 real active + 1 expired-lease (excluded) = 2 active, room for 1 more under cap 3.
    const third = await admitAndCreateTask({
      callerAgentId: caller.agentId,
      contextId,
      maxParallel: 3,
      task: { contextId, targetAgentId: targets[3].agentId, callerAgentId: caller.agentId, requestMessage: { role: "user", parts: [] } },
    });
    expect(third.allowed).toBe(true);

    const expiredRow = await db.query.a2aTasks.findFirst({ where: (t, { eq }) => eq(t.id, expired.id) });
    expect(expiredRow?.state).toBe("submitted"); // lease expiry never canceled the task
  });

  test("owner-configured maxParallelDelegations is honored by admitAndCreateTask", async () => {
    const caller = await registerAgent("PolicyCaller");
    const targets = await Promise.all(Array.from({ length: 2 }, (_, i) => registerAgent(`PolicyTarget${i}`)));
    const contextId = crypto.randomUUID();

    const results = await admitConcurrent(caller.agentId, targets.map((t) => t.agentId), contextId, 1);
    expect(results.filter((r) => r.allowed).length).toBe(1); // maxParallel=1, not the default 3
  });

  test("owner PATCH /owners/agents/:id/policy persists maxParallelDelegations, message/send reads it", async () => {
    const email = `delegation-policy-${Date.now()}@example.com`;
    const reg = await app.request("/owners/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    });
    const { token: ownerToken } = await reg.json();
    const created = await app.request("/owners/agents", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ name: "PolicyPersistCaller", capabilities: [] }),
    });
    const { agent } = await created.json();
    const policyRes = await app.request(`/owners/agents/${agent.id}/policy`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ maxParallelDelegations: 7 }),
    });
    expect(policyRes.status).toBe(200);
    const { policy } = await policyRes.json();
    expect(policy.maxParallelDelegations).toBe(7);
  });
});

describe("self-registration + claim", () => {
  async function ownerToken() {
    const email = `claimowner-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const reg = await app.request("/owners/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    });
    const { token } = await reg.json();
    return token as string;
  }

  test("wrong code rejected, right code claims, code can't be reused", async () => {
    await resetMemoryStoreForTests();

    const reg = await app.request("/agents/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "SelfRegAgent" }),
    });
    expect(reg.status).toBe(201);
    const { claimCode } = await reg.json();
    // high-entropy secret, not the old 4-byte code
    expect(claimCode).toMatch(/^AIVERSE-([0-9A-F]{1,4}-){7}[0-9A-F]{1,4}$/);

    const token = await ownerToken();

    const wrong = await app.request("/owners/agents/claim", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ claimCode: "AIVERSE-0000-0000-0000-0000-0000-0000-0000-0000" }),
    });
    expect(wrong.status).toBe(404);

    const claimed = await app.request("/owners/agents/claim", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ claimCode }),
    });
    expect(claimed.status).toBe(200);

    // one-time use: the same code fails the second time even though it was
    // valid a moment ago
    const replay = await app.request("/owners/agents/claim", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ claimCode }),
    });
    expect(replay.status).toBe(404);
  });
});
