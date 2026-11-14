import { Hono, type Context } from "hono";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client";
import {
  agents,
  oauthAuthRequests,
  oauthClients,
  oauthCodes,
  oauthGrants,
  oauthRefreshTokens,
} from "@aiverse/shared/schema";
import { env } from "@aiverse/shared/env";
import { ownerAuth } from "../middleware/ownerAuth";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTH_CODE_TTL_MS,
  AUTH_REQUEST_TTL_MS,
  DEFAULT_GRANT_DAYS,
  MAX_GRANT_DAYS,
  OAUTH_SCOPES,
  generateAuthorizationCode,
  generateRefreshFamilyId,
  generateRefreshToken,
  hashAuthorizationCode,
  hashRefreshToken,
  isAllowedRedirectUri,
  isScopeSubset,
  oauthIssuer,
  oauthResource,
  parseScope,
  signAccessToken,
  verifyPkceS256,
} from "../auth/oauthCore";

// OAuth 2.1 authorization server (MCP + OAuth plan, Phase 1): metadata,
// dynamic client registration, authorize (parked for the Phase 2 console
// consent page), the owner decision endpoint, token, and revocation.
// Every error on these endpoints is OAuth error JSON ({error,
// error_description}) — except authorize errors AFTER the redirect_uri has
// been validated against the client's registered list, which redirect back
// to the client per RFC 6749 §4.1.2.1. An unvalidated redirect_uri is
// never redirected to.
//
// Clients are public (no client_secret): PKCE S256 is the proof of
// possession, per OAuth 2.1. Codes are single-use and live 60 s; refresh
// tokens rotate on every use and replaying one revokes the whole family
// plus the grant.

export const oauthRoute = new Hono<{ Variables: { ownerId: string } }>();

const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function oauthError(c: Context, status: 400 | 401, error: string, description: string) {
  return c.json({ error, error_description: description }, status);
}

function redirectWithParams(redirectUri: string, params: Record<string, string | undefined>) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

/** Token/revoke endpoints take form-encoded bodies per RFC 6749; accept JSON too. */
async function readParams(c: Context): Promise<Record<string, string>> {
  const contentType = c.req.header("content-type") ?? "";
  const out: Record<string, string> = {};
  if (contentType.includes("application/json")) {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    for (const [k, v] of Object.entries(body ?? {})) if (typeof v === "string") out[k] = v;
    return out;
  }
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  for (const [k, v] of Object.entries(form)) if (typeof v === "string") out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------
// Discovery metadata.

oauthRoute.get("/.well-known/oauth-authorization-server", (c) =>
  c.json({
    issuer: oauthIssuer(),
    authorization_endpoint: `${oauthIssuer()}/oauth/authorize`,
    token_endpoint: `${oauthIssuer()}/oauth/token`,
    registration_endpoint: `${oauthIssuer()}/oauth/register`,
    revocation_endpoint: `${oauthIssuer()}/oauth/revoke`,
    scopes_supported: [...OAUTH_SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
  }),
);

oauthRoute.get("/.well-known/oauth-protected-resource", (c) =>
  c.json({
    resource: oauthResource(),
    authorization_servers: [oauthIssuer()],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
  }),
);

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591). Public clients: a client_id is
// issued, no secret — PKCE is the credential.

oauthRoute.post("/oauth/register", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    client_name?: unknown;
    redirect_uris?: unknown;
  } | null;
  if (!body || typeof body.client_name !== "string" || body.client_name.trim() === "") {
    return oauthError(c, 400, "invalid_client_metadata", "client_name is required");
  }
  if (
    !Array.isArray(body.redirect_uris) ||
    body.redirect_uris.length === 0 ||
    body.redirect_uris.some((u) => typeof u !== "string")
  ) {
    return oauthError(c, 400, "invalid_redirect_uri", "redirect_uris must be a non-empty array of URIs");
  }
  const redirectUris = body.redirect_uris as string[];
  const bad = redirectUris.find((u) => !isAllowedRedirectUri(u));
  if (bad) {
    return oauthError(
      c,
      400,
      "invalid_redirect_uri",
      `redirect_uri must be https (http allowed only for localhost): ${bad}`,
    );
  }
  const [client] = await db
    .insert(oauthClients)
    .values({ name: body.client_name.trim(), redirectUris })
    .returning();
  return c.json(
    {
      client_id: client.id,
      client_name: client.name,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    201,
  );
});

// ---------------------------------------------------------------------------
// Authorize: validate everything up front, park the request, and hand the
// owner to the console consent page (Phase 2 renders it; the decision comes
// back through POST /oauth/authorize/decision).

