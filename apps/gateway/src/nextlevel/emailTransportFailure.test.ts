import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { env } from "@aiverse/shared/env";
import { createApp } from "../app";
import { redis } from "../redis/client";

// Next-level suite 1 — email transport failure.
//
// Regression coverage for the real 2026-10-09 incident: the gateway's
// Resend sender domain (aiverse.network) was never verified, so every
// POST /owners/verify-email/resend died inside sendVerificationEmail and
// the endpoint 502'd with "Gateway is temporarily unavailable". These
// tests pin the failure contract: 502 (never 500), a named log event,
// and a retryable token left in Redis.
//
// Ported from tmp/aiverse-next-level-tests (written 2026-10-12) with the
// two then-pinned bugs FLIPPED to the fixed behavior:
//   - a fetch-level throw now logs email.verification.send_failed, same
//     as an HTTP error status (was: silent — an outage was invisible);
//   - a failed send no longer consumes the 3/hour resend allowance
//     (was: [502,502,502,429] — three failures locked the owner out for
//     the hour with nothing sent). The allowance prices successes only.

const app = createApp();
const json = (token?: string) => ({
  "content-type": "application/json",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

const realFetch = globalThis.fetch;
const realConsoleError = console.error;
let resendBehavior: "ok" | "forbidden-domain" | "rate-limited" | "server-error" | "network-failure" = "ok";
let errorLines: string[] = [];

const DOMAIN_NOT_VERIFIED_BODY = JSON.stringify({
  message: "The aiverse.network domain is not verified. Please, add and verify your domain on https://resend.com/domains",
  name: "validation_error",
  statusCode: 403,
});

beforeEach(() => {
  resendBehavior = "ok";
  errorLines = [];
  env.REQUIRE_EMAIL_VERIFICATION = true;
  env.RESEND_API_KEY = "re_test";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://api.resend.com/emails") {
      switch (resendBehavior) {
        case "ok":
          return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
        case "forbidden-domain":
          return new Response(DOMAIN_NOT_VERIFIED_BODY, { status: 403 });
        case "rate-limited":
          return new Response(JSON.stringify({ message: "rate limited" }), { status: 429 });
        case "server-error":
          return new Response("boom", { status: 500 });
        case "network-failure":
          throw new Error("fetch failed: socket hang up");
      }
    }
    return realFetch(input, init);
  }) as typeof fetch;
  console.error = (...args: unknown[]) => {
    errorLines.push(args.map((a) => String(a)).join(" "));
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realConsoleError;
  env.REQUIRE_EMAIL_VERIFICATION = false;
  env.RESEND_API_KEY = undefined;
});

async function registerOwner() {
  const email = `resendfail-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const res = await app.request("/owners/register", {
    method: "POST",
    headers: json(),
    body: JSON.stringify({ email, password: "password123" }),
  });
  expect(res.status).toBe(201);
  const { token } = (await res.json()) as { token: string };
  return token as string;
}

async function resend(token: string) {
  return app.request("/owners/verify-email/resend", { method: "POST", headers: json(token) });
}

const emailVerifyKeyCount = async () => (await redis.keys("emailverify:*")).length;
const loggedSendFailed = () => errorLines.some((l) => l.includes("email.verification.send_failed"));

describe("email transport failure (2026-10-09 Resend incident)", () => {
  test("403 domain-not-verified → resend 502s (never 500s), logs email.verification.send_failed, token stays retryable in Redis", async () => {
    const token = await registerOwner();
    const keysBefore = await emailVerifyKeyCount();

    resendBehavior = "forbidden-domain";
    const res = await resend(token);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("could not send verification email, try again later");

    expect(loggedSendFailed()).toBe(true);
    const failureLine = errorLines.find((l) => l.includes("email.verification.send_failed"))!;
    expect(failureLine).toContain("resend 403");
    expect(failureLine).toContain("not verified");

    // The token is stored in Redis BEFORE the send attempt, so the failure
    // is retryable: a later resend (or the same token, had it been emailed)
    // still resolves to this owner.
    expect(await emailVerifyKeyCount()).toBe(keysBefore + 1);
  });

  test("429 from Resend → 502 + named log event + retryable token", async () => {
    const token = await registerOwner();
    const keysBefore = await emailVerifyKeyCount();

    resendBehavior = "rate-limited";
    const res = await resend(token);
    expect(res.status).toBe(502);
    expect(loggedSendFailed()).toBe(true);
    expect(errorLines.find((l) => l.includes("email.verification.send_failed"))).toContain("resend 429");
    expect(await emailVerifyKeyCount()).toBe(keysBefore + 1);
  });

  test("500 from Resend → 502 + named log event + retryable token", async () => {
    const token = await registerOwner();
    const keysBefore = await emailVerifyKeyCount();

    resendBehavior = "server-error";
    const res = await resend(token);
    expect(res.status).toBe(502);
    expect(loggedSendFailed()).toBe(true);
    expect(await emailVerifyKeyCount()).toBe(keysBefore + 1);
  });

  test("network failure (fetch rejects) → 502 + send_failed event logged + retryable token", async () => {
    // Fixed behavior: a transport-level throw now logs the same named
    // event as an HTTP error status (emailVerification.ts catch path),
    // instead of propagating silently to the endpoint's 502.
    const token = await registerOwner();
    const keysBefore = await emailVerifyKeyCount();

    resendBehavior = "network-failure";
    const res = await resend(token);
    expect(res.status).toBe(502);
    expect(loggedSendFailed()).toBe(true);
    expect(await emailVerifyKeyCount()).toBe(keysBefore + 1);
  });

  test("failed sends (HTTP 500) do not consume the resend allowance; 3 successes still cap at 429 on the 4th", async () => {
    // Fixed behavior: the takeToken allowance is refunded on send
    // failure, so an outage can no longer produce [502,502,502,429] and
    // lock the owner out with nothing sent. Failures stay retryable
    // indefinitely; the 3/hour cap applies to successful sends only.
    const token = await registerOwner();
    resendBehavior = "server-error";
    const failureStatuses: number[] = [];
    for (let i = 0; i < 4; i++) failureStatuses.push((await resend(token)).status);
    expect(failureStatuses).toEqual([502, 502, 502, 502]);

    resendBehavior = "ok";
    const successStatuses: number[] = [];
    for (let i = 0; i < 4; i++) successStatuses.push((await resend(token)).status);
    expect(successStatuses).toEqual([200, 200, 200, 429]);
  });

  test("failed sends (network failure) do not consume the resend allowance either", async () => {
    const token = await registerOwner();
    resendBehavior = "network-failure";
    const failureStatuses: number[] = [];
    for (let i = 0; i < 4; i++) failureStatuses.push((await resend(token)).status);
    expect(failureStatuses).toEqual([502, 502, 502, 502]);

    resendBehavior = "ok";
    expect((await resend(token)).status).toBe(200);
  });
});
