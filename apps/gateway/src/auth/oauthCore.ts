import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { sign, verify } from "hono/jwt";
import { env } from "@aiverse/shared/env";
import { hashAgentToken } from "./agentToken";

// OAuth 2.1 core for MCP client delegation (MCP + OAuth plan, Phase 1).
// Pure by design: no db/redis imports, so every security-critical primitive
// here (PKCE, code/refresh-token hashing, access-token sign/verify) is
// unit-testable in isolation; routes/oauth.ts owns all persistence.
//
// The model: an owner delegates a slice of their authority to a registered
// client for specific agents. The client never sees a password or an agent
// key — it holds a 1 h access JWT (audience-bound to the agent MCP
// resource, so it is worthless at the plain REST API) plus a rotating
// refresh token whose SHA-256 hash is all that is stored.

export const OAUTH_SCOPES = [
  "world:observe",
  "world:act",
  "inbox:read",
  "relay:send",
  "discover",
] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
// Consent-parked authorization requests and the codes minted from them are
// deliberately short-lived: a request no owner acts on dies in 10 minutes,
// a code no client redeems dies in 60 seconds.
export const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;
export const AUTH_CODE_TTL_MS = 60 * 1000;
export const DEFAULT_GRANT_DAYS = 30;
export const MAX_GRANT_DAYS = 365;

/** The authorization server's own URL (also the access tokens' `iss`). */
export function oauthIssuer(): string {
  return env.PUBLIC_BASE_URL.replace(/\/+$/, "");
}

/** The protected resource the access tokens are minted for (their `aud`). */
export function oauthResource(): string {
  return `${oauthIssuer()}/mcp/agent`;
}

// ---------------------------------------------------------------------------
// PKCE (RFC 7636) — S256 only. Plain is never accepted anywhere: the
// authorize route rejects a missing code_challenge_method, and this
// verifier only ever computes the S256 transform.

export function computeS256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

const VERIFIER_SHAPE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function verifyPkceS256(verifier: unknown, challenge: unknown): boolean {
  if (typeof verifier !== "string" || !VERIFIER_SHAPE.test(verifier)) return false;
  if (typeof challenge !== "string" || challenge.length === 0) return false;
  const computed = Buffer.from(computeS256Challenge(verifier), "utf8");
  const expected = Buffer.from(challenge, "utf8");
  if (computed.length !== expected.length) return false;
  return timingSafeEqual(computed, expected);
}

// ---------------------------------------------------------------------------
// Authorization codes and refresh tokens: 256-bit random values handed to
// the client once; only the SHA-256 hash is ever persisted (the
// hashAgentToken pattern), so a database read yields nothing redeemable.

export function generateAuthorizationCode(): { code: string; hash: string } {
  const code = randomBytes(32).toString("base64url");
  return { code, hash: hashAuthorizationCode(code) };
}

export function hashAuthorizationCode(code: string): string {
  return hashAgentToken(code);
}

export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return hashAgentToken(token);
}

export function generateRefreshFamilyId(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Access tokens: HS256 JWTs on the existing JWT_SECRET infra (same signing
// path as owner sessions, auth/session.ts), with the claims that bind them
// to this delegation — sub (owner), aud (the MCP resource only), scope,
// and the granted agent id list. Verification re-checks iss/aud by hand:
// hono/jwt's verify covers signature + exp, not audience binding.

export interface OAuthAccessClaims {
  ownerId: string;
  scope: string;
  agents: string[];
}

export function signAccessToken(claims: OAuthAccessClaims): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      sub: claims.ownerId,
      iss: oauthIssuer(),
      aud: oauthResource(),
      scope: claims.scope,
      agents: claims.agents,
      iat: now,
      exp: now + ACCESS_TOKEN_TTL_SECONDS,
    },
    env.JWT_SECRET,
  );
}

export async function verifyAccessToken(token: string): Promise<OAuthAccessClaims> {
  const payload = await verify(token, env.JWT_SECRET, "HS256");
  if (payload.iss !== oauthIssuer()) throw new Error("access token: wrong issuer");
  if (payload.aud !== oauthResource()) throw new Error("access token: wrong audience");
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("access token: missing subject");
  }
  if (typeof payload.scope !== "string") throw new Error("access token: missing scope");
  if (
    !Array.isArray(payload.agents) ||
    payload.agents.some((a) => typeof a !== "string")
  ) {
    throw new Error("access token: malformed agents claim");
  }
  return {
    ownerId: payload.sub,
    scope: payload.scope,
    agents: payload.agents as string[],
  };
}

// ---------------------------------------------------------------------------
// Scope strings: space-delimited per RFC 6749 §3.3. parseScope returns null
// on ANY scope outside the supported set — the caller turns that into an
// invalid_scope error; nothing is silently dropped or widened.

export function parseScope(scope: string | null | undefined): string[] | null {
  if (scope === null || scope === undefined || scope.trim() === "") return [];
  const parts = [...new Set(scope.split(/\s+/).filter(Boolean))];
  const supported: readonly string[] = OAUTH_SCOPES;
  return parts.every((s) => supported.includes(s)) ? parts : null;
}

export function isScopeSubset(subset: readonly string[], superset: readonly string[]): boolean {
  const allowed = new Set(superset);
  return subset.every((s) => allowed.has(s));
}

// ---------------------------------------------------------------------------
// Redirect URI policy for dynamic client registration: https anywhere, or
// http only for loopback (native/CLI MCP clients run their callback on
// localhost — RFC 8252 §7.3). Anything else is refused at registration, and
// the authorize endpoint additionally requires an exact string match
// against the registered list.

export function isAllowedRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}
