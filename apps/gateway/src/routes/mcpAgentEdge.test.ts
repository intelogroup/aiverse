import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sign } from "hono/jwt";
import { eq } from "drizzle-orm";
import { env } from "@aiverse/shared/env";
import { agents, owners } from "@aiverse/shared/schema";
import { SOCIAL_CLIPS, clipDef } from "@aiverse/world-sim/clips";
import { explainAction } from "@aiverse/world-sim/actionProtocol";
import { createApp } from "../app";
import { db } from "../db/client";
import { computeS256Challenge, oauthIssuer } from "../auth/oauthCore";
import { resolveAgentAuth } from "../auth/resolveAgent";
import { resetMemoryStoreForTests } from "../policy/memoryStore";
import { drainIngestStream } from "../jobs/ingestConsumer";
import type { SimClient } from "../world/simClient";

// Adversarial edges for the agent MCP + the resolver behind it — the cases
// the happy-path suite (mcpAgent.test.ts) does not pin: forged/expired
// credentials at the protocol door, x-agent-id impersonation against a
// classic token, an agent transferred away from the grant's owner,
// JSON-RPC protocol abuse shapes, relay into a foreign conversation,
// malformed acts, inbox abuse shapes, and a visit ending mid-body.
// The fake sim is the same seam (and the same stateful body ledger) as
// mcpAgent.test.ts; refusals are worded by the sim's own explainAction.

const FAKE_PLACES = [
  { id: "shop-102", name: "Matchmaker's Tea House", kind: "shop", room: "tea" },
  { id: "plaza", name: "Central Plaza", kind: "plaza", room: null },
  { id: "stall-3", name: "Noodle Stall", kind: "stall", room: null },
];

interface FakeBody {
  figure: string;
  records: Map<string, { actionJson: string; record: any }>;
}
const fakeBodies = new Map<string, FakeBody>();

const fakeObservation = (agentId: string) => ({
  t: 0,
  body: { figure: fakeBodies.get(agentId)!.figure, x: 0, z: 0, heading: 0, posture: "standing" },
  nearestPlace: { id: "plaza", name: "Central Plaza", kind: "plaza", dist: 0 },
  insideRoom: null,
  scene: [],
  lastAct: null,
  heard: [],
});
const simNoBody = () => Response.json({ error: "no_body", message: "no body: attach one first" }, { status: 404 });