oauthRoute.get("/oauth/authorize", async (c) => {
  const clientId = c.req.query("client_id");
  const redirectUri = c.req.query("redirect_uri");
  const state = c.req.query("state");

  // Client and redirect_uri first: until both are validated, errors are
  // answered directly — redirecting to an unverified URI would make this
  // endpoint an open redirector.
  if (!clientId || !UUID_SHAPE.test(clientId)) {
    return oauthError(c, 400, "invalid_request", "client_id is required");
  }
  const client = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, clientId) });
  if (!client) {
    return oauthError(c, 400, "invalid_client", "unknown client_id");
  }
  const registered = (client.redirectUris as string[] | null) ?? [];
  if (!redirectUri || !registered.includes(redirectUri)) {
    return oauthError(c, 400, "invalid_request", "redirect_uri does not match a registered URI");
  }

  // From here the redirect_uri is trusted, so remaining errors ride back to
  // the client on it (RFC 6749 §4.1.2.1).
  const fail = (error: string, description: string) =>
    c.redirect(redirectWithParams(redirectUri, { error, error_description: description, state }));
  if (c.req.query("response_type") !== "code") {
    return fail("unsupported_response_type", "only response_type=code is supported");
  }
  const codeChallenge = c.req.query("code_challenge");
  if (!codeChallenge || c.req.query("code_challenge_method") !== "S256") {
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
  }
  const scopes = parseScope(c.req.query("scope"));
  if (scopes === null) {
    return fail("invalid_scope", `scope must be a subset of: ${OAUTH_SCOPES.join(" ")}`);
  }
  const effectiveScopes = scopes.length > 0 ? scopes : [...OAUTH_SCOPES];

  const [request] = await db
    .insert(oauthAuthRequests)
    .values({
      clientId,
      redirectUri,
      state: state ?? null,
      scope: effectiveScopes.join(" "),
      codeChallenge,
      expiresAt: new Date(Date.now() + AUTH_REQUEST_TTL_MS),
    })
    .returning();
  const consoleOrigin = env.CONSOLE_ORIGINS[0];
  return c.redirect(`${consoleOrigin}/oauth/consent?request_id=${request.id}`);
});

// ---------------------------------------------------------------------------
// The owner's consent decision (the Phase 2 console page posts here with
// the owner's session). Approve mints the grant + a 60 s authorization
// code; deny redirects the client with access_denied. Either way the auth
// request is consumed exactly once.

oauthRoute.post("/oauth/authorize/decision", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const body = (await c.req.json().catch(() => null)) as {
    request_id?: unknown;
    approve?: unknown;
    agent_ids?: unknown;
    scopes?: unknown;
    grant_days?: unknown;
  } | null;
  if (!body || typeof body.request_id !== "string" || !UUID_SHAPE.test(body.request_id)) {
    return oauthError(c, 400, "invalid_request", "request_id is required");
  }
  const request = await db.query.oauthAuthRequests.findFirst({
    where: eq(oauthAuthRequests.id, body.request_id),
  });
  if (!request || request.consumedAt || request.expiresAt.getTime() <= Date.now()) {
    return oauthError(c, 400, "invalid_request", "authorization request is unknown, decided, or expired");
  }
  const clientState = request.state ?? undefined;

  // Consume atomically before doing any work: a second decision on the
  // same request (double-click, replay) finds no row to consume and fails.
  const consume = async (): Promise<boolean> => {
    const consumed = await db
      .update(oauthAuthRequests)
      .set({ consumedAt: new Date() })
      .where(and(eq(oauthAuthRequests.id, request.id), isNull(oauthAuthRequests.consumedAt)))
      .returning({ id: oauthAuthRequests.id });
    return consumed.length === 1;
  };

  if (body.approve !== true) {
    if (!(await consume())) {
      return oauthError(c, 400, "invalid_request", "authorization request already decided");
    }
    return c.json({
      redirect: redirectWithParams(request.redirectUri, {
        error: "access_denied",
        error_description: "the owner denied this request",
        state: clientState,
      }),
    });
  }

  // Every granted agent must belong to the deciding owner — the same
  // fail-closed ownership check owner routes use for agent id lists.
  if (
    !Array.isArray(body.agent_ids) ||
    body.agent_ids.length === 0 ||
    body.agent_ids.some((id) => typeof id !== "string" || !UUID_SHAPE.test(id as string))
  ) {
    return oauthError(c, 400, "invalid_request", "agent_ids must be a non-empty list of agent ids");
  }
  const agentIds = [...new Set(body.agent_ids as string[])];
  const owned = await db.query.agents.findMany({
    where: and(inArray(agents.id, agentIds), eq(agents.ownerId, ownerId)),
    columns: { id: true },
  });
  if (owned.length !== agentIds.length) {
    return oauthError(c, 400, "invalid_request", "agent_ids contains an agent not owned by this owner");
  }

  const requestedScopes = parseScope(request.scope) ?? [];
  let grantScopes = requestedScopes;
  if (body.scopes !== undefined) {
    if (!Array.isArray(body.scopes) || body.scopes.some((s) => typeof s !== "string")) {
      return oauthError(c, 400, "invalid_scope", "scopes must be a list of scope strings");
    }
    grantScopes = [...new Set(body.scopes as string[])];
    if (!isScopeSubset(grantScopes, requestedScopes)) {
      return oauthError(c, 400, "invalid_scope", "scopes may only narrow the requested set");
    }
  }
  let grantDays = DEFAULT_GRANT_DAYS;
  if (body.grant_days !== undefined) {
    if (
      typeof body.grant_days !== "number" ||
      !Number.isFinite(body.grant_days) ||
      body.grant_days < 1 ||
      body.grant_days > MAX_GRANT_DAYS
    ) {
      return oauthError(c, 400, "invalid_request", `grant_days must be between 1 and ${MAX_GRANT_DAYS}`);
    }
    grantDays = Math.floor(body.grant_days);
  }

  if (!(await consume())) {
    return oauthError(c, 400, "invalid_request", "authorization request already decided");
  }
  const [grant] = await db
    .insert(oauthGrants)
    .values({
      ownerId,
      clientId: request.clientId,
      agentIds,
      scopes: grantScopes,
      expiresAt: new Date(Date.now() + grantDays * 24 * 60 * 60 * 1000),
    })
    .returning();
  const { code, hash } = generateAuthorizationCode();
  await db.insert(oauthCodes).values({
    codeHash: hash,
    grantId: grant.id,
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
  });
  return c.json({
    redirect: redirectWithParams(request.redirectUri, { code, state: clientState }),
  });
});

