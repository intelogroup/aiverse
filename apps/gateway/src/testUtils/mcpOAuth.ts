import { expect } from "bun:test";
import { randomBytes } from "node:crypto";
import type { createApp } from "../app";
import { computeS256Challenge } from "../auth/oauthCore";

const REDIRECT_URI = "http://localhost:53111/oauth-callback";

export async function mintMcpOAuthToken(
  app: Pick<ReturnType<typeof createApp>, "request">,
  ownerSession: string,
  agentIds: string[],
  scope?: string,
) {
  const client = await app.request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.9.${randomBytes(1)[0]}.${randomBytes(1)[0]}` },
    body: JSON.stringify({ client_name: "test mcp client", redirect_uris: [REDIRECT_URI] }),
  });
  expect(client.status).toBe(201);
  const { client_id: clientId } = await client.json() as { client_id: string };

  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    code_challenge: computeS256Challenge(verifier),
    code_challenge_method: "S256",
    state: "state-123",
    ...(scope ? { scope } : {}),
  });
  const authorization = await app.request(`/oauth/authorize?${query}`);
  expect(authorization.status).toBe(302);
  const requestId = new URL(authorization.headers.get("location")!).searchParams.get("request_id")!;
  const decision = await app.request("/oauth/authorize/decision", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerSession}` },
    body: JSON.stringify({ request_id: requestId, approve: true, agent_ids: agentIds }),
  });
  expect(decision.status).toBe(200);
  const { redirect } = await decision.json() as { redirect: string };

  const exchange = await app.request("/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code: new URL(redirect).searchParams.get("code")!,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  expect(exchange.status).toBe(200);
  const { access_token: accessToken } = await exchange.json() as { access_token: string };
  return { accessToken, clientId };
}
