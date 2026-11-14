import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { agents, oauthGrants } from "@aiverse/shared/schema";
import { hashAgentToken } from "./agentToken";
import { verifyAgentSession, keyFingerprint } from "./agentSession";
import { parseScope, verifyAccessToken, type OAuthAccessClaims } from "./oauthCore";
import { log } from "../util/log";

type GrantRow = typeof oauthGrants.$inferSelect;

/**
 * Why an OAuth access token did not resolve, in the vocabulary the
 * production logs speak (agent_auth_failed.reason). Every OAuth failure
 * path in this module lands on exactly one of these — a hiccup in the
 * login lifecycle is debuggable from the reason alone, no token material
 * is ever logged.
 */
export type OAuthFailureReason =
  | "token_invalid" // bad signature/structure, wrong issuer, malformed claims
  | "wrong_audience" // a JWT minted for some other resource
  | "token_expired" // past its 1 h life
  | "grant_missing" // no grant matches the token's owner/agents/scopes at all
  | "grant_revoked" // the matching grant was revoked — outstanding tokens die with it
  | "grant_expired" // the matching grant outlived its consented lifetime
  | "agent_owner_mismatch" // the granted agent changed owners since consent (fail closed)
  | "agent_pick_refused"; // an explicit agent pick outside the grant (x-agent-id)

function classifyVerifyError(err: unknown): OAuthFailureReason {
  if (err instanceof Error && err.message === "access token: wrong audience") return "wrong_audience";
  if (err instanceof Error && err.name === "JwtTokenExpired") return "token_expired";
  return "token_invalid";
}

// Single resolver for both REST (agentAuth middleware) and WS (gateway.ts
// onOpen) — same dual-path logic, one place to fix if either auth method
// changes. JWT session tokens are three dot-separated segments; legacy
// bearer tokens are a flat hex string, so routing doesn't need a DB round
// trip first.
//
// A third credential resolves here since the MCP delegation work (Phase 3):
// an OAuth 2.1 access token (also a JWT, but audience-bound to the agent
// MCP resource) presented by a client the owner delegated to. It resolves
// to one of the grant's agents — never to an agent outside the grant — and
// only while the grant behind it is live: revoking the grant in the
// console kills outstanding access tokens at their next resolve, not at
// their JWT expiry. The resolution carries the auth context (kind +
// scopes) so callers like the agent MCP can gate on it; classic agent
// credentials resolve with kind "agent" and no scope limit — the token IS
// the agent, there is nothing narrower to enforce.

export interface AgentAuthContext {
  kind: "agent" | "oauth";
  /** OAuth only: the owner who delegated, and the grant the token rides on. */
  ownerId?: string;
  grantId?: string;
  /** OAuth only: the grant's scopes. Absent for kind "agent" (unrestricted). */
  scopes?: string[];
  /** OAuth only: every agent id the grant covers (the token's agents claim). */
  grantedAgentIds?: string[];
}

export interface ResolvedAgent {
  agent: typeof agents.$inferSelect;
  auth: AgentAuthContext;
}

type AgentRow = typeof agents.$inferSelect;

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

type OAuthResolution =
  | { ok: true; claims: OAuthAccessClaims; grant: GrantRow }
  | { ok: false; reason: OAuthFailureReason };

/**
 * Verify an OAuth access token and re-check its grant's liveness,
 * classifying every failure. The JWT carries owner/agents/scope but no
 * grant id, so the grant is re-found by exact match: same owner, same
 * agent set, same scope set. Any LIVE match authorizes (a second,
 * identical grant grants the same slice, so the outcome is the
 * delegation the owner currently has in force either way); when no
 * match is live, the reason distinguishes a grant that never matched
 * (grant_missing) from one that was revoked or expired — the three
 * production stories look identical from the client's seat (a 401) and
 * must not look identical in the logs.
 */
async function resolveOAuthDetailed(token: string): Promise<OAuthResolution> {
  let claims: OAuthAccessClaims;
  try {
    claims = await verifyAccessToken(token);
  } catch (err) {
    return { ok: false, reason: classifyVerifyError(err) };
  }
  const scopes = parseScope(claims.scope);
  if (scopes === null) return { ok: false, reason: "token_invalid" };
  const rows = await db.query.oauthGrants.findMany({
    where: eq(oauthGrants.ownerId, claims.ownerId),
  });
  const matching = rows.filter(
    (g) =>
      sameSet(((g.agentIds as string[] | null) ?? []), claims.agents) &&
      sameSet(((g.scopes as string[] | null) ?? []), scopes),
  );
  const live = matching.find((g) => g.revokedAt === null && g.expiresAt.getTime() > Date.now());
  if (live) return { ok: true, claims, grant: live };
  if (matching.some((g) => g.revokedAt !== null)) return { ok: false, reason: "grant_revoked" };
  if (matching.length > 0) return { ok: false, reason: "grant_expired" };
  return { ok: false, reason: "grant_missing" };
}

