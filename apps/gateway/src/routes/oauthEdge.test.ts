import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { oauthAuthRequests, oauthCodes, oauthGrants } from "@aiverse/shared/schema";
import { createApp } from "../app";
import { db } from "../db/client";
import { computeS256Challenge, hashAuthorizationCode, oauthIssuer } from "../auth/oauthCore";

// Adversarial edges for the OAuth 2.1 authorization server — the cases the
// happy-path suite (oauth.test.ts) does not pin: code lifetime and the
// concurrent-redemption race, token-endpoint scope discipline, cross-client
// refresh, grant expiry (not just revocation), and consent-decision
// consumption on the approve path. Where an edge is already pinned by
// oauth.test.ts (plain PKCE, wrong verifier, unregistered redirect_uri at
// authorize, decision narrowing), it is cited there, not duplicated here.

const app = createApp();

const LOOPBACK_REDIRECT = "http://localhost:53111/oauth-callback";

function jsonHeaders(token?: string) {
  return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

async function ownerWithAgent(name: string) {
  const email = `oauthedge-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ email, password: "password123" }),
  });
  expect(reg.status).toBe(201);
  const { token: session } = (await reg.json()) as any;
  const uniqueName = `${name}-${Math.random().toString(36).slice(2, 8)}`;
  const created = await app.request("/owners/agents", {
    method: "POST",
    headers: jsonHeaders(session),
    body: JSON.stringify({ name: uniqueName, capabilities: [] }),
  });
  expect(created.status).toBe(201);
  const { agent } = (await created.json()) as any;
  return { session: session as string, agentId: agent.id as string };
}

async function registerClient() {
  const res = await app.request("/oauth/register", {
    method: "POST",
    headers: jsonHeaders(),
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

async function decide(session: string, requestId: string, body: Record<string, unknown>) {
  return app.request("/oauth/authorize/decision", {
    method: "POST",
    headers: jsonHeaders(session),
    body: JSON.stringify({ request_id: requestId, ...body }),
  });
}

/** authorize → approve; returns everything the token endpoint will ask for. */
async function approveFlow(owner: { session: string; agentId: string }, opts: { scope?: string } = {}) {
  const clientId = await registerClient();
  const verifier = randomBytes(32).toString("base64url");
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: LOOPBACK_REDIRECT,
    response_type: "code",
    code_challenge: computeS256Challenge(verifier),
    code_challenge_method: "S256",
    state: "state-123",
    ...(opts.scope ? { scope: opts.scope } : {}),
  });
  const authRes = await app.request(`/oauth/authorize?${q}`);
  expect(authRes.status).toBe(302);
  const requestId = new URL(authRes.headers.get("location")!).searchParams.get("request_id")!;
  const res = await decide(owner.session, requestId, { approve: true, agent_ids: [owner.agentId] });
  expect(res.status).toBe(200);
  const { redirect } = (await res.json()) as any;
  const code = new URL(redirect).searchParams.get("code")!;
  return { clientId, code, verifier, requestId };
}

async function listGrants(session: string) {
  const res = await app.request("/oauth/grants", { headers: jsonHeaders(session) });
  expect(res.status).toBe(200);
  return ((await res.json()) as any).grants as any[];
}

const exchange = (f: { clientId: string; code: string; verifier: string }, extra: Record<string, string> = {}) =>
  tokenRequest({
    grant_type: "authorization_code",
    client_id: f.clientId,
    code: f.code,
    redirect_uri: LOOPBACK_REDIRECT,
    code_verifier: f.verifier,
    ...extra,
  });

describe("authorization code lifetime + redemption race", () => {
  test("an expired code (past its 60 s life) is invalid_grant at exchange", async () => {
    const owner = await ownerWithAgent("ExpiredCodeAgent");
    const flow = await approveFlow(owner);
    await db
      .update(oauthCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthCodes.codeHash, hashAuthorizationCode(flow.code)));
    const res = await exchange(flow);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
    expect(res.body.error_description).toContain("expired");
  });

  test("the same code exchanged twice CONCURRENTLY succeeds exactly once", async () => {
    const owner = await ownerWithAgent("RaceAgent");
    const flow = await approveFlow(owner);
    const [a, b] = await Promise.all([exchange(flow), exchange(flow)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 400]);
    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    expect(winner.body.access_token).toBeTruthy();
    expect(winner.body.refresh_token).toBeTruthy();
    expect(loser.body.error).toBe("invalid_grant");
    // And the code stays burned for a third, sequential attempt.
    const third = await exchange(flow);
    expect(third.status).toBe(400);
    expect(third.body.error).toBe("invalid_grant");
  });

  test("exchange with NO code_verifier (a challenge was set) is refused", async () => {
    const owner = await ownerWithAgent("NoVerifierAgent");
    const flow = await approveFlow(owner);
    const res = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: flow.clientId,
        code: flow.code,
        redirect_uri: LOOPBACK_REDIRECT,
      }).toString(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toBe("invalid_request");
  });

  test("exchange presenting a different redirect_uri than authorize used fails", async () => {
    const owner = await ownerWithAgent("RedirectSwapAgent");
    const flow = await approveFlow(owner);
    const res = await tokenRequest({
      grant_type: "authorization_code",
      client_id: flow.clientId,
      code: flow.code,
      redirect_uri: "http://localhost:53111/other-callback",
      code_verifier: flow.verifier,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
    expect(res.body.error_description).toContain("redirect_uri");
    // The failed attempt must not burn the code: the honest exchange works.
    const honest = await exchange(flow);
    expect(honest.status).toBe(200);
  });
});

describe("scope discipline at the token endpoint", () => {
  test("a scope parameter on exchange or refresh never widens past the grant", async () => {
    const owner = await ownerWithAgent("ScopePinAgent");
    const flow = await approveFlow(owner, { scope: "world:observe" });

    const exchanged = await exchange(flow, { scope: "world:act relay:send" });
    expect(exchanged.status).toBe(200);
    expect(exchanged.body.scope).toBe("world:observe");
    const claims = JSON.parse(Buffer.from(exchanged.body.access_token.split(".")[1], "base64url").toString("utf8"));
    expect(claims.scope).toBe("world:observe");

    const refreshed = await tokenRequest({
      grant_type: "refresh_token",
      client_id: flow.clientId,
      refresh_token: exchanged.body.refresh_token,
      scope: "world:act",
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.scope).toBe("world:observe");
    const refreshedClaims = JSON.parse(
      Buffer.from(refreshed.body.access_token.split(".")[1], "base64url").toString("utf8"),
    );
    expect(refreshedClaims.scope).toBe("world:observe");
  });
});

describe("refresh token client binding + grant lifetime", () => {
  test("a refresh token presented by a DIFFERENT client is invalid_grant — and is not burned by the attempt", async () => {
    const owner = await ownerWithAgent("ClientBindAgent");
    const flow = await approveFlow(owner);
    const exchanged = await exchange(flow);
    expect(exchanged.status).toBe(200);
    const refresh = exchanged.body.refresh_token as string;

    const foreignClient = await registerClient();
    const foreign = await tokenRequest({
      grant_type: "refresh_token",
      client_id: foreignClient,
      refresh_token: refresh,
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toBe("invalid_grant");

    // The rightful client can still rotate it — the foreign attempt neither
    // consumed the token nor tripped reuse detection.
    const own = await tokenRequest({ grant_type: "refresh_token", client_id: flow.clientId, refresh_token: refresh });
    expect(own.status).toBe(200);
    expect(own.body.refresh_token).toBeTruthy();
  });

  test("past the grant's lifetime: refresh fails AND the outstanding access token stops resolving", async () => {
    const owner = await ownerWithAgent("GrantExpiryAgent");
    const flow = await approveFlow(owner);
    const exchanged = await exchange(flow);
    expect(exchanged.status).toBe(200);
    const accessToken = exchanged.body.access_token as string;

    // Sanity: the access token resolves at the agent MCP right now.
    const alive = await app.request("/mcp/agent", {
      method: "POST",
      headers: { ...jsonHeaders(accessToken), accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(alive.status).toBe(200);

    const grantId = (await listGrants(owner.session))[0].id as string;
    await db
      .update(oauthGrants)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthGrants.id, grantId));

    const refreshed = await tokenRequest({
      grant_type: "refresh_token",
      client_id: flow.clientId,
      refresh_token: exchanged.body.refresh_token,
    });
    expect(refreshed.status).toBe(400);
    expect(refreshed.body.error).toBe("invalid_grant");

    // The JWT itself is nowhere near its own 1 h expiry — it dies because
    // the grant behind it ended (per-request liveness, not TTL).
    const dead = await app.request("/mcp/agent", {
      method: "POST",
      headers: { ...jsonHeaders(accessToken), accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(dead.status).toBe(401);
    expect(dead.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${oauthIssuer()}/.well-known/oauth-protected-resource"`,
    );
  });
});

