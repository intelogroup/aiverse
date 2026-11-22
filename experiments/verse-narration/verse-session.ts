// Real-owner onboarding for a harness agent, same path production users take: owner account -> agent ->
// OAuth 2.1 grant (owner consent) -> /mcp/agent. Mirrors experiments/agent-driving/owner-run.ts (trial gateway on
// 4198, local DB only). Nothing here is a shortcut around the grant: the harness gets an OAuth token, not an agent key.
import { createHash, randomBytes } from "node:crypto";

export const GATEWAY = process.env.VERSE_GATEWAY ?? "http://127.0.0.1:4198";
const REDIRECT = "http://127.0.0.1:53111/oauth-callback";

const post = (path: string, body: object, token?: string) => fetch(GATEWAY + path, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token && { authorization: `Bearer ${token}` }) },
  body: JSON.stringify(body),
});
async function json(res: Response, what: string) {
  if (!res.ok) throw new Error(`${what} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export interface VerseSession { owner: string; agentId: string; agentName: string; token: string; grantId: string }

export async function startSession(agentName: string, scope = "world:observe world:act"): Promise<VerseSession> {
  await fetch(GATEWAY + "/health").catch(() => { throw new Error(`Trial gateway ${GATEWAY} is not running (local DB only, see CLAUDE.md).`); });
  const email = `narration-${crypto.randomUUID()}@example.com`;
  const password = crypto.randomUUID() + crypto.randomUUID();
  await json(await post("/owners/register", { email, password }), "Owner register");
  const { token: owner } = await json(await post("/owners/login", { email, password }), "Owner login");
  const { agent } = await json(await post("/owners/agents", { name: agentName, capabilities: ["errands"] }, owner), "Agent create");
  const { client_id: clientId } = await json(await post("/oauth/register", { client_name: "narration-" + crypto.randomUUID().slice(0, 8), redirect_uris: [REDIRECT] }), "OAuth client");
  const verifier = randomBytes(32).toString("base64url");
  const state = crypto.randomUUID();
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: "code", state, scope,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
  const consent = await fetch(GATEWAY + "/oauth/authorize?" + q, { redirect: "manual" });
  if (consent.status !== 302) throw new Error("OAuth authorize HTTP " + consent.status);
  const requestId = new URL(consent.headers.get("location")!).searchParams.get("request_id");
  const { redirect } = await json(await post("/oauth/authorize/decision", { request_id: requestId, approve: true, agent_ids: [agent.id] }, owner), "Owner consent");
  const cb = new URL(redirect);
  if (cb.searchParams.get("state") !== state) throw new Error("Bad OAuth state");
  const ex = await json(await fetch(GATEWAY + "/oauth/token", { method: "POST", body: new URLSearchParams({
    grant_type: "authorization_code", client_id: clientId, redirect_uri: REDIRECT, code: cb.searchParams.get("code")!, code_verifier: verifier }) }), "Token exchange");
  const token = ex.access_token as string;
  // Visits are a human tap by design (gateway mcpAgent.ts header): the owner starts one, the agent cannot.
  await json(await post(`/owners/agents/${agent.id}/visits`, { minutes: 20, maxActions: 400 }, owner), "Owner starts visit");
  const who = await mcp(token, "agent_whoami", { agent_id: agent.id });
  return { owner, agentId: agent.id, agentName: agent.name, token, grantId: who.auth.grantId };
}

/** One MCP tool call over the same /mcp/agent door a harness uses. Returns the parsed JSON text payload. */
export async function mcp(token: string, name: string, args: object = {}): Promise<any> {
  const res = await post("/mcp/agent", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, token);
  const env = await json(res, `MCP ${name}`);
  const text = env.result?.content?.[0]?.text;
  if (env.result?.isError) throw new Error(`MCP ${name} error: ${String(text).slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}

export async function endSession(s: VerseSession) {
  // Leave the world cleanly (the owner's agent steps out) before the grant is revoked; otherwise the body lingers in the sim.
  await mcp(s.token, "body_detach", { agent_id: s.agentId }).catch(() => {});
  await post(`/oauth/grants/${s.grantId}/revoke`, {}, s.owner).catch(() => {});
}
