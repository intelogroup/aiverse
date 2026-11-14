import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { oauthAuthRequests, oauthGrants } from "@aiverse/shared/schema";
import { createApp } from "../app";
import { db } from "../db/client";
import { computeS256Challenge } from "../auth/oauthCore";

// Route-level tests for the OAuth 2.1 authorization server (Phase 1).
// Like the other gateway suites these need live Postgres + Redis (the test
// DB from apps/gateway/.env.test); they exercise the full delegation flow
// exactly as an MCP client + the console consent page would drive it.

const app = createApp();

const LOOPBACK_REDIRECT = "http://localhost:53111/oauth-callback";

function jsonHeaders(token?: string) {
  return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

async function ownerWithAgent(name: string) {
  const email = `oauth-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ email, password: "password123" }),
  });
  expect(reg.status).toBe(201);
  const { token: session } = (await reg.json()) as any;
  // Agent names are globally unique — suffix so re-runs against a non-fresh
  // test DB don't 409 on the previous run's rows.
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

async function registerClient(redirectUris: string[] = [LOOPBACK_REDIRECT]) {
  const res = await app.request("/oauth/register", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ client_name: "test mcp client", redirect_uris: redirectUris }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  return body.client_id as string;
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: computeS256Challenge(verifier) };
}

/** Drives GET /oauth/authorize and returns the parked request id. */
async function authorize(clientId: string, opts: { scope?: string } = {}) {
  const { challenge } = pkceFor(clientId);
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: LOOPBACK_REDIRECT,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-123",
    ...(opts.scope ? { scope: opts.scope } : {}),
  });
  const res = await app.request(`/oauth/authorize?${q}`);
  expect(res.status).toBe(302);
  const location = res.headers.get("location")!;
  const requestId = new URL(location).searchParams.get("request_id");
  expect(requestId).toBeTruthy();
  return requestId!;
}

// The verifier for a given authorize call must be the one the test later
// presents at the token endpoint, so keep pairs per client flow.
const pkcePairs = new Map<string, { verifier: string; challenge: string }>();
function pkceFor(clientId: string) {
  let pair = pkcePairs.get(clientId);
  if (!pair) {
    pair = pkce();
    pkcePairs.set(clientId, pair);
  }
  return pair;
}

async function decide(session: string, requestId: string, body: Record<string, unknown>) {
  return app.request("/oauth/authorize/decision", {
    method: "POST",
    headers: jsonHeaders(session),
    body: JSON.stringify({ request_id: requestId, ...body }),
  });
}

async function tokenRequest(params: Record<string, string>) {
  const res = await app.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

/** Full happy path: register → authorize → approve → code. Returns the code + verifier. */
async function approveFlow(owner: { session: string; agentId: string }) {
  const clientId = await registerClient();
  const requestId = await authorize(clientId);
  const res = await decide(owner.session, requestId, { approve: true, agent_ids: [owner.agentId] });
  expect(res.status).toBe(200);
  const { redirect } = (await res.json()) as any;
  const url = new URL(redirect);
  expect(url.searchParams.get("state")).toBe("state-123");
  const code = url.searchParams.get("code");
  expect(code).toBeTruthy();
  return { clientId, code: code!, verifier: pkceFor(clientId).verifier };
}

describe("OAuth discovery metadata", () => {
  test("authorization-server metadata names the endpoints and S256 only", async () => {
    const res = await app.request("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const meta = (await res.json()) as any;
    expect(meta.issuer).toBeTruthy();
    expect(meta.authorization_endpoint).toEndWith("/oauth/authorize");
    expect(meta.token_endpoint).toEndWith("/oauth/token");
    expect(meta.registration_endpoint).toEndWith("/oauth/register");
    expect(meta.revocation_endpoint).toEndWith("/oauth/revoke");
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.response_types_supported).toEqual(["code"]);
    expect(meta.scopes_supported).toContain("world:act");
  });

  test("protected-resource metadata points at the issuer and the agent MCP resource", async () => {
    const res = await app.request("/.well-known/oauth-protected-resource");
    expect(res.status).toBe(200);
    const meta = (await res.json()) as any;
    expect(meta.resource).toEndWith("/mcp/agent");
    expect(meta.authorization_servers).toHaveLength(1);
    expect(meta.authorization_servers[0]).toBe(meta.resource.replace(/\/mcp\/agent$/, ""));
  });
});

describe("dynamic client registration", () => {
  test("registers a public client with loopback redirects", async () => {
    const res = await app.request("/oauth/register", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ client_name: "cli client", redirect_uris: [LOOPBACK_REDIRECT] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.client_id).toBeTruthy();
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.client_secret).toBeUndefined();
  });

  test("refuses http redirects off loopback and missing names", async () => {
    const bad = await app.request("/oauth/register", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ client_name: "bad", redirect_uris: ["http://evil.example.com/cb"] }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toBe("invalid_redirect_uri");

    const noName = await app.request("/oauth/register", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ redirect_uris: [LOOPBACK_REDIRECT] }),
    });
    expect(noName.status).toBe(400);
    expect(((await noName.json()) as any).error).toBe("invalid_client_metadata");
  });
});

describe("authorize validation", () => {
  test("unknown client and unregistered redirect_uri are refused without redirecting", async () => {
    const unknown = await app.request(
      `/oauth/authorize?client_id=00000000-0000-0000-0000-000000000000&redirect_uri=${encodeURIComponent(LOOPBACK_REDIRECT)}&response_type=code&code_challenge=x&code_challenge_method=S256`,
    );
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get("location")).toBeNull();
    expect(((await unknown.json()) as any).error).toBe("invalid_client");

    const clientId = await registerClient();
    const mismatch = await app.request(
      `/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent("http://localhost:9999/other")}&response_type=code&code_challenge=x&code_challenge_method=S256`,
    );
    expect(mismatch.status).toBe(400);
    expect(mismatch.headers.get("location")).toBeNull();
  });

  test("plain PKCE, wrong response_type, and out-of-set scope redirect back with errors", async () => {
    const clientId = await registerClient();
    const base = {
      client_id: clientId,
      redirect_uri: LOOPBACK_REDIRECT,
      state: "s1",
    };
    const plain = await app.request(
      `/oauth/authorize?${new URLSearchParams({ ...base, response_type: "code", code_challenge: "abc", code_challenge_method: "plain" })}`,
    );
    expect(plain.status).toBe(302);
    expect(new URL(plain.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");

    const implicit = await app.request(
      `/oauth/authorize?${new URLSearchParams({ ...base, response_type: "token", code_challenge: "abc", code_challenge_method: "S256" })}`,
    );
    expect(new URL(implicit.headers.get("location")!).searchParams.get("error")).toBe("unsupported_response_type");

    const badScope = await app.request(
      `/oauth/authorize?${new URLSearchParams({ ...base, response_type: "code", code_challenge: "abc", code_challenge_method: "S256", scope: "world:observe admin:all" })}`,
    );
    expect(new URL(badScope.headers.get("location")!).searchParams.get("error")).toBe("invalid_scope");
  });

  test("a valid request parks and redirects to the console consent page", async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: LOOPBACK_REDIRECT,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const res = await app.request(`/oauth/authorize?${q}`);
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location).toContain("/oauth/consent?request_id=");
  });
});

describe("consent decision", () => {
  test("deny redirects the client with access_denied and consumes the request", async () => {
    const owner = await ownerWithAgent("DenyAgent");
    const clientId = await registerClient();
    const requestId = await authorize(clientId);
    const res = await decide(owner.session, requestId, { approve: false });
    expect(res.status).toBe(200);
    const { redirect } = (await res.json()) as any;
    const url = new URL(redirect);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("state-123");

    const again = await decide(owner.session, requestId, { approve: false });
    expect(again.status).toBe(400);
  });

  test("approving an agent the owner does not own fails closed", async () => {
    const owner = await ownerWithAgent("OwnerA");
    const stranger = await ownerWithAgent("OwnerB");
    const clientId = await registerClient();
    const requestId = await authorize(clientId);
    const res = await decide(owner.session, requestId, { approve: true, agent_ids: [stranger.agentId] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("invalid_request");
  });

  test("decision requires an owner session", async () => {
    const clientId = await registerClient();
    const requestId = await authorize(clientId);
    const res = await app.request("/oauth/authorize/decision", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ request_id: requestId, approve: false }),
    });
    expect(res.status).toBe(401);
  });

  test("scopes may narrow but never widen past the request", async () => {
    const owner = await ownerWithAgent("ScopeAgent");
    const clientId = await registerClient();
    const requestId = await authorize(clientId, { scope: "world:observe" });
    const widen = await decide(owner.session, requestId, {
      approve: true,
      agent_ids: [owner.agentId],
      scopes: ["world:observe", "relay:send"],
    });
    expect(widen.status).toBe(400);
    expect(((await widen.json()) as any).error).toBe("invalid_scope");
  });
});

describe("token endpoint", () => {
  test("code exchange issues an access JWT + refresh token; refresh rotates", async () => {
    const owner = await ownerWithAgent("FlowAgent");
    const { clientId, code, verifier } = await approveFlow(owner);

    const exchanged = await tokenRequest({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: LOOPBACK_REDIRECT,
      code_verifier: verifier,
    });
    expect(exchanged.status).toBe(200);
    expect(exchanged.body.token_type).toBe("Bearer");
    expect(exchanged.body.expires_in).toBe(3600);
    expect(exchanged.body.access_token).toBeTruthy();
    expect(exchanged.body.refresh_token).toBeTruthy();
    const payload = JSON.parse(Buffer.from(exchanged.body.access_token.split(".")[1], "base64url").toString("utf8"));
    expect(payload.sub).toBeTruthy();
    expect(payload.aud).toEndWith("/mcp/agent");
    expect(payload.agents).toEqual([owner.agentId]);

    const rotated = await tokenRequest({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: exchanged.body.refresh_token,
    });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refresh_token).toBeTruthy();
    expect(rotated.body.refresh_token).not.toBe(exchanged.body.refresh_token);
  });

  test("wrong verifier, wrong client, and code reuse are all invalid_grant", async () => {
    const owner = await ownerWithAgent("StrictAgent");
    const { clientId, code, verifier } = await approveFlow(owner);

    const wrongVerifier = await tokenRequest({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: LOOPBACK_REDIRECT,
      code_verifier: "wrong-verifier-that-is-long-enough-for-the-shape-check",
    });
    expect(wrongVerifier.status).toBe(400);
    expect(wrongVerifier.body.error).toBe("invalid_grant");

    const wrongClient = await tokenRequest({
      grant_type: "authorization_code",
      client_id: "00000000-0000-0000-0000-000000000000",
      code,
      redirect_uri: LOOPBACK_REDIRECT,
      code_verifier: verifier,
    });
    expect(wrongClient.status).toBe(400);
    expect(wrongClient.body.error).toBe("invalid_grant");

    const ok = await tokenRequest({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: LOOPBACK_REDIRECT,
      code_verifier: verifier,
    });
    expect(ok.status).toBe(200);
    const reuse = await tokenRequest({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: LOOPBACK_REDIRECT,
      code_verifier: verifier,
    });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe("invalid_grant");
  });

  test("replaying a rotated-out refresh token revokes the whole grant", async () => {
    const owner = await ownerWithAgent("ReplayAgent");
    const { clientId, code, verifier } = await approveFlow(owner);
    const exchanged = await tokenRequest({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: LOOPBACK_REDIRECT,
      code_verifier: verifier,
    });
    const firstRefresh = exchanged.body.refresh_token as string;
    const rotated = await tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: firstRefresh });
    expect(rotated.status).toBe(200);
    const newestRefresh = rotated.body.refresh_token as string;

    const replay = await tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: firstRefresh });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");

    // The grant is dead: even the newest token in the family is refused.
    const after = await tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: newestRefresh });
    expect(after.status).toBe(400);
    expect(after.body.error).toBe("invalid_grant");
  });

  test("unsupported grant types are refused", async () => {
    const res = await tokenRequest({ grant_type: "password", client_id: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unsupported_grant_type");
  });
});

describe("consent page data + grant management (Phase 2)", () => {
  async function getRequest(session: string, requestId: string) {
    const res = await app.request(`/oauth/authorize/request/${requestId}`, {
      headers: jsonHeaders(session),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  }

  async function listGrants(session: string) {
    const res = await app.request("/oauth/grants", { headers: jsonHeaders(session) });
    expect(res.status).toBe(200);
    return ((await res.json()) as any).grants as any[];
  }

  test("request endpoint renders a pending request for the consent page", async () => {
    const owner = await ownerWithAgent("ConsentRenderAgent");
    const clientId = await registerClient();
    const requestId = await authorize(clientId, { scope: "world:observe inbox:read" });
    const { status, body } = await getRequest(owner.session, requestId);
    expect(status).toBe(200);
    expect(body.client_name).toBe("test mcp client");
    expect(body.client_id).toBe(clientId);
    expect(body.redirect_host).toBe("localhost:53111");
    expect(body.scopes).toEqual(["world:observe", "inbox:read"]);
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  test("request endpoint requires an owner session", async () => {
    const clientId = await registerClient();
    const requestId = await authorize(clientId);
    const res = await app.request(`/oauth/authorize/request/${requestId}`);
    expect(res.status).toBe(401);
  });

  test("request endpoint 404s unknown, consumed, and expired requests alike", async () => {
    const owner = await ownerWithAgent("Consent404Agent");

    const unknown = await getRequest(owner.session, "00000000-0000-0000-0000-000000000000");
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: "not_found" });

    const clientId = await registerClient();
    const consumedId = await authorize(clientId);
    const deny = await decide(owner.session, consumedId, { approve: false });
    expect(deny.status).toBe(200);
    const consumed = await getRequest(owner.session, consumedId);
    expect(consumed.status).toBe(404);
    expect(consumed.body).toEqual({ error: "not_found" });

    const expiredId = await authorize(clientId);
    await db
      .update(oauthAuthRequests)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthAuthRequests.id, expiredId));
    const expired = await getRequest(owner.session, expiredId);
    expect(expired.status).toBe(404);
    expect(expired.body).toEqual({ error: "not_found" });
  });

  test("grants list starts empty, then shows the approved grant with names, newest first", async () => {
    const owner = await ownerWithAgent("GrantListAgent");
    expect(await listGrants(owner.session)).toEqual([]);

    const first = await approveFlow(owner);
    // Backdate the first grant so newest-first ordering is deterministic.
    const afterFirst = await listGrants(owner.session);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].client_id).toBe(first.clientId);
    expect(afterFirst[0].client_name).toBe("test mcp client");
    expect(afterFirst[0].agent_ids).toEqual([owner.agentId]);
    expect(afterFirst[0].agent_names[owner.agentId]).toContain("GrantListAgent");
    expect(afterFirst[0].scopes).toContain("world:act");
    expect(afterFirst[0].revoked_at).toBeNull();
    expect(new Date(afterFirst[0].expires_at).getTime()).toBeGreaterThan(Date.now());
    await db
      .update(oauthGrants)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(oauthGrants.id, afterFirst[0].id));

    await approveFlow(owner);
    const both = await listGrants(owner.session);
    expect(both).toHaveLength(2);
    expect(both[0].id).not.toBe(afterFirst[0].id);
    expect(both[1].id).toBe(afterFirst[0].id);
  });

  test("grants list never shows another owner's grants", async () => {
    const owner = await ownerWithAgent("GrantOwnerA");
    const stranger = await ownerWithAgent("GrantOwnerB");
    await approveFlow(owner);
    expect(await listGrants(owner.session)).toHaveLength(1);
    expect(await listGrants(stranger.session)).toEqual([]);
    const unauthed = await app.request("/oauth/grants");
    expect(unauthed.status).toBe(401);
  });

  test("revoking an own grant kills its refresh tokens and is idempotent", async () => {
    const owner = await ownerWithAgent("GrantRevokeAgent");
    const { clientId, code, verifier } = await approveFlow(owner);
    const exchanged = await tokenRequest({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: LOOPBACK_REDIRECT,
      code_verifier: verifier,
    });
    expect(exchanged.status).toBe(200);
    const grants = await listGrants(owner.session);
    const grantId = grants[0].id as string;

    const revoke = await app.request(`/oauth/grants/${grantId}/revoke`, {
      method: "POST",
      headers: jsonHeaders(owner.session),
    });
    expect(revoke.status).toBe(200);
    expect(((await revoke.json()) as any).ok).toBe(true);

    const after = await listGrants(owner.session);
    expect(after[0].revoked_at).toBeTruthy();

    const dead = await tokenRequest({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: exchanged.body.refresh_token,
    });
    expect(dead.status).toBe(400);
    expect(dead.body.error).toBe("invalid_grant");

    const again = await app.request(`/oauth/grants/${grantId}/revoke`, {
      method: "POST",
      headers: jsonHeaders(owner.session),
    });
    expect(again.status).toBe(200);
  });

  test("revoking a foreign or unknown grant is a 404 and changes nothing", async () => {
    const owner = await ownerWithAgent("GrantForeignA");
    const stranger = await ownerWithAgent("GrantForeignB");
    const { clientId, code, verifier } = await approveFlow(owner);
    const exchanged = await tokenRequest({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: LOOPBACK_REDIRECT,
      code_verifier: verifier,
    });
    expect(exchanged.status).toBe(200);
    const grantId = (await listGrants(owner.session))[0].id as string;

    const foreign = await app.request(`/oauth/grants/${grantId}/revoke`, {
      method: "POST",
      headers: jsonHeaders(stranger.session),
    });
    expect(foreign.status).toBe(404);
    expect(((await foreign.json()) as any).error).toBe("not_found");

    const unknown = await app.request(`/oauth/grants/00000000-0000-0000-0000-000000000000/revoke`, {
      method: "POST",
      headers: jsonHeaders(owner.session),
    });
    expect(unknown.status).toBe(404);

    const unauthed = await app.request(`/oauth/grants/${grantId}/revoke`, { method: "POST" });
    expect(unauthed.status).toBe(401);

    // The grant survived: still unrevoked in the owner's list, and its
    // refresh token still rotates.
    const mine = await listGrants(owner.session);
    expect(mine[0].revoked_at).toBeNull();
    const alive = await tokenRequest({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: exchanged.body.refresh_token,
    });
    expect(alive.status).toBe(200);
  });
});

describe("revocation", () => {
  test("revoking a refresh token kills its grant; unknown tokens still get 200", async () => {
    const owner = await ownerWithAgent("RevokeAgent");
    const { clientId, code, verifier } = await approveFlow(owner);
    const exchanged = await tokenRequest({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: LOOPBACK_REDIRECT,
      code_verifier: verifier,
    });
    const refresh = exchanged.body.refresh_token as string;

    const revoke = await app.request("/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refresh, client_id: clientId }).toString(),
    });
    expect(revoke.status).toBe(200);

    const after = await tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: refresh });
    expect(after.status).toBe(400);
    expect(after.body.error).toBe("invalid_grant");

    const garbage = await app.request("/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "not-a-real-token" }).toString(),
    });
    expect(garbage.status).toBe(200);
  });

  test("a mismatched client_id revokes nothing", async () => {
    const owner = await ownerWithAgent("RevokeGuardAgent");
    const { clientId, code, verifier } = await approveFlow(owner);
    const exchanged = await tokenRequest({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: LOOPBACK_REDIRECT,
      code_verifier: verifier,
    });
    const refresh = exchanged.body.refresh_token as string;
    const foreign = await registerClient();
    const revoke = await app.request("/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refresh, client_id: foreign }).toString(),
    });
    expect(revoke.status).toBe(200);
    const stillAlive = await tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: refresh });
    expect(stillAlive.status).toBe(200);
  });
});