describe("consent decision edges", () => {
  test("approving twice mints exactly one grant — the second decision fails", async () => {
    const owner = await ownerWithAgent("DoubleApproveAgent");
    const clientId = await registerClient();
    const verifier = randomBytes(32).toString("base64url");
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: LOOPBACK_REDIRECT,
      response_type: "code",
      code_challenge: computeS256Challenge(verifier),
      code_challenge_method: "S256",
    });
    const authRes = await app.request(`/oauth/authorize?${q}`);
    const requestId = new URL(authRes.headers.get("location")!).searchParams.get("request_id")!;

    const first = await decide(owner.session, requestId, { approve: true, agent_ids: [owner.agentId] });
    expect(first.status).toBe(200);
    const second = await decide(owner.session, requestId, { approve: true, agent_ids: [owner.agentId] });
    expect(second.status).toBe(400);
    expect((await listGrants(owner.session)).filter((g) => g.client_id === clientId)).toHaveLength(1);
  });

  test("deciding an expired request fails", async () => {
    const owner = await ownerWithAgent("ExpiredRequestAgent");
    const clientId = await registerClient();
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: LOOPBACK_REDIRECT,
      response_type: "code",
      code_challenge: computeS256Challenge(randomBytes(32).toString("base64url")),
      code_challenge_method: "S256",
    });
    const authRes = await app.request(`/oauth/authorize?${q}`);
    const requestId = new URL(authRes.headers.get("location")!).searchParams.get("request_id")!;
    await db
      .update(oauthAuthRequests)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthAuthRequests.id, requestId));
    const res = await decide(owner.session, requestId, { approve: true, agent_ids: [owner.agentId] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("invalid_request");
    expect(await listGrants(owner.session)).toEqual([]);
  });

  test("a different owner deciding cannot grant the first owner's agent — no grant is created for anyone", async () => {
    // Auth requests carry no owner by design (the request_id is the
    // capability the client's browser flow holds), so the fail-closed
    // property that matters is the agent-ownership check at decision time:
    // whoever is signed in can only ever grant agents THEY own.
    const owner = await ownerWithAgent("RequestOwnerA");
    const stranger = await ownerWithAgent("RequestOwnerB");
    const clientId = await registerClient();
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: LOOPBACK_REDIRECT,
      response_type: "code",
      code_challenge: computeS256Challenge(randomBytes(32).toString("base64url")),
      code_challenge_method: "S256",
    });
    const authRes = await app.request(`/oauth/authorize?${q}`);
    const requestId = new URL(authRes.headers.get("location")!).searchParams.get("request_id")!;

    const foreign = await decide(stranger.session, requestId, { approve: true, agent_ids: [owner.agentId] });
    expect(foreign.status).toBe(400);
    expect(((await foreign.json()) as any).error).toBe("invalid_request");
    expect(await listGrants(stranger.session)).toEqual([]);
    expect(await listGrants(owner.session)).toEqual([]);
  });
});
