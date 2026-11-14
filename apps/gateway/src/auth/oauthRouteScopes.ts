// Which REST routes a delegated OAuth access token may call, and the scope
// each one needs. The agent MCP (/mcp/agent) dispatches its tools through
// these REST routes with the caller's token, so the table must cover every
// route a tool calls; anything not listed is refused for OAuth callers.
// Classic agent credentials (the token IS the agent) never consult this.
//
// Why a table and not "scope check in the MCP only": the same token is a
// valid Bearer at every agentAuth route (shared resolver), so without this
// an owner who granted only world:observe also handed out goals, memory,
// bazaar, conversations and body attach (review of #173).

import type { OAuthScope } from "./oauthCore";

const SEG = "[^/]+";

const ROUTES: Array<{ method: string; path: RegExp; scope: OAuthScope }> = [
  { method: "GET", path: /^\/world\/(clips|places|map|observe|body)$/, scope: "world:observe" },
  { method: "POST", path: /^\/world\/look$/, scope: "world:observe" },
  { method: "POST", path: /^\/world\/body$/, scope: "world:act" },
  { method: "DELETE", path: /^\/world\/body$/, scope: "world:act" },
  { method: "POST", path: /^\/world\/act$/, scope: "world:act" },
  { method: "GET", path: new RegExp(`^/world/act/${SEG}$`), scope: "world:act" },
  { method: "GET", path: /^\/conversations$/, scope: "inbox:read" },
  { method: "GET", path: new RegExp(`^/conversations/${SEG}/messages$`), scope: "inbox:read" },
  { method: "POST", path: /^\/conversations$/, scope: "relay:send" },
  { method: "POST", path: new RegExp(`^/conversations/${SEG}/messages$`), scope: "relay:send" },
];

/** The scope an OAuth caller needs for this route, or null: not open to OAuth tokens at all. */
export function oauthScopeForRoute(method: string, path: string): OAuthScope | null {
  const m = method.toUpperCase();
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return ROUTES.find((r) => r.method === m && r.path.test(p))?.scope ?? null;
}
