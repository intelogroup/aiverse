import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { agents, oauthGrants } from "@aiverse/shared/schema";
import { hashAgentToken } from "./agentToken";
import { verifyAgentSession, keyFingerprint } from "./agentSession";
import { parseScope, verifyAccessToken, type OAuthAccessClaims } from "./oauthCore";
import { log } from "../util/log";

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

/**
 * The live grant an access token's claims were minted from, or undefined.
 * The JWT carries owner/agents/scope but no grant id, so the grant is
 * re-found by exact match: same owner, same agent set, same scope set,
 * not revoked, not expired. Any live match authorizes; revoking the
 * grant the token came from removes the match (a second, identical grant
 * would still match — it grants the same slice, so the outcome is the
 * delegation the owner currently has in force either way).
 */
async function liveGrantForClaims(claims: OAuthAccessClaims) {
  const scopes = parseScope(claims.scope);
  if (scopes === null) return undefined;
  const rows = await db.query.oauthGrants.findMany({
    where: and(eq(oauthGrants.ownerId, claims.ownerId), isNull(oauthGrants.revokedAt)),
  });
  return rows.find(
    (g) =>
      g.expiresAt.getTime() > Date.now() &&
      sameSet(((g.agentIds as string[] | null) ?? []), claims.agents) &&
      sameSet(((g.scopes as string[] | null) ?? []), scopes),
  );
}

/** Verify an OAuth access token and re-check its grant's liveness. */
async function resolveOAuthCaller(token: string) {
  let claims: OAuthAccessClaims;
  try {
    claims = await verifyAccessToken(token);
  } catch {
    return undefined;
  }
  const grant = await liveGrantForClaims(claims);
  if (!grant) return undefined;
  return { claims, grant };
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

    const oauth = await resolveOAuthCaller(token);
    if (oauth) {
      const { claims, grant } = oauth;
      const granted = claims.agents;
      // Agent selection: a single-agent grant has exactly one possible
      // agent (a conflicting request is refused, never silently honored);
      // a multi-agent grant resolves only through an explicit request for
      // one of its own agents (the MCP route forwards the tool's agent_id
      // as x-agent-id). No default is ever guessed.
      let agentId: string | undefined;
      if (granted.length === 1) {
        if (requestedAgentId && requestedAgentId !== granted[0]) return undefined;
        agentId = granted[0];
      } else if (granted.length > 1) {
        if (!requestedAgentId || !granted.includes(requestedAgentId)) return undefined;
        agentId = requestedAgentId;
      }
      if (!agentId) return undefined;
      const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
      // Fail closed if the granted agent has moved owners since consent.
      if (!agent || agent.ownerId !== claims.ownerId) return undefined;
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
    return undefined;
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
  if (token.split(".").length === 3) {
    const classic = await resolveAgentAuth(token);
    if (classic && classic.auth.kind === "agent") return { kind: "agent", agent: classic.agent };
    const oauth = await resolveOAuthCaller(token);
    if (oauth) {
      return {
        kind: "oauth",
        ownerId: oauth.claims.ownerId,
        grantId: oauth.grant.id,
        scopes: parseScope(oauth.claims.scope) ?? [],
        grantedAgentIds: oauth.claims.agents,
      };
    }
    return undefined;
  }
  const resolved = await resolveAgentAuth(token);
  return resolved ? { kind: "agent", agent: resolved.agent } : undefined;
}
