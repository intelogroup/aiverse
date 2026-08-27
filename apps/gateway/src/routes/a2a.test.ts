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