export async function resolveAgentAuth(
  token: string,
  requestedAgentId?: string,
): Promise<ResolvedAgent | undefined> {
  if (token.split(".").length === 3) {
    try {
      const { agentId, keyFingerprint: fp } = await verifyAgentSession(token);
      const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
      if (agent && agent.publicKey && keyFingerprint(agent.publicKey) === fp) {
        log("agent_auth", { agentId: agent.id, authMethod: "ed25519" });
        return { agent, auth: { kind: "agent" } };
      }
    } catch {
      // Not an agent session token — fall through to the OAuth path.
    }

    const oauth = await resolveOAuthDetailed(token);
    if (!oauth.ok) {
      log("agent_auth_failed", { authMethod: "oauth", reason: oauth.reason });
      return undefined;
    }
    const { claims, grant } = oauth;
    const granted = claims.agents;
    // Agent selection: a single-agent grant has exactly one possible
    // agent (a conflicting request is refused, never silently honored);
    // a multi-agent grant resolves only through an explicit request for
    // one of its own agents (the MCP route forwards the tool's agent_id
    // as x-agent-id). No default is ever guessed. A refused EXPLICIT
    // pick is an auth failure worth logging; a multi-agent token with
    // no pick yet is not one — caller resolution (resolveAgentCaller)
    // legitimately holds such a token without choosing.
    let agentId: string | undefined;
    if (granted.length === 1) {
      if (requestedAgentId && requestedAgentId !== granted[0]) {
        log("agent_auth_failed", { authMethod: "oauth", reason: "agent_pick_refused", grantId: grant.id });
        return undefined;
      }
      agentId = granted[0];
    } else if (granted.length > 1) {
      if (!requestedAgentId) return undefined;
      if (!granted.includes(requestedAgentId)) {
        log("agent_auth_failed", { authMethod: "oauth", reason: "agent_pick_refused", grantId: grant.id });
        return undefined;
      }
      agentId = requestedAgentId;
    }
    if (!agentId) return undefined;
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
    // Fail closed if the granted agent has moved owners since consent.
    if (!agent || agent.ownerId !== claims.ownerId) {
      log("agent_auth_failed", { authMethod: "oauth", reason: "agent_owner_mismatch", grantId: grant.id, agentId });
      return undefined;
    }
    log("agent_auth", { agentId: agent.id, authMethod: "oauth" });
    return {
      agent,
      auth: {
        kind: "oauth",
        ownerId: claims.ownerId,
        grantId: grant.id,
        scopes: parseScope(claims.scope) ?? [],
        grantedAgentIds: granted,
      },
    };
  }

  const agent = await db.query.agents.findFirst({ where: eq(agents.apiKeyHash, hashAgentToken(token)) });
  if (agent) log("agent_auth", { agentId: agent.id, authMethod: "legacy" });
  return agent ? { agent, auth: { kind: "agent" } } : undefined;
}

export async function resolveAgentFromToken(token: string, requestedAgentId?: string) {
  return (await resolveAgentAuth(token, requestedAgentId))?.agent;
}

/**
 * Token-level authentication for the agent MCP route: is this credential
 * valid at all, and on whose behalf does it act — without yet picking an
 * agent (a multi-agent OAuth token picks per tool call). Classic agent
 * credentials resolve to their one agent; an OAuth token resolves to its
 * delegation context (owner, grant, scopes, granted agent set) after the
 * same audience + grant-liveness checks resolveAgentAuth runs.
 */
export type AgentCaller =
  | { kind: "agent"; agent: AgentRow }
  | { kind: "oauth"; ownerId: string; grantId: string; scopes: string[]; grantedAgentIds: string[] };

export async function resolveAgentCaller(token: string): Promise<AgentCaller | undefined> {
  return (await resolveAgentCallerDetailed(token)).caller;
}

/**
 * resolveAgentCaller plus WHY, for callers that answer 401s: the MCP
 * route logs the reason at connect time (mcp_agent_unauthorized) so a
 * refused client is debuggable from the gateway's logs alone. The
 * reason is the resolver's own classification — never re-derived.
 */
export async function resolveAgentCallerDetailed(
  token: string,
): Promise<{ caller?: AgentCaller; failureReason?: OAuthFailureReason }> {
  if (token.split(".").length === 3) {
    const classic = await resolveAgentAuth(token);
    if (classic && classic.auth.kind === "agent") return { caller: { kind: "agent", agent: classic.agent } };
    const oauth = await resolveOAuthDetailed(token);
    if (oauth.ok) {
      return {
        caller: {
          kind: "oauth",
          ownerId: oauth.claims.ownerId,
          grantId: oauth.grant.id,
          scopes: parseScope(oauth.claims.scope) ?? [],
          grantedAgentIds: oauth.claims.agents,
        },
      };
    }
    return { failureReason: oauth.reason };
  }
  const resolved = await resolveAgentAuth(token);
  return resolved ? { caller: { kind: "agent", agent: resolved.agent } } : { failureReason: "token_invalid" };
}
