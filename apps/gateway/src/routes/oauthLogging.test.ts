import { describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { oauthCodes } from "@aiverse/shared/schema";
import { createApp } from "../app";
import { db } from "../db/client";
import { computeS256Challenge, hashAuthorizationCode } from "../auth/oauthCore";

// Production observability for the MCP + OAuth login lifecycle: every
// step — and every FAILURE — must land in the gateway's structured log
// (util/log → JSON lines on console.log/console.error) with ids and
// reason codes, and NEVER with credential material. These tests capture
// the console the way the logger emits it and assert on the lines:
// the events a production operator would grep for after a client
// reports "I can't connect", plus the negative assertion that no code
// or token value ever appears in a captured line.

const app = createApp();

const LOOPBACK_REDIRECT = "http://localhost:53111/oauth-callback";

function json(token?: string) {
  return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

interface CapturedLogs {
  events: (name: string) => any[];
  rawText: () => string;
  restore: () => void;
}

function captureLogs(): CapturedLogs {
  const parsed: any[] = [];
  const raw: string[] = [];
  const sink = (...args: any[]) => {
    const line = String(args[0]);
    raw.push(line);
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // Not a log line (some other console user) — kept in raw only.
    }
  };
  const logSpy = spyOn(console, "log").mockImplementation(sink);
  const errSpy = spyOn(console, "error").mockImplementation(sink);
  return {
    events: (name) => parsed.filter((l) => l && l.event === name),
    rawText: () => raw.join("\n"),
    restore: () => {
      logSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

async function ownerWithAgent(name: string) {
  const email = `oauthlog-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", {
    method: "POST",
    headers: json(),
    body: JSON.stringify({ email, password: "password123" }),
  });
  expect(reg.status).toBe(201);
  const { token: session } = (await reg.json()) as any;
  const created = await app.request("/owners/agents", {
    method: "POST",
    headers: json(session),
    body: JSON.stringify({ name: `${name}-${Math.random().toString(36).slice(2, 8)}`, capabilities: [] }),
  });
  expect(created.status).toBe(201);
  const { agent } = (await created.json()) as any;
  return { session: session as string, agentId: agent.id as string };
}

async function registerClient() {
  const res = await app.request("/oauth/register", {
    method: "POST",
    headers: json(),
    body: JSON.stringify({ client_name: "logging test client", redirect_uris: [LOOPBACK_REDIRECT] }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as any).client_id as string;
}

async function authorize(clientId: string, scope?: string) {
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
  const res = await app.request(`/oauth/authorize?${q}`);
  expect(res.status).toBe(302);
  const requestId = new URL(res.headers.get("location")!).searchParams.get("request_id")!;
  return { requestId, verifier };
}

async function decide(session: string, requestId: string, body: Record<string, unknown>) {
  return app.request("/oauth/authorize/decision", {
    method: "POST",
    headers: json(session),
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

/** Approve a flow and hand back everything the exchange needs. */
async function approveFlow(owner: { session: string; agentId: string }, scope?: string) {
  const clientId = await registerClient();
  const { requestId, verifier } = await authorize(clientId, scope);
  const res = await decide(owner.session, requestId, { approve: true, agent_ids: [owner.agentId] });
  expect(res.status).toBe(200);
  const { redirect } = (await res.json()) as any;
  const code = new URL(redirect).searchParams.get("code")!;
  return { clientId, requestId, code, verifier };
}

async function mint(owner: { session: string; agentId: string }, scope?: string) {
  const flow = await approveFlow(owner, scope);
  const exchanged = await tokenRequest({
    grant_type: "authorization_code",
    client_id: flow.clientId,
    code: flow.code,
    redirect_uri: LOOPBACK_REDIRECT,
    code_verifier: flow.verifier,
  });
  expect(exchanged.status).toBe(200);
  return {
    ...flow,
    accessToken: exchanged.body.access_token as string,
    refreshToken: exchanged.body.refresh_token as string,
  };
}

async function theGrantId(session: string) {
  const res = await app.request("/oauth/grants", { headers: json(session) });
  expect(res.status).toBe(200);
  const { grants } = (await res.json()) as any;
  expect(grants.length).toBe(1);
  return grants[0].id as string;
}

let rpcId = 0;
async function mcpAgent(token: string | undefined, method: string, params: Record<string, unknown> = {}) {
  const res = await app.request("/mcp/agent", {
    method: "POST",
    headers: { ...json(token), accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return { status: res.status, body: res.status === 200 ? ((await res.json()) as any) : null };
}

describe("login lifecycle logging", () => {
  test("authorize logs request creation; a denied decision logs its outcome", async () => {
    const owner = await ownerWithAgent("LogDenyAgent");
    const cap = captureLogs();
    try {
      const clientId = await registerClient();
      const { requestId } = await authorize(clientId);
      const created = cap.events("oauth_authorize_request_created");
      expect(created.length).toBe(1);
      expect(created[0].requestId).toBe(requestId);
      expect(created[0].clientId).toBe(clientId);

      const denied = await decide(owner.session, requestId, { approve: false });
      expect(denied.status).toBe(200);
      const decisions = cap.events("oauth_authorize_decision");
      expect(decisions.length).toBe(1);
      expect(decisions[0].outcome).toBe("denied");
      expect(decisions[0].requestId).toBe(requestId);
      expect(decisions[0].ownerId).toBeTruthy();
    } finally {
      cap.restore();
    }
  });

  test("an expired code exchange logs oauth_token_exchange_failed with reason code_expired", async () => {
    const owner = await ownerWithAgent("LogExpiredAgent");
    const flow = await approveFlow(owner);
    await db
      .update(oauthCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthCodes.codeHash, hashAuthorizationCode(flow.code)));
    const cap = captureLogs();
    try {
      const res = await tokenRequest({
        grant_type: "authorization_code",
        client_id: flow.clientId,
        code: flow.code,
        redirect_uri: LOOPBACK_REDIRECT,
        code_verifier: flow.verifier,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_grant");
      const failed = cap.events("oauth_token_exchange_failed");
      expect(failed.length).toBe(1);
      expect(failed[0].reason).toBe("code_expired");
      expect(failed[0].clientId).toBe(flow.clientId);
      // The code itself must never reach a log line.
      expect(cap.rawText()).not.toContain(flow.code);
      expect(cap.rawText()).not.toContain(flow.verifier);
    } finally {
      cap.restore();
    }
  });

  test("a refresh replay logs the family-revoke event loudly — and no token material anywhere", async () => {
    const owner = await ownerWithAgent("LogReplayAgent");
    const minted = await mint(owner);
    const grantId = await theGrantId(owner.session);

    const capOk = captureLogs();
    let rotated: string;
    try {
      const first = await tokenRequest({
        grant_type: "refresh_token",
        client_id: minted.clientId,
        refresh_token: minted.refreshToken,
      });
      expect(first.status).toBe(200);
      rotated = first.body.refresh_token as string;
      const refreshed = capOk.events("oauth_token_refresh");
      expect(refreshed.length).toBe(1);
      expect(refreshed[0].grantId).toBe(grantId);
    } finally {
      capOk.restore();
    }

    const cap = captureLogs();
    try {
      const replay = await tokenRequest({
        grant_type: "refresh_token",
        client_id: minted.clientId,
        refresh_token: minted.refreshToken, // the burned one, presented again
      });
      expect(replay.status).toBe(400);
      expect(replay.body.error).toBe("invalid_grant");
      const events = cap.events("oauth_refresh_replay_family_revoked");
      expect(events.length).toBe(1);
      expect(events[0].grantId).toBe(grantId);
      expect(events[0].detectedBy).toBe("presented_used_token");
      // Neither the burned token, its replacement, the code, nor the
      // access token may appear in ANY captured line.
      const text = cap.rawText();
      expect(text).not.toContain(minted.refreshToken);
      expect(text).not.toContain(rotated!);
      expect(text).not.toContain(minted.code);
      expect(text).not.toContain(minted.accessToken);
    } finally {
      cap.restore();
    }
  });

  test("a revoked grant resolving at /mcp/agent logs the resolver reason at both levels", async () => {
    const owner = await ownerWithAgent("LogRevokedAgent");
    const minted = await mint(owner);
    const grantId = await theGrantId(owner.session);

    const cap = captureLogs();
    try {
      const revoke = await app.request(`/oauth/grants/${grantId}/revoke`, {
        method: "POST",
        headers: json(owner.session),
        body: JSON.stringify({}),
      });
      expect(revoke.status).toBe(200);
      const revoked = cap.events("oauth_grant_revoked");
      expect(revoked.length).toBe(1);
      expect(revoked[0].grantId).toBe(grantId);
      expect(revoked[0].source).toBe("owner");

      const res = await mcpAgent(minted.accessToken, "tools/list");
      expect(res.status).toBe(401);
      const authFailed = cap.events("agent_auth_failed");
      expect(authFailed.some((e) => e.reason === "grant_revoked")).toBe(true);
      const unauthorized = cap.events("mcp_agent_unauthorized");
      expect(unauthorized.length).toBe(1);
      expect(unauthorized[0].reason).toBe("grant_revoked");
      expect(cap.rawText()).not.toContain(minted.accessToken);
    } finally {
      cap.restore();
    }
  });

  test("a scope denial logs the tool, the missing scope and the grant", async () => {
    const owner = await ownerWithAgent("LogScopeAgent");
    const minted = await mint(owner, "inbox:read");
    const grantId = await theGrantId(owner.session);

    const cap = captureLogs();
    try {
      const res = await mcpAgent(minted.accessToken, "tools/call", {
        name: "world_observe",
        arguments: {},
      });
      expect(res.status).toBe(200);
      expect(res.body.result.isError).toBe(true);
      expect(res.body.result.content[0].text).toContain("insufficient_scope");
      const denied = cap.events("mcp_agent_scope_denied");
      expect(denied.length).toBe(1);
      expect(denied[0].tool).toBe("world_observe");
      expect(denied[0].missingScope).toBe("world:observe");
      expect(denied[0].grantedScopes).toEqual(["inbox:read"]);
      expect(denied[0].grantId).toBe(grantId);
    } finally {
      cap.restore();
    }
  });
});
