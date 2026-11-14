import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sign } from "hono/jwt";
import { env } from "@aiverse/shared/env";
import { SOCIAL_CLIPS, clipDef } from "@aiverse/world-sim/clips";
import { createApp } from "../app";
import { computeS256Challenge, oauthIssuer } from "../auth/oauthCore";
import { resetMemoryStoreForTests } from "../policy/memoryStore";
import { drainIngestStream } from "../jobs/ingestConsumer";
import type { SimClient } from "../world/simClient";

// Agent MCP (Phase 3) route tests. The app runs with a fake sim client at
// the seam createApp exposes: it answers like apps/sim's server does for
// the paths these tests reach (the social clip list straight from
// @aiverse/world-sim — the same source WorldService.clips() serves — and
// the sim's no_body 404 for a body-less observe/look). Everything else —
// auth, visits, OAuth, conversations — is the real gateway on Postgres.

const FAKE_PLACES = [
  { id: "shop-102", name: "Matchmaker's Tea House", kind: "shop", room: "tea" },
  { id: "plaza", name: "Central Plaza", kind: "plaza", room: null },
  { id: "stall-3", name: "Noodle Stall", kind: "stall", room: null },
];

const fakeSim: SimClient = {
  async call(method, path) {
    if (method === "GET" && path === "/clips") {
      const clips = SOCIAL_CLIPS.map((name) => {
        const d = clipDef(name);
        return {
          name,
          loop: d?.loop ?? false,
          seconds: Math.round((d?.duration ?? 0) * 100) / 100,
          seatedOk: !!d?.seatedOk,
          aliases: d?.aliases ?? [],
        };
      });
      return Response.json({ clips });
    }
    if (method === "GET" && path === "/places") return Response.json({ places: FAKE_PLACES });
    if (/^\/bodies\/[^/]+\/(observe|look)$/.test(path.split("?")[0])) {
      return Response.json({ error: "no_body", message: "no body: attach one first" }, { status: 404 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  },
};

const app = createApp({ sim: fakeSim });

const LOOPBACK_REDIRECT = "http://localhost:53111/oauth-callback";

function json(token?: string) {
  return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

async function ownerWithAgent(name: string) {
  const email = `mcpagent-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", { method: "POST", headers: json(), body: JSON.stringify({ email, password: "password123" }) });
  expect(reg.status).toBe(201);
  const { token: session } = (await reg.json()) as any;
  const created = await app.request("/owners/agents", { method: "POST", headers: json(session), body: JSON.stringify({ name: `${name}-${Math.random().toString(36).slice(2, 8)}`, capabilities: [] }) });
  expect(created.status).toBe(201);
  const { agent, agentToken } = (await created.json()) as any;
  return { session: session as string, agentId: agent.id as string, agentName: agent.name as string, agentToken: agentToken as string };
}

async function secondAgent(session: string, name: string) {
  const created = await app.request("/owners/agents", { method: "POST", headers: json(session), body: JSON.stringify({ name: `${name}-${Math.random().toString(36).slice(2, 8)}`, capabilities: [] }) });
  expect(created.status).toBe(201);
  const { agent } = (await created.json()) as any;
  return agent.id as string;
}

const startVisit = async (ownerToken: string, agentId: string, maxActions = 50) =>
  ((await (await app.request(`/owners/agents/${agentId}/visits`, { method: "POST", headers: json(ownerToken), body: JSON.stringify({ minutes: 30, maxActions }) })).json()) as any).visit;

// --- OAuth minting, driven through the real Phase 1 flow ----------------

async function registerClient() {
  const res = await app.request("/oauth/register", {
    method: "POST",
    headers: json(),
    body: JSON.stringify({ client_name: "test mcp client", redirect_uris: [LOOPBACK_REDIRECT] }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as any).client_id as string;
}

async function tokenRequest(params: Record<string, string>) {
  const res = await app.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function mintOAuthToken(owner: { session: string }, agentIds: string[], scope?: string) {
  const clientId = await registerClient();
  const verifier = randomBytes(32).toString("base64url");
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: LOOPBACK_REDIRECT,
    response_type: "code",
    code_challenge: computeS256Challenge(verifier),
    code_challenge_method: "S256",
    state: "state-123",
    ...(scope ? { scope } : {}),
  });
  const authRes = await app.request(`/oauth/authorize?${q}`);
  expect(authRes.status).toBe(302);
  const requestId = new URL(authRes.headers.get("location")!).searchParams.get("request_id")!;
  const decide = await app.request("/oauth/authorize/decision", {
    method: "POST",
    headers: json(owner.session),
    body: JSON.stringify({ request_id: requestId, approve: true, agent_ids: agentIds }),
  });
  expect(decide.status).toBe(200);
  const { redirect } = (await decide.json()) as any;
  const code = new URL(redirect).searchParams.get("code")!;
  const exchanged = await tokenRequest({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: LOOPBACK_REDIRECT,
    code_verifier: verifier,
  });
  expect(exchanged.status).toBe(200);
  return { accessToken: exchanged.body.access_token as string, clientId };
}

// --- MCP client ----------------------------------------------------------

let rpcId = 0;
async function mcpAgent(token: string | undefined, method: string, params: Record<string, unknown> = {}) {
  const res = await app.request("/mcp/agent", {
    method: "POST",
    headers: { ...json(token), accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return { status: res.status, headers: res.headers, body: res.status === 200 ? ((await res.json()) as any) : null };
}

const callTool = (token: string, name: string, args: Record<string, unknown> = {}) =>
  mcpAgent(token, "tools/call", { name, arguments: args });

const toolText = (body: any): string => body.result.content[0].text as string;
const toolJson = (body: any): any => JSON.parse(toolText(body));

describe("agent MCP auth", () => {
  test("no token and garbage tokens get a 401 with the RFC 9728 discovery pointer", async () => {
    const expected = `Bearer resource_metadata="${oauthIssuer()}/.well-known/oauth-protected-resource"`;
    const none = await mcpAgent(undefined, "tools/list");
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe(expected);

    for (const bad of ["not-a-token", "aaa.bbb.ccc"]) {
      const res = await mcpAgent(bad, "tools/list");
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(expected);
    }
  });

  test("an owner session is not an agent credential here", async () => {
    const o = await ownerWithAgent("SessionAgent");
    expect((await mcpAgent(o.session, "tools/list")).status).toBe(401);
  });

  test("a classic agent token gets in and sees exactly the Phase 3 tool set", async () => {
    const o = await ownerWithAgent("ListAgent");
    const { status, body } = await mcpAgent(o.agentToken, "tools/list");
    expect(status).toBe(200);
    const names = (body.result.tools as any[]).map((t) => t.name).sort();
    expect(names).toEqual(["agent_whoami", "inbox_poll", "verse_discover", "world_clips", "world_look", "world_observe"]);
  });

  test("a wrong-audience JWT is refused even with a live grant behind its claims", async () => {
    const o = await ownerWithAgent("AudienceAgent");
    const { accessToken } = await mintOAuthToken(o, [o.agentId]);
    const claims = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    const foreign = await sign(
      { ...claims, aud: "https://elsewhere.example/mcp/agent", iat: now, exp: now + 3600 },
      env.JWT_SECRET,
    );
    expect((await mcpAgent(foreign, "tools/list")).status).toBe(401);
  });

  test("revoking the grant kills the access token at once, not at JWT expiry", async () => {
    const o = await ownerWithAgent("RevokeAgent");
    const { accessToken } = await mintOAuthToken(o, [o.agentId]);
    expect((await mcpAgent(accessToken, "tools/list")).status).toBe(200);

    const grants = ((await (await app.request("/oauth/grants", { headers: json(o.session) })).json()) as any).grants as any[];
    expect(grants).toHaveLength(1);
    const revoke = await app.request(`/oauth/grants/${grants[0].id}/revoke`, { method: "POST", headers: json(o.session) });
    expect(revoke.status).toBe(200);

    expect((await mcpAgent(accessToken, "tools/list")).status).toBe(401);
    const denied = await callTool(accessToken, "agent_whoami");
    expect(denied.status).toBe(401);
  });
});

describe("agent MCP with a classic agent token", () => {
  test("agent_whoami reports the agent, its auth kind, and visit state", async () => {
    const o = await ownerWithAgent("WhoAgent");
    const before = toolJson((await callTool(o.agentToken, "agent_whoami")).body);
    expect(before.agent).toEqual({ id: o.agentId, name: o.agentName, status: expect.any(String) });
    expect(before.auth).toEqual({ kind: "agent", scopes: null });
    expect(before.visit.active).toBe(false);

    await startVisit(o.session, o.agentId);
    const after = toolJson((await callTool(o.agentToken, "agent_whoami")).body);
    expect(after.visit.active).toBe(true);
    expect(new Date(after.visit.endsAt).getTime()).toBeGreaterThan(Date.now());
  });

  test("verse_discover returns the card, the roster, and the world summary", async () => {
    const o = await ownerWithAgent("DiscoverAgent");
    await startVisit(o.session, o.agentId);
    const { body } = await callTool(o.agentToken, "verse_discover");
    expect(body.result.isError).toBeFalsy();
    const out = toolJson(body);
    expect(out.card.name).toBe("AIVerse");
    expect(out.card["x-aiverse-directory"].discover).toContain("/agents/discover");
    expect(out.roster.count).toBeGreaterThanOrEqual(1);
    expect(out.roster.agents.every((a: any) => typeof a.id === "string" && typeof a.name === "string")).toBe(true);
    expect(out.world.placesCount).toBe(FAKE_PLACES.length);
    expect(out.world.places.some((p: any) => p.id === "shop-102" && p.room === "tea")).toBe(true);
  });

  test("world_clips serves the playable clip list the world route serves", async () => {
    const o = await ownerWithAgent("ClipsAgent");
    await startVisit(o.session, o.agentId);
    const { body } = await callTool(o.agentToken, "world_clips");
    expect(body.result.isError).toBeFalsy();
    const out = toolJson(body);
    // GET /world/clips is the play action's vocabulary: the social clips
    // from the 53-clip baked catalog, each with its loop flag.
    expect(out.clips).toHaveLength(SOCIAL_CLIPS.length);
    expect(out.clips.map((c: any) => c.name).sort()).toEqual([...SOCIAL_CLIPS].sort());
    const waving = out.clips.find((c: any) => c.name === "Waving");
    expect(typeof waving.loop).toBe("boolean");
  });

  test("world_observe and world_look surface the sim's no_body error verbatim; no visit surfaces no_visit", async () => {
    const o = await ownerWithAgent("ObserveAgent");
    const noVisit = await callTool(o.agentToken, "world_observe");
    expect(noVisit.body.result.isError).toBe(true);
    expect(toolText(noVisit.body)).toContain("no_visit");

    await startVisit(o.session, o.agentId);
    const observe = await callTool(o.agentToken, "world_observe");
    expect(observe.body.result.isError).toBe(true);
    expect(toolText(observe.body)).toContain('"error":"no_body"');
    expect(toolText(observe.body)).toContain("no body: attach one first");

    const look = await callTool(o.agentToken, "world_look");
    expect(look.body.result.isError).toBe(true);
    expect(toolText(look.body)).toContain('"error":"no_body"');
  });
});

describe("agent MCP with an OAuth token", () => {
  test("whoami shows the delegation: kind, scopes, agent set, grant", async () => {
    const o = await ownerWithAgent("DelegatedAgent");
    const { accessToken } = await mintOAuthToken(o, [o.agentId], "world:observe inbox:read discover");
    const { body } = await callTool(accessToken, "agent_whoami");
    expect(body.result.isError).toBeFalsy();
    const out = toolJson(body);
    expect(out.agent.id).toBe(o.agentId);
    expect(out.auth.kind).toBe("oauth");
    expect(out.auth.agents).toEqual([o.agentId]);
    expect(out.auth.scopes.sort()).toEqual(["discover", "inbox:read", "world:observe"]);
    expect(out.auth.grantId).toBeTruthy();
  });

  test("an OAuth token dispatches world reads as its agent", async () => {
    const o = await ownerWithAgent("DispatchAgent");
    await startVisit(o.session, o.agentId);
    const { accessToken } = await mintOAuthToken(o, [o.agentId]);
    const observe = await callTool(accessToken, "world_observe");
    expect(observe.body.result.isError).toBe(true);
    // The refusal is the sim's (the token authenticated and dispatched).
    expect(toolText(observe.body)).toContain('"error":"no_body"');
  });
});

describe("scope gates (OAuth only)", () => {
  test("a discover-only token is refused world_observe and inbox_poll, naming the missing scopes", async () => {
    const o = await ownerWithAgent("GateAgent");
    const { accessToken } = await mintOAuthToken(o, [o.agentId], "discover");

    const observe = await callTool(accessToken, "world_observe");
    expect(observe.body.result.isError).toBe(true);
    expect(toolText(observe.body)).toContain("insufficient_scope");
    expect(toolText(observe.body)).toContain("world:observe");

    const clips = await callTool(accessToken, "world_clips");
    expect(clips.body.result.isError).toBe(true);
    expect(toolText(clips.body)).toContain("insufficient_scope");

    const inbox = await callTool(accessToken, "inbox_poll");
    expect(inbox.body.result.isError).toBe(true);
    expect(toolText(inbox.body)).toContain("insufficient_scope");
    expect(toolText(inbox.body)).toContain("inbox:read");

    const discover = await callTool(accessToken, "verse_discover");
    expect(discover.status).toBe(200);
    expect(discover.body.result.isError).toBeFalsy();
  });

  test("an observe-scoped token passes the observe gate but not the inbox gate", async () => {
    const o = await ownerWithAgent("ObserveScopeAgent");
    const { accessToken } = await mintOAuthToken(o, [o.agentId], "world:observe");
    const observe = await callTool(accessToken, "world_observe");
    expect(toolText(observe.body)).not.toContain("insufficient_scope");
    const inbox = await callTool(accessToken, "inbox_poll");
    expect(inbox.body.result.isError).toBe(true);
    expect(toolText(inbox.body)).toContain("inbox:read");
  });
});

describe("multi-agent grants", () => {
  test("observe needs an explicit, granted agent_id", async () => {
    const o = await ownerWithAgent("MultiA");
    const b = await secondAgent(o.session, "MultiB");
    const outsider = await ownerWithAgent("MultiOutsider");
    await startVisit(o.session, o.agentId);
    await startVisit(o.session, b);
    const { accessToken } = await mintOAuthToken(o, [o.agentId, b]);

    const noPick = await callTool(accessToken, "world_observe");
    expect(noPick.body.result.isError).toBe(true);
    expect(toolText(noPick.body)).toContain("agent_id");

    const picked = await callTool(accessToken, "world_observe", { agent_id: b });
    expect(picked.body.result.isError).toBe(true);
    // Dispatched as B (visit live, no body): the sim's refusal, not auth's.
    expect(toolText(picked.body)).toContain('"error":"no_body"');

    const foreign = await callTool(accessToken, "world_observe", { agent_id: outsider.agentId });
    expect(foreign.body.result.isError).toBe(true);
    expect(toolText(foreign.body)).toContain("not covered by this token's grant");

    const who = toolJson((await callTool(accessToken, "agent_whoami", { agent_id: o.agentId })).body);
    expect(who.agent.id).toBe(o.agentId);
  });
});

describe("inbox_poll", () => {
  test("lists conversations and pages one conversation's messages with after=", async () => {
    const a = await ownerWithAgent("InboxA");
    const b = await ownerWithAgent("InboxB");
    for (const t of [a, b]) {
      await app.request(`/owners/agents/${t.agentId}/wallet`, { method: "PATCH", headers: json(t.session), body: JSON.stringify({ autonomyMode: "autonomous" }) });
    }
    const conv = (await (await app.request("/conversations", {
      method: "POST",
      headers: json(a.agentToken),
      body: JSON.stringify({ isPublic: false, name: "mcp-agent-inbox-test", participantIds: [b.agentId] }),
    })).json()) as any;
    const conversationId = conv.conversation.id as string;
    for (const [i, text] of ["hello-one", "hello-two", "hello-three"].entries()) {
      await resetMemoryStoreForTests();
      const send = await app.request(`/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: json(i % 2 ? b.agentToken : a.agentToken),
        body: JSON.stringify({ content: text }),
      });
      expect(send.status).toBe(201);
      await drainIngestStream();
    }

    const list = toolJson((await callTool(a.agentToken, "inbox_poll")).body);
    const mine = (list.conversations as any[]).find((c) => c.conversation_id === conversationId);
    expect(mine).toBeTruthy();

    const page = toolJson((await callTool(a.agentToken, "inbox_poll", { conversation_id: conversationId })).body);
    const texts = (page.messages as any[]).map((m) => m.content);
    expect(texts).toEqual(["hello-one", "hello-two", "hello-three"]);

    const firstId = (page.messages as any[])[0].id as string;
    const rest = toolJson((await callTool(a.agentToken, "inbox_poll", { conversation_id: conversationId, after: firstId })).body);
    expect((rest.messages as any[]).map((m) => m.content)).toEqual(["hello-two", "hello-three"]);
    expect(rest.hasMore).toBe(false);
  });

  test("an inbox:read-scoped OAuth token polls its agent's inbox", async () => {
    const a = await ownerWithAgent("InboxOAuthA");
    const { accessToken } = await mintOAuthToken(a, [a.agentId], "inbox:read");
    const { body } = await callTool(accessToken, "inbox_poll");
    expect(body.result.isError).toBeFalsy();
    expect(Array.isArray(toolJson(body).conversations)).toBe(true);
  });
});

describe("resources", () => {
  test("the guide and the agent card are readable in-protocol", async () => {
    const o = await ownerWithAgent("ResourceAgent");
    const list = await mcpAgent(o.agentToken, "resources/list");
    expect(list.status).toBe(200);
    const uris = (list.body.result.resources as any[]).map((r) => r.uri);
    expect(uris).toContain("aiverse://guide");
    expect(uris).toContain("aiverse://agent-card");

    const guide = await mcpAgent(o.agentToken, "resources/read", { uri: "aiverse://guide" });
    expect(guide.body.result.contents[0].text).toContain("go_to");

    const card = await mcpAgent(o.agentToken, "resources/read", { uri: "aiverse://agent-card" });
    expect(JSON.parse(card.body.result.contents[0].text).name).toBe("AIVerse");
  });
});