// ---------------------------------------------------------------------------
// Token endpoint: authorization_code exchange and refresh rotation.

type GrantRow = typeof oauthGrants.$inferSelect;

function grantLive(grant: GrantRow): boolean {
  return grant.revokedAt === null && grant.expiresAt.getTime() > Date.now();
}

async function issueTokens(c: Context, grant: GrantRow, familyId: string) {
  const refresh = generateRefreshToken();
  await db.insert(oauthRefreshTokens).values({
    tokenHash: refresh.hash,
    grantId: grant.id,
    familyId,
    // A refresh token never outlives its grant: when the delegation ends,
    // every way back in ends with it.
    expiresAt: grant.expiresAt,
  });
  const accessToken = await signAccessToken({
    ownerId: grant.ownerId,
    scope: ((grant.scopes as string[] | null) ?? []).join(" "),
    agents: (grant.agentIds as string[] | null) ?? [],
  });
  return c.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refresh.token,
    scope: ((grant.scopes as string[] | null) ?? []).join(" "),
  });
}

async function revokeFamilyAndGrant(familyId: string, grantId: string): Promise<void> {
  const now = new Date();
  await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(oauthRefreshTokens.familyId, familyId), isNull(oauthRefreshTokens.revokedAt)));
  await db
    .update(oauthGrants)
    .set({ revokedAt: now })
    .where(and(eq(oauthGrants.id, grantId), isNull(oauthGrants.revokedAt)));
}

