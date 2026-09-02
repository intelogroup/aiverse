import { describe, expect, test, afterAll } from "bun:test";
import { createApp } from "../app";
import { websocket } from "./gateway";
import { resetMemoryStoreForTests } from "../policy/memoryStore";

const app = createApp();
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });

afterAll(() => {
  server.stop(true);
});

async function registerAgent(name: string) {
  const email = `offline-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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

  return { agentToken: agentToken as string, agentId: agent.id as string };
}

function waitFor(ws: WebSocket, predicate: (event: any) => boolean, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for event")), timeoutMs);
    ws.onmessage = (msg) => {
      const event = JSON.parse(String(msg.data));
      if (predicate(event)) {
        clearTimeout(timer);
        resolve(event);
      }
    };
  });
}

function connectAndWaitOnline(agentToken: string): Promise<WebSocket> {
  return (async () => {
    // Single-use ticket per connect — the long-lived agent token stays out
    // of the query string.
    const res = await app.request("/auth/ws-ticket", {
      method: "POST",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.status).toBe(201);
    const ticket = ((await res.json()) as any).ticket as string;
    return await new Promise<WebSocket>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${server.port}/agents/ws?ticket=${ticket}`);
      ws.onmessage = (msg) => {
        const event = JSON.parse(String(msg.data));
        if (event.type === "agent_connected") resolve(ws);
      };
    });
  })();
}

describe("offline delivery + ACK", () => {
  test("a message sent while the recipient is offline is replayed on reconnect, redelivered until acked, and stops once acked", async () => {
    await resetMemoryStoreForTests();
    const sender = await registerAgent("OfflineSender");
    const recipient = await registerAgent("OfflineRecipient");

    const join = await app.request("/rooms/general/join", {
      method: "POST",
      headers: { authorization: `Bearer ${recipient.agentToken}` },
    });
    const { conversationId } = await join.json();
    await app.request("/rooms/general/join", {
      method: "POST",
      headers: { authorization: `Bearer ${sender.agentToken}` },
    });

    // recipient is offline the entire time this message is sent
    const send = await app.request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sender.agentToken}` },
      body: JSON.stringify({ content: "you were offline for this" }),
    });
    expect(send.status).toBe(201);
    const { message } = await send.json();

    // first reconnect: backlog replay delivers the missed message
    const ws1 = await connectAndWaitOnline(recipient.agentToken);
    const backlog1 = await waitFor(ws1, (e) => e.type === "message" && e.payload.message_id === message.id);
    expect(backlog1.payload.content).toBe("you were offline for this");
    ws1.close();
    await new Promise((r) => setTimeout(r, 100));

    // second reconnect, still no ack sent: same message replayed again —
    // proves the cursor only advances on explicit ack, not on delivery alone
    const ws2 = await connectAndWaitOnline(recipient.agentToken);
    const backlog2 = await waitFor(ws2, (e) => e.type === "message" && e.payload.message_id === message.id);
    expect(backlog2.payload.message_id).toBe(message.id);

    // now ack it
    ws2.send(JSON.stringify({ type: "ack", id: crypto.randomUUID(), ts: Date.now(), payload: { conversationId, messageId: message.id } }));
    await new Promise((r) => setTimeout(r, 200));
    ws2.close();
    await new Promise((r) => setTimeout(r, 100));

    // third reconnect: no redelivery this time
    const ws3 = await connectAndWaitOnline(recipient.agentToken);
    let redelivered = false;
    ws3.onmessage = (msg) => {
      const event = JSON.parse(String(msg.data));
      if (event.type === "message" && event.payload.message_id === message.id) redelivered = true;
    };
    await new Promise((r) => setTimeout(r, 500));
    expect(redelivered).toBe(false);
    ws3.close();
  }, 15000);

  test("a submitted A2A task addressed to an offline target is replayed on reconnect", async () => {
    await resetMemoryStoreForTests();
    const caller = await registerAgent("OfflineA2ACaller");
    const target = await registerAgent("OfflineA2ATarget");

    const res = await app.request(`/a2a/agents/${target.agentId}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${caller.agentToken}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: { message: { role: "user", parts: [{ kind: "text", text: "while you were out" }], messageId: "m1" } },
      }),
    });
    expect(res.status).toBe(200);
    const taskId = (await res.json()).result.id;

    const ws = await connectAndWaitOnline(target.agentToken);
    const pushed = await waitFor(ws, (e) => e.type === "a2a_task_request" && e.payload.taskId === taskId);
    expect(pushed.payload.fromAgentId).toBe(caller.agentId);
    ws.close();
  }, 15000);

  test("a peer joining a shared conversation while the recipient is offline is replayed on reconnect", async () => {
    // THREAD_PARTICIPANT_JOINED was fire-and-forget only (routes/rooms.ts,
    // routes/conversations.ts) — an offline participant never learned a peer
    // joined while they were away, the same silent-drop shape the message/
    // a2a-task backlog above already closed for other event types.
    await resetMemoryStoreForTests();
    const recipient = await registerAgent("JoinBacklogRecipient");
    const joiner = await registerAgent("JoinBacklogJoiner");

    const join = await app.request("/rooms/general/join", {
      method: "POST",
      headers: { authorization: `Bearer ${recipient.agentToken}` },
    });
    const { conversationId } = await join.json();

    // recipient never connects — joiner joins the same room while recipient
    // has no live socket at all, not just a disconnected one
    const joinerRes = await app.request("/rooms/general/join", {
      method: "POST",
      headers: { authorization: `Bearer ${joiner.agentToken}` },
    });
    expect(joinerRes.status).toBe(200);

    const ws = await connectAndWaitOnline(recipient.agentToken);
    const pushed = await waitFor(
      ws,
      (e) => e.type === "thread_participant_joined" && e.payload.agent_id === joiner.agentId,
    );
    expect(pushed.payload.conversation_id).toBe(conversationId);
    ws.close();
  }, 15000);
});
