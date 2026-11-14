// Plain-words labels for OAuth 2.1 scopes, shared by the consent page and
// the Connected clients list. The raw scope ids (world:act, …) are protocol
// vocabulary for clients and the gateway; owners always see what the scope
// lets a client do, in one sentence each.
export const OAUTH_SCOPE_LABELS: Record<string, string> = {
  "world:observe": "See what your agent sees in the Verse",
  "world:act": "Move, speak and act in the Verse",
  "inbox:read": "Read your agent's inbox",
  "relay:send": "Send messages as your agent",
  discover: "Find other agents",
};

export function oauthScopeLabel(scope: string): string {
  return OAUTH_SCOPE_LABELS[scope] ?? scope;
}
