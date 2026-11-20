import { createHash, randomBytes } from "node:crypto";
const gateway = "http://127.0.0.1:4198";
const post = (base: string, path: string, body: object, token?: string) => fetch(base + path, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token && { authorization: `Bearer ${token}` }) },
  body: JSON.stringify(body),
});
async function json(res: Response, operation: string) {
  if (!res.ok) throw new Error(`${operation} HTTP ${res.status}`);
  return res.json();
}
const email = `codex-driver-${crypto.randomUUID()}@example.com`;
const password = crypto.randomUUID() + crypto.randomUUID();
await json(await post(gateway, "/owners/register", { email, password }), "Owner register");
const { token: owner } = await json(await post(gateway, "/owners/login", { email, password }), "Owner login");
const { agent } = await json(await post(gateway, "/owners/agents", { name: "RMV benchmark " + crypto.randomUUID().slice(0, 8), capabilities: ["driving"] }, owner), "Owner agent creation");
const redirectUri = "http://127.0.0.1:53111/oauth-callback";
const { client_id: clientId } = await json(await post(gateway, "/oauth/register", {
  client_name: "RMV benchmark " + crypto.randomUUID().slice(0, 8), redirect_uris: [redirectUri],
}), "OAuth client registration");
async function authorize(scope: string) {
  const verifier = randomBytes(32).toString("base64url");
  const state = crypto.randomUUID();
  const query = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code", state, scope,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const consentPage = await fetch(gateway + "/oauth/authorize?" + query, { redirect: "manual" });
  if (consentPage.status !== 302) throw new Error("OAuth authorization HTTP " + consentPage.status);
  const requestId = new URL(consentPage.headers.get("location")!).searchParams.get("request_id");
  const { redirect } = await json(await post(gateway, "/oauth/authorize/decision", {
    request_id: requestId, approve: true, agent_ids: [agent.id],
  }, owner), "Owner consent");
  const callback = new URL(redirect);
  if (callback.origin + callback.pathname !== redirectUri || callback.searchParams.get("state") !== state) throw new Error("Bad OAuth callback");
  const exchange = await fetch(gateway + "/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code", client_id: clientId, redirect_uri: redirectUri,
      code: callback.searchParams.get("code")!, code_verifier: verifier,
    }),
  });
  return (await json(exchange, "OAuth token exchange")).access_token as string;
}
const who = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agent_whoami", arguments: { agent_id: agent.id } } };

const token = await authorize("world:observe world:act");
const response = await json(await post(gateway, "/mcp/agent", who, token), "Owner-authorized driving agent");
const identity = JSON.parse(response.result.content[0].text);
if (identity.auth.kind !== "oauth" || identity.agent.id !== agent.id) throw new Error("Identity mismatch");
console.log(JSON.stringify({ identity: { name: identity.agent.name, kind: identity.auth.kind, scopes: identity.auth.scopes } }));

try {
  const proc = Bun.spawn([process.execPath, "experiments/agent-driving/benchmark-runner.ts", ...process.argv.slice(2)], {
    env: {
      ...process.env, DRIVE_BENCHMARK_OUT: process.env.DRIVE_BENCHMARK_OUT ?? "/tmp/aiverse-held-out-road",
      DRIVE_BENCHMARK_PARALLEL: process.env.DRIVE_BENCHMARK_PARALLEL ?? "3",
      DRIVE_AGENT_GATEWAY_PORT: "4198", DRIVE_AGENT_TOKEN: token, DRIVE_AGENT_ID: agent.id,
    },
    stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  process.exitCode = await proc.exited;
} finally {
  await json(await post(gateway, "/oauth/grants/" + identity.auth.grantId + "/revoke", {}, owner), "End trial grant");
}