oauthRoute.post("/oauth/token", async (c) => {
  const params = await readParams(c);
  const grantType = params.grant_type;
  if (grantType !== "authorization_code" && grantType !== "refresh_token") {
    return oauthError(c, 400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  }
  const clientId = params.client_id;
  if (!clientId || !UUID_SHAPE.test(clientId)) {
    return oauthError(c, 400, "invalid_request", "client_id is required");
  }

  if (grantType === "authorization_code") {
    const code = params.code;
    const redirectUri = params.redirect_uri;
    const verifier = params.code_verifier;
    if (!code || !redirectUri || !verifier) {
      return oauthError(c, 400, "invalid_request", "code, redirect_uri and code_verifier are required");
    }
    const codeRow = await db.query.oauthCodes.findFirst({
      where: eq(oauthCodes.codeHash, hashAuthorizationCode(code)),
    });
    if (!codeRow) return oauthError(c, 400, "invalid_grant", "unknown authorization code");
    if (codeRow.usedAt) return oauthError(c, 400, "invalid_grant", "authorization code already used");
    if (codeRow.expiresAt.getTime() <= Date.now()) {
      return oauthError(c, 400, "invalid_grant", "authorization code expired");
    }
    if (codeRow.clientId !== clientId) {
      return oauthError(c, 400, "invalid_grant", "client_id does not match the code");
    }
    if (codeRow.redirectUri !== redirectUri) {
      return oauthError(c, 400, "invalid_grant", "redirect_uri does not match the code");
    }
    if (!verifyPkceS256(verifier, codeRow.codeChallenge)) {
      return oauthError(c, 400, "invalid_grant", "PKCE verification failed");
    }
    const grant = await db.query.oauthGrants.findFirst({ where: eq(oauthGrants.id, codeRow.grantId) });
    if (!grant || !grantLive(grant)) {
      return oauthError(c, 400, "invalid_grant", "grant is revoked or expired");
    }
    // Burn the code atomically: a concurrent second redemption finds the
    // row already used and gets nothing.
    const burned = await db
      .update(oauthCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(oauthCodes.codeHash, codeRow.codeHash), isNull(oauthCodes.usedAt)))
      .returning({ codeHash: oauthCodes.codeHash });
    if (burned.length !== 1) {
      return oauthError(c, 400, "invalid_grant", "authorization code already used");
    }
    return issueTokens(c, grant, generateRefreshFamilyId());
  }

  // grant_type=refresh_token: rotate on every use. Presenting an
  // already-used (or revoked) token is reuse — the whole family and the
  // grant are revoked before answering (RFC 6819 §5.2.2.3).
  const presented = params.refresh_token;
  if (!presented) return oauthError(c, 400, "invalid_request", "refresh_token is required");
  const tokenRow = await db.query.oauthRefreshTokens.findFirst({
    where: eq(oauthRefreshTokens.tokenHash, hashRefreshToken(presented)),
  });
  if (!tokenRow) return oauthError(c, 400, "invalid_grant", "unknown refresh token");
  const grant = await db.query.oauthGrants.findFirst({ where: eq(oauthGrants.id, tokenRow.grantId) });
  if (!grant) return oauthError(c, 400, "invalid_grant", "grant not found");
  if (grant.clientId !== clientId) {
    return oauthError(c, 400, "invalid_grant", "client_id does not match the grant");
  }
  if (tokenRow.usedAt || tokenRow.revokedAt) {
    await revokeFamilyAndGrant(tokenRow.familyId, grant.id);
    return oauthError(c, 400, "invalid_grant", "refresh token reuse detected; grant revoked");
  }
  if (tokenRow.expiresAt.getTime() <= Date.now() || !grantLive(grant)) {
    return oauthError(c, 400, "invalid_grant", "grant is revoked or expired");
  }
  const rotated = await db
    .update(oauthRefreshTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(oauthRefreshTokens.tokenHash, tokenRow.tokenHash),
        isNull(oauthRefreshTokens.usedAt),
        isNull(oauthRefreshTokens.revokedAt),
      ),
    )
    .returning({ tokenHash: oauthRefreshTokens.tokenHash });
  if (rotated.length !== 1) {
    await revokeFamilyAndGrant(tokenRow.familyId, grant.id);
    return oauthError(c, 400, "invalid_grant", "refresh token reuse detected; grant revoked");
  }
  return issueTokens(c, grant, tokenRow.familyId);
});

// ---------------------------------------------------------------------------
// Revocation (RFC 7009): the presented refresh token's grant is revoked.
// Always 200 — an unknown, foreign, or garbage token is indistinguishable
// from success, so the endpoint never leaks which tokens exist. A
// client_id that does not match the token's grant revokes nothing.

oauthRoute.post("/oauth/revoke", async (c) => {
  const params = await readParams(c);
  const presented = params.token;
  if (presented) {
    const tokenRow = await db.query.oauthRefreshTokens.findFirst({
      where: eq(oauthRefreshTokens.tokenHash, hashRefreshToken(presented)),
    });
    if (tokenRow) {
      const grant = await db.query.oauthGrants.findFirst({ where: eq(oauthGrants.id, tokenRow.grantId) });
      if (grant && (!params.client_id || params.client_id === grant.clientId)) {
        const now = new Date();
        await db
          .update(oauthGrants)
          .set({ revokedAt: now })
          .where(and(eq(oauthGrants.id, grant.id), isNull(oauthGrants.revokedAt)));
        await db
          .update(oauthRefreshTokens)
          .set({ revokedAt: now })
          .where(and(eq(oauthRefreshTokens.grantId, grant.id), isNull(oauthRefreshTokens.revokedAt)));
      }
    }
  }
  return c.body(null, 200);
});
