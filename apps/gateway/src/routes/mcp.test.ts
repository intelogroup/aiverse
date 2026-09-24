import { describe, expect, test } from "bun:test";
import { createApp } from "../app";
import { resetMemoryStoreForTests } from "../policy/memoryStore";
import { drainIngestStream } from "../jobs/ingestConsumer";

const app = createApp();

function json(token?: string) {
  return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

async function ownerWithAgent(name: string) {
  const email = `mcp-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", { method: "POST", headers: json(), body: JSON.stringify({ email, password: "password123" }) });
  const { token: session } = (await reg.json()) as any;
  const created = await app.request("/owners/agents", { method: "POST", headers: json(session), body: JSON.stringify({ name, capabilities: [] }) });
  const { agent, agentToken } = (await created.json()) as any;
  const keyRes = await app.request("/owners/read-keys", { method: "POST", headers: json(session), body: JSON.stringify({ label: "claude code" }) });
  expect(keyRes.status).toBe(201);
  const { key, readKey } = (await keyRes.json()) as any;
  return { session: session as string, agentId: agent.id as string, agentName: name, agentToken: agentToken as string, key: key as string, keyId: readKey.id as string };
}

let rpcId = 0;
async function mcp(token: string | undefined, method: string, params: Record<string, unknown> = {}) {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: { ...json(token), accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return { status: res.status, body: res.status === 200 ? ((await res.json()) as any) : null };
}

const callTool = (token: string, name: string, args: Record<string, unknown> = {}) => mcp(token, "tools/call", { name, arguments: args });

describe("owner read keys", () => {
  test("a read key reads, but is refused by every owner route that writes or manages", async () => {
    await resetMemoryStoreForTests();
    const o = await ownerWithAgent("ReadKeyAgent");
    expect(o.key.startsWith("avr_")).toBe(true);

    const list = (await (await app.request("/owners/read-keys", { headers: json(o.session) })).json()) as any;
    expect(list.readKeys).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(o.key);

    expect((await app.request("/owners/agents", { headers: json(o.key) })).status).toBe(200);

    const refused: Array<[string, string, unknown?]> = [
      ["GET", "/owners/me"],
      ["POST", "/owners/agents", { name: "sneaky", capabilities: [] }],
      ["PUT", `/owners/agents/${o.agentId}/mandate`, { objectives: ["steer"] }],
      ["PATCH", `/owners/agents/${o.agentId}/wallet`, { autonomyMode: "observe" }],
      ["POST", `/owners/agents/${o.agentId}/pause`],
      ["POST", "/owners/read-keys", { label: "another" }],
      ["GET", "/owners/read-keys"],
      ["DELETE", `/owners/read-keys/${o.keyId}`],
    ];
    for (const [method, path, body] of refused) {
      const res = await app.request(path, { method, headers: json(o.key), body: body ? JSON.stringify(body) : undefined });
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 401 });
    }
    // Nor does it work as an agent credential.
    expect((await app.request("/manifest", { headers: json(o.key) })).status).toBe(401);
  });

  test("revoking a key, and logout-all, both cut it off", async () => {
    const o = await ownerWithAgent("RevokeAgent");
    expect((await app.request(`/owners/read-keys/${o.keyId}`, { method: "DELETE", headers: json(o.session) })).status).toBe(200);
    expect((await app.request("/owners/agents", { headers: json(o.key) })).status).toBe(401);
    expect((await mcp(o.key, "tools/list")).status).toBe(401);

    const second = (await (await app.request("/owners/read-keys", { method: "POST", headers: json(o.session), body: JSON.stringify({ label: "b" }) })).json()) as any;
    expect((await app.request("/owners/agents", { headers: json(second.key) })).status).toBe(200);
    await app.request("/owners/logout-all", { method: "POST", headers: json(o.session) });
    expect((await app.request("/owners/agents", { headers: json(second.key) })).status).toBe(401);
  });
});

describe("observer MCP", () => {
  test("only a read key gets in — not a session, an agent token, or nothing", async () => {
    const o = await ownerWithAgent("GateAgent");
    expect((await mcp(undefined, "tools/list")).status).toBe(401);
    expect((await mcp(o.session, "tools/list")).status).toBe(401);
    expect((await mcp(o.agentToken, "tools/list")).status).toBe(401);
    expect((await mcp(o.key, "tools/list")).status).toBe(200);
  });

  test("every tool is read-only and none can send, write or steer", async () => {
    const o = await ownerWithAgent("ToolsAgent");
    const { body } = await mcp(o.key, "tools/list");
    const tools = body.result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.name).not.toMatch(/send|post|write|reply|join|start|answer|set|update|create|delete|pause|kill|resume/);
    }
  });

  test("my_agents shows the caller's own agents with live status, framed as untrusted data", async () => {
    const o = await ownerWithAgent(`MineAgent-${Date.now()}`);
    await app.request("/manifest", { headers: json(o.agentToken) }); // the agent's own call makes it live
    const { status, body } = await callTool(o.key, "my_agents");
    expect(status).toBe(200);
    const text = body.result.content[0].text as string;
    expect(text.startsWith("[Verse data written by third-party AI agents")).toBe(true);
    expect(text).toContain(`${o.agentName} · online`);
  });

  test("a read key cannot see another owner's agent", async () => {
    const mine = await ownerWithAgent("IsoMine");
    const theirs = await ownerWithAgent("IsoTheirs");
    for (const show of [undefined, ["goals"]]) {
      const { body } = await callTool(mine.key, "my_agent", { agentId: theirs.agentId, ...(show ? { show } : {}) });
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toContain("not found");
    }
  });

  test("my_agent returns only the sections asked for", async () => {
    const o = await ownerWithAgent("SectionAgent");
    await app.request("/onboarding/questions", {
      method: "POST",
      headers: json(o.agentToken),
      body: JSON.stringify({ question: "Robotics or biology first?", options: [{ label: "Robotics", value: "r" }, { label: "Biology", value: "b" }] }),
    });
    const { body } = await callTool(o.key, "my_agent", { agentId: o.agentId, show: ["questions"] });
    const text = body.result.content[0].text as string;
    expect(text).toContain("Robotics or biology first?");
    expect(text).not.toContain("Conversations");
    expect(text).not.toContain("Goals");
  });

  test("read_conversation gives the newest page by name, compactly, with a working hint for older messages", async () => {
    const o = await ownerWithAgent("TalkerA");
    const peer = await ownerWithAgent("TalkerB");
    for (const t of [o, peer]) {
      await app.request(`/owners/agents/${t.agentId}/wallet`, { method: "PATCH", headers: json(t.session), body: JSON.stringify({ autonomyMode: "autonomous" }) });
    }
    const conv = (await (await app.request("/conversations", {
      method: "POST",
      headers: json(o.agentToken),
      body: JSON.stringify({ isPublic: false, name: "mcp-read-test", participantIds: [peer.agentId] }),
    })).json()) as any;
    const long = "x".repeat(2000);
    for (let i = 0; i < 25; i++) {
      await resetMemoryStoreForTests();
      const send = await app.request(`/conversations/${conv.conversation.id}/messages`, {
        method: "POST",
        headers: json(i % 2 ? o.agentToken : peer.agentToken),
        body: JSON.stringify({ content: `msg-${String(i).padStart(2, "0")} ${long}` }),
      });
      expect(send.status).toBe(201);
      await drainIngestStream();
    }

    const first = await callTool(o.key, "read_conversation", { conversationId: conv.conversation.id });
    const text = first.body.result.content[0].text as string;
    expect(text).toContain("msg-24");
    expect(text).toContain("msg-05");
    expect(text).not.toContain("msg-04 ");
    expect(text).toContain("TalkerB:");
    expect(text).not.toContain(peer.agentId); // names, not ids
    // 20 messages of 2,000 chars each would be ~40k raw; concise stays small.
    expect(text.length).toBeLessThan(10_000);

    const before = text.match(/before="([^"]+)"/)?.[1];
    expect(before).toBeDefined();
    const older = await callTool(o.key, "read_conversation", { conversationId: conv.conversation.id, before });
    const olderText = older.body.result.content[0].text as string;
    expect(olderText).toContain("msg-00");
    expect(olderText).toContain("msg-04");
    expect(olderText).not.toContain("msg-05");
    expect(olderText).not.toContain("Older messages exist");
  });

  test("read_conversation refuses a private conversation none of the caller's agents are in", async () => {
    const outsider = await ownerWithAgent("Outsider");
    const a = await ownerWithAgent("PrivA");
    const b = await ownerWithAgent("PrivB");
    const conv = (await (await app.request("/conversations", {
      method: "POST",
      headers: json(a.agentToken),
      body: JSON.stringify({ isPublic: false, name: "private-one", participantIds: [b.agentId] }),
    })).json()) as any;
    const { body } = await callTool(outsider.key, "read_conversation", { conversationId: conv.conversation.id });
    expect(body.result.isError).toBe(true);
  });

  test("verse_now and verse_search answer from public data", async () => {
    const o = await ownerWithAgent("PublicReader");
    const now = await callTool(o.key, "verse_now", { limit: 3 });
    expect(now.body.result.isError).toBeFalsy();
    expect(now.body.result.content[0].text).toContain("Trending (24h):");
    const search = await callTool(o.key, "verse_search", { q: `nothing-matches-${Date.now()}` });
    expect(search.body.result.content[0].text).toContain("No public conversations mention");
    const bad = await callTool(o.key, "read_conversation", { conversationId: "not-a-uuid" });
    expect(bad.body.result?.isError ?? bad.body.error).toBeTruthy();
  });
});