const fakeSim: SimClient = {
  async call(method, path, rawBody) {
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

    const parts = path.split("?")[0].split("/").filter(Boolean);
    if (method === "POST" && parts.length === 1 && parts[0] === "bodies") {
      const b = JSON.parse(rawBody ?? "{}") as { agentId: string; body?: string };
      const have = fakeBodies.get(b.agentId);
      if (have) {
        if (b.body !== undefined && b.body !== have.figure) {
          return Response.json(
            { error: "id_conflict", message: `body already attached as ${have.figure}; detach first (DELETE /world/body) to change figure` },
            { status: 409 },
          );
        }
        return Response.json({ observation: fakeObservation(b.agentId) }, { status: 200 });
      }
      fakeBodies.set(b.agentId, { figure: b.body ?? "remy", records: new Map() });
      return Response.json({ observation: fakeObservation(b.agentId) }, { status: 201 });
    }
    if (parts[0] === "bodies" && parts[1]) {
      const agentId = parts[1];
      const mine = fakeBodies.get(agentId);
      if (method === "DELETE" && parts.length === 2) {
        return Response.json({ removed: fakeBodies.delete(agentId) });
      }
      if (method === "GET" && parts.length === 2) {
        if (!mine) return simNoBody();
        return Response.json({ body: { figure: mine.figure, x: 0, z: 0, heading: 0, posture: "standing" } });
      }
      if (method === "GET" && parts[2] === "observe") {
        if (!mine) return simNoBody();
        return Response.json({ observation: fakeObservation(agentId) });
      }
      if (method === "POST" && parts[2] === "look") {
        if (!mine) return simNoBody();
        return Response.json({ look: { width: 2, height: 2, observation: fakeObservation(agentId) } });
      }
      if (method === "POST" && parts[2] === "act") {
        if (!mine) return simNoBody();
        const b = JSON.parse(rawBody ?? "{}") as { id: string; action: unknown };
        const actionJson = JSON.stringify(b.action);
        const existing = mine.records.get(b.id);
        if (existing) {
          if (existing.actionJson !== actionJson) {
            return Response.json({ error: "id_conflict", message: "request ID reused with different action" }, { status: 409 });
          }
          return Response.json({ act: existing.record }, { status: 200 });
        }
        const why = explainAction(b.action);
        if (why) return Response.json({ error: "invalid_action", message: why }, { status: 400 });
        const record =
          (b.action as { type?: string }).type === "say"
            ? { id: b.id, action: b.action, state: "settled", startedAt: 0, settledAt: 0, outcome: { ok: true, status: "done", detail: "nobody within earshot heard you" } }
            : { id: b.id, action: b.action, state: "running", startedAt: 0 };
        mine.records.set(b.id, { actionJson, record });
        return Response.json({ act: record }, { status: 202 });
      }
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
  const email = `mcpedge-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", { method: "POST", headers: json(), body: JSON.stringify({ email, password: "password123" }) });
  expect(reg.status).toBe(201);
  const { token: session } = (await reg.json()) as any;
  const created = await app.request("/owners/agents", { method: "POST", headers: json(session), body: JSON.stringify({ name: `${name}-${Math.random().toString(36).slice(2, 8)}`, capabilities: [] }) });
  expect(created.status).toBe(201);
  const { agent, agentToken } = (await created.json()) as any;
  return { session: session as string, email, agentId: agent.id as string, agentName: agent.name as string, agentToken: agentToken as string };
}

const startVisit = async (ownerToken: string, agentId: string, maxActions = 50) =>
  ((await (await app.request(`/owners/agents/${agentId}/visits`, { method: "POST", headers: json(ownerToken), body: JSON.stringify({ minutes: 30, maxActions }) })).json()) as any).visit;

async function setAutonomous(session: string, agentId: string) {
  await app.request(`/owners/agents/${agentId}/wallet`, {
    method: "PATCH",
    headers: json(session),
    body: JSON.stringify({ autonomyMode: "autonomous" }),
  });
}

// --- OAuth minting, driven through the real Phase 1 flow ----------------

async function registerClient() {
  const res = await app.request("/oauth/register", {
    method: "POST",
    headers: json(),
    body: JSON.stringify({ client_name: "edge mcp client", redirect_uris: [LOOPBACK_REDIRECT] }),
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
async function mcpRaw(token: string | undefined, rawBody: string, method = "POST") {
  const res = await app.request("/mcp/agent", {
    method,
    headers: { ...json(token), accept: "application/json, text/event-stream" },
    body: rawBody,
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    // leave null — the assertion is then on status/text
  }
  return { status: res.status, headers: res.headers, body, text };
}
async function mcpAgent(token: string | undefined, method: string, params: Record<string, unknown> = {}) {
  return mcpRaw(token, JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }));
}
const callTool = (token: string, name: string, args: Record<string, unknown> = {}) =>
  mcpAgent(token, "tools/call", { name, arguments: args });
const toolText = (body: any): string => body.result.content[0].text as string;
const toolJson = (body: any): any => JSON.parse(toolText(body));
const toolErrorJson = (body: any): any => JSON.parse(toolText(body));

const EXPECTED_WWW_AUTH = () => `Bearer resource_metadata="${oauthIssuer()}/.well-known/oauth-protected-resource"`;

describe("forged + expired credentials at the MCP door", () => {
  test("a tampered access token (payload flipped) is 401 with the discovery pointer", async () => {
    const o = await ownerWithAgent("TamperAgent");
    const { accessToken } = await mintOAuthToken(o, [o.agentId]);
    expect((await mcpAgent(accessToken, "tools/list")).status).toBe(200); // sanity

    const [h, p, s] = accessToken.split(".");
    const flipped = (p[0] === "A" ? "B" : "A") + p.slice(1);
    const tampered = await mcpAgent(`${h}.${flipped}.${s}`, "tools/list");
    expect(tampered.status).toBe(401);
    expect(tampered.headers.get("www-authenticate")).toBe(EXPECTED_WWW_AUTH());
  });

  test("an alg=none token carrying real claims is 401 with the discovery pointer", async () => {
    const o = await ownerWithAgent("NoneAlgAgent");
    const { accessToken } = await mintOAuthToken(o, [o.agentId]);
    const claims = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8"));
    const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    const noneToken = `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.`;
    const res = await mcpAgent(noneToken, "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(EXPECTED_WWW_AUTH());
  });

  test("an expired access token is 401 with the discovery pointer intact", async () => {
    const o = await ownerWithAgent("ExpiredAccessAgent");
    const { accessToken } = await mintOAuthToken(o, [o.agentId]);
    const claims = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    const expired = await sign({ ...claims, iat: now - 7200, exp: now - 3600 }, env.JWT_SECRET);
    const res = await mcpAgent(expired, "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(EXPECTED_WWW_AUTH());
  });
});

describe("x-agent-id cannot widen a classic token", () => {
  test("a classic token + x-agent-id naming another agent still resolves its OWN agent", async () => {
    const a = await ownerWithAgent("HintA");
    const b = await ownerWithAgent("HintB");
    const c = await ownerWithAgent("HintC");
    await setAutonomous(a.session, a.agentId);
    await setAutonomous(b.session, b.agentId);

    const convA = (await (await app.request("/conversations", {
      method: "POST",
      headers: json(a.agentToken),
      body: JSON.stringify({ isPublic: false, name: "hint-a-conv", participantIds: [b.agentId] }),
    })).json()) as any;
    const convB = (await (await app.request("/conversations", {
      method: "POST",
      headers: json(b.agentToken),
      body: JSON.stringify({ isPublic: false, name: "hint-b-conv", participantIds: [c.agentId] }),
    })).json()) as any;

    const listAs = async (headers: Record<string, string>) => {
      const res = await app.request("/conversations", { headers });
      expect(res.status).toBe(200);
      return ((await res.json()) as any).conversations as any[];
    };
    const plain = await listAs(json(a.agentToken));
    expect(plain.map((x) => x.conversation_id)).toContain(convA.conversation.id);
    expect(plain.map((x) => x.conversation_id)).not.toContain(convB.conversation.id);

    // The hint names B — if it were honored, A's call would read B's list.
    const hinted = await listAs({ ...json(a.agentToken), "x-agent-id": b.agentId });
    expect(hinted.map((x) => x.conversation_id)).toContain(convA.conversation.id);
    expect(hinted.map((x) => x.conversation_id)).not.toContain(convB.conversation.id);

    // The resolver itself: a classic credential's resolution ignores the hint.
    const resolved = await resolveAgentAuth(a.agentToken, b.agentId);
    expect(resolved?.agent.id).toBe(a.agentId);
    expect(resolved?.auth.kind).toBe("agent");
  });
});

describe("an agent transferred away from the grant's owner fails closed", () => {
  test("resolution, REST dispatch, and MCP dispatch all refuse after the transfer", async () => {
    const a = await ownerWithAgent("TransferA");
    const b = await ownerWithAgent("TransferB");
    const { accessToken } = await mintOAuthToken(a, [a.agentId], "world:observe");

    // Before: the resolver resolves the token to A's agent, and a REST
    // world call authenticates (the refusal is the world's no_visit, not auth's).
    const before = await resolveAgentAuth(accessToken, a.agentId);
    expect(before?.agent.id).toBe(a.agentId);
    expect(before?.auth.kind).toBe("oauth");
    const restBefore = await app.request("/world/observe", {
      headers: { ...json(accessToken), "x-agent-id": a.agentId },
    });
    expect(restBefore.status).toBe(403);
    expect(((await restBefore.json()) as any).error).toBe("no_visit");

    // The agent changes owners (an owner-side transfer, fixture-applied).
    const newOwner = await db.query.owners.findFirst({ where: eq(owners.email, b.email) });
    expect(newOwner).toBeTruthy();
    await db.update(agents).set({ ownerId: newOwner!.id }).where(eq(agents.id, a.agentId));

    // After: the resolver's fail-closed check bites at every layer.
    expect(await resolveAgentAuth(accessToken, a.agentId)).toBeUndefined();
    const restAfter = await app.request("/world/observe", {
      headers: { ...json(accessToken), "x-agent-id": a.agentId },
    });
    expect(restAfter.status).toBe(401);
    expect(((await restAfter.json()) as any).error).toBe("unauthorized");

    const viaMcp = await callTool(accessToken, "world_observe");
    expect(viaMcp.body.result.isError).toBe(true);
    expect(toolText(viaMcp.body)).toContain("unauthorized");
  });
});

describe("protocol edges", () => {
  test("GET is a 405 JSON-RPC error, with or without a token", async () => {
    const o = await ownerWithAgent("MethodAgent");
    for (const token of [o.agentToken, undefined]) {
      const res = await mcpRaw(token, "", "GET");
      expect(res.status).toBe(405);
      expect(res.body.jsonrpc).toBe("2.0");
      expect(res.body.error.code).toBe(-32000);
      expect(res.body.error.message).toContain("Method not allowed");
    }
  });

  test("a malformed JSON body is a clean -32700 parse error, not a 500", async () => {
    const o = await ownerWithAgent("ParseAgent");
    const res = await mcpRaw(o.agentToken, "{not json");
    expect(res.status).toBe(400);
    expect(res.body.jsonrpc).toBe("2.0");
    expect(res.body.error.code).toBe(-32700);
  });

  test("tools/call naming a nonexistent tool is a clean tool error, not a 500", async () => {
    const o = await ownerWithAgent("UnknownToolAgent");
    const res = await callTool(o.agentToken, "does_not_exist", {});
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(true);
    expect(toolText(res.body)).toContain("does_not_exist");
  });
});

describe("relay into a foreign conversation", () => {
  test("relay_send into a conversation the agent does NOT participate in is refused and delivers nothing", async () => {
    const a = await ownerWithAgent("RelayOutsiderA");
    const b = await ownerWithAgent("RelayInsiderB");
    const c = await ownerWithAgent("RelayInsiderC");
    await setAutonomous(b.session, b.agentId);
    await setAutonomous(c.session, c.agentId);

    const conv = (await (await app.request("/conversations", {
      method: "POST",
      headers: json(b.agentToken),
      body: JSON.stringify({ isPublic: false, name: "edge-foreign-conv", participantIds: [c.agentId] }),
    })).json()) as any;
    const conversationId = conv.conversation.id as string;

    const sent = await callTool(a.agentToken, "relay_send", { conversation_id: conversationId, content: "intruder message" });
    expect(sent.body.result.isError).toBe(true);
    expect(toolErrorJson(sent.body).error).toBe("not a participant");

    // Nothing was delivered: an insider reads an empty thread.
    const read = toolJson((await callTool(b.agentToken, "inbox_poll", { conversation_id: conversationId })).body);
    expect(read.messages).toEqual([]);
  });
});

describe("malformed world_act", () => {
  test("missing fields and non-object actions get the sim's refusal; state is unchanged", async () => {
    const o = await ownerWithAgent("MalformedActor");
    await startVisit(o.session, o.agentId);
    const attach = toolJson((await callTool(o.agentToken, "body_attach", { body: "summer" })).body);
    expect(attach.observation.body.figure).toBe("summer");
    const before = toolJson((await callTool(o.agentToken, "world_observe")).body);

    const noClip = await callTool(o.agentToken, "world_act", { action: { type: "play" } });
    expect(noClip.body.result.isError).toBe(true);
    const noClipErr = toolErrorJson(noClip.body);
    expect(noClipErr.error).toBe("invalid_action");
    expect(noClipErr.message).toContain("unknown clip");

    const noTarget = await callTool(o.agentToken, "world_act", { action: { type: "go_to" } });
    expect(noTarget.body.result.isError).toBe(true);
    const noTargetErr = toolErrorJson(noTarget.body);
    expect(noTargetErr.error).toBe("invalid_action");
    expect(noTargetErr.message).toContain("needs exactly one of");

    const notAnObject = await callTool(o.agentToken, "world_act", { action: "Waving" });
    expect(notAnObject.body.result.isError).toBe(true);
    const notObjErr = toolErrorJson(notAnObject.body);
    expect(notObjErr.error).toBe("invalid_action");
    expect(notObjErr.message).toContain("action must be an object");

    // No phantom action: the body is exactly where and how it was.
    const after = toolJson((await callTool(o.agentToken, "world_observe")).body);
    expect(after).toEqual(before);
  });
});

describe("inbox_poll abuse shapes", () => {
  test("a limit far above the cap and a garbage after cursor are clean errors, never a 500", async () => {
    const a = await ownerWithAgent("InboxAbuseA");
    const b = await ownerWithAgent("InboxAbuseB");
    await setAutonomous(a.session, a.agentId);
    const conv = (await (await app.request("/conversations", {
      method: "POST",
      headers: json(a.agentToken),
      body: JSON.stringify({ isPublic: false, name: "edge-inbox-abuse", participantIds: [b.agentId] }),
    })).json()) as any;
    const conversationId = conv.conversation.id as string;

    // At the REST route the limit is clamped server-side (cap 500).
    const rest = await app.request(`/conversations/${conversationId}/messages?limit=100000`, {
      headers: json(a.agentToken),
    });
    expect(rest.status).toBe(200);
    const restBody = (await rest.json()) as any;
    expect(Array.isArray(restBody.messages)).toBe(true);
    expect(restBody.messages.length).toBeLessThanOrEqual(500);

    // A garbage cursor at REST is a clean 400, not a 500.
    const restAfter = await app.request(`/conversations/${conversationId}/messages?after=garbage-cursor`, {
      headers: json(a.agentToken),
    });
    expect(restAfter.status).toBe(400);
    expect(((await restAfter.json()) as any).error).toContain("invalid parameter format");

    // Through the MCP tool the oversized limit is refused by input
    // validation as a clean tool error.
    const hugeLimit = await callTool(a.agentToken, "inbox_poll", { conversation_id: conversationId, limit: 100000 });
    expect(hugeLimit.status).toBe(200);
    expect(hugeLimit.body.result.isError).toBe(true);
    expect(toolText(hugeLimit.body)).toContain("<=500");

    // And the garbage cursor surfaces the route's own clean error verbatim.
    const garbage = await callTool(a.agentToken, "inbox_poll", { conversation_id: conversationId, after: "garbage-cursor" });
    expect(garbage.body.result.isError).toBe(true);
    expect(toolText(garbage.body)).toContain("invalid parameter format");
  });
});

describe("visit ending mid-body", () => {
  test("attach, owner stops the visit, then world_act surfaces the visit_ended refusal verbatim", async () => {
    const o = await ownerWithAgent("VisitEndActor");
    const visit = await startVisit(o.session, o.agentId);
    const attach = toolJson((await callTool(o.agentToken, "body_attach", { body: "summer" })).body);
    expect(attach.observation.body.figure).toBe("summer");

    const stop = await app.request(`/owners/agents/${o.agentId}/visits/${visit.id}/stop`, {
      method: "POST",
      headers: json(o.session),
    });
    expect(stop.status).toBe(200);

    const act = await callTool(o.agentToken, "world_act", { action: { type: "wait", seconds: 1 } });
    expect(act.body.result.isError).toBe(true);
    const actErr = toolErrorJson(act.body);
    expect(actErr.error).toBe("visit_ended");
    expect(actErr.reason).toBe("owner_stopped");

    // Reads are refused too — the visit is over, not just its action budget.
    const observe = await callTool(o.agentToken, "world_observe");
    expect(observe.body.result.isError).toBe(true);
    expect(toolErrorJson(observe.body).error).toBe("visit_ended");
  });
});
