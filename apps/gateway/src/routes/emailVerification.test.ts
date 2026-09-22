import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { env } from "@aiverse/shared/env";
import { createApp } from "../app";

const app = createApp();
const json = (token?: string) => ({
  "content-type": "application/json",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

const realFetch = globalThis.fetch;
const sent: { url: string; body: { to: string; text: string }; auth: string | null }[] = [];

beforeEach(() => {
  sent.length = 0;
  env.REQUIRE_EMAIL_VERIFICATION = true;
  env.RESEND_API_KEY = "re_test";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://api.resend.com/emails") {
      sent.push({ url, body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  env.REQUIRE_EMAIL_VERIFICATION = false;
  env.RESEND_API_KEY = undefined;
});

async function register() {
  const email = `verify-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const res = await app.request("/owners/register", {
    method: "POST",
    headers: json(),
    body: JSON.stringify({ email, password: "password123" }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { token: string; owner: { emailVerified: boolean } };
  return { email, token: body.token as string, owner: body.owner };
}

const tokenFromLastEmail = () => new URL(sent.at(-1)!.body.text.match(/https?:\/\/\S+/)![0]).searchParams.get("token")!;

const createAgent = (token: string) =>
  app.request("/owners/agents", { method: "POST", headers: json(token), body: JSON.stringify({ name: "VerifyAgent" }) });

describe("owner email verification", () => {
  test("signup sends a verification email via Resend and starts unverified", async () => {
    const { email, owner } = await register();
    expect(owner.emailVerified).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0].auth).toBe("Bearer re_test");
    expect(sent[0].body.to).toBe(email);
    expect(tokenFromLastEmail()).toMatch(/^[0-9a-f]{64}$/);
  });

  test("unverified owner cannot create or claim agents", async () => {
    const { token } = await register();
    const create = await createAgent(token);
    expect(create.status).toBe(403);
    expect(((await create.json()) as { error: string }).error).toBe("email_not_verified");

    const claim = await app.request("/owners/agents/claim", {
      method: "POST",
      headers: json(token),
      body: JSON.stringify({ claimCode: "AIVERSE-NOPE" }),
    });
    expect(claim.status).toBe(403);
  });

  test("verifying with the emailed token unlocks agent creation, and the token is single-use", async () => {
    const { token } = await register();
    const verifyToken = tokenFromLastEmail();

    const verify = await app.request("/owners/verify-email", { method: "POST", headers: json(), body: JSON.stringify({ token: verifyToken }) });
    expect(verify.status).toBe(200);

    const me = await app.request("/owners/me", { headers: json(token) });
    expect(((await me.json()) as { owner: { emailVerified: boolean } }).owner.emailVerified).toBe(true);
    expect((await createAgent(token)).status).toBe(201);

    const replay = await app.request("/owners/verify-email", { method: "POST", headers: json(), body: JSON.stringify({ token: verifyToken }) });
    expect(replay.status).toBe(400);
  });

  test("a bogus token is rejected", async () => {
    const res = await app.request("/owners/verify-email", { method: "POST", headers: json(), body: JSON.stringify({ token: "f".repeat(64) }) });
    expect(res.status).toBe(400);
  });

  test("resend issues a fresh email and is rate-limited per owner", async () => {
    const { token } = await register();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await app.request("/owners/verify-email/resend", { method: "POST", headers: json(token) })).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(sent).toHaveLength(4);
  });

  test("signup still succeeds when Resend is down", async () => {
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const { owner } = await register();
    expect(owner.emailVerified).toBe(false);
  });

  test("with enforcement off, unverified owners are not gated", async () => {
    env.REQUIRE_EMAIL_VERIFICATION = false;
    const { token } = await register();
    expect((await createAgent(token)).status).toBe(201);
  });
});
