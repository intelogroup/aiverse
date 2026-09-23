import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { eq } from "drizzle-orm";
import { consoleEvents } from "@aiverse/shared/schema";
import { env } from "@aiverse/shared/env";
import { createApp } from "../app";
import { db } from "../db/client";
import { ensureRoomsSeeded } from "../db/seed";
import { resetMemoryStoreForTests } from "../policy/memoryStore";

const app = createApp();
const json = (token?: string) => ({
  "content-type": "application/json",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});
const PASSWORD = "password123";

async function registerOwner(emailOverride?: string) {
  const email = emailOverride ?? `sec-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const res = await app.request("/owners/register", {
    method: "POST",
    headers: json(),
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(res.status).toBe(201);
  const { token, owner } = await res.json();
  return { token: token as string, ownerId: owner.id as string, email };
}

async function createAgent(ownerToken: string, name: string) {
  const res = await app.request("/owners/agents", {
    method: "POST",
    headers: json(ownerToken),
    body: JSON.stringify({ name, capabilities: [] }),
  });
  expect(res.status).toBe(201);
  const { agent, agentToken } = await res.json();
  await app.request(`/owners/agents/${agent.id}/wallet`, {
    method: "PATCH",
    headers: json(ownerToken),
    body: JSON.stringify({ autonomyMode: "autonomous" }),
  });
  return { agentId: agent.id as string, agentToken: agentToken as string };
}

const me = (token: string) => app.request("/owners/me", { headers: json(token) });

beforeAll(async () => {
  await ensureRoomsSeeded();
});

// Isolation holds today only because every owner route remembers to scope by
// ownerId. This walks every owner-scoped :id route with a second owner's
// token, so a new route that forgets the check fails here instead of in prod.
describe("cross-tenant isolation", () => {
  test("owner B gets 404 on every owner route targeting owner A's resources", async () => {
    await resetMemoryStoreForTests();
    const a = await registerOwner();
    const b = await registerOwner();
    const aAgent = await createAgent(a.token, "TenantA");
    const bAgent = await createAgent(b.token, "TenantB");

    // A private conversation between A's agent and B's agent's peer would
    // leak to B legitimately; use a second agent of A's instead.
    const aAgent2 = await createAgent(a.token, "TenantA2");
    const conv = await app.request("/conversations", {
      method: "POST",
      headers: json(aAgent.agentToken),
      body: JSON.stringify({ isPublic: false, name: "a-private", participantIds: [aAgent2.agentId] }),
    });
    expect(conv.status).toBe(201);
    const { conversation } = await conv.json();

    const [event] = await db
      .insert(consoleEvents)
      .values({ agentId: aAgent.agentId, ownerId: a.ownerId, severity: "attention", summary: "tenant test" })
      .returning();

    const id = aAgent.agentId;
    const cases: [string, string, unknown?][] = [
      ["GET", `/owners/agents/${id}/wallet`],
      ["GET", `/owners/agents/${id}/usage-today`],
      ["PATCH", `/owners/agents/${id}/wallet`, { autonomyMode: "observe" }],
      ["GET", `/owners/agents/${id}/policy`],
      ["PATCH", `/owners/agents/${id}/policy`, {}],
      ["GET", `/owners/agents/${id}/mandate`],
      ["PUT", `/owners/agents/${id}/mandate`, { objectives: ["x"] }],
      ["PATCH", `/owners/agents/${id}/profile`, { description: "pwned" }],
      ["POST", `/owners/agents/${id}/pause`],
      ["POST", `/owners/agents/${id}/resume`],
      ["POST", `/owners/agents/${id}/rotate-key`, { publicKey: "A".repeat(43) }],
      ["POST", `/owners/agents/${id}/rotate-token`],
      ["POST", `/owners/agents/${id}/kill`],
      ["DELETE", `/owners/agents/${id}`],
      ["GET", `/owners/agents/${id}/conversations`],
      ["GET", `/owners/agents/${id}/questions`],
      ["GET", `/owners/conversations/${conversation.id}/messages`],
      ["POST", `/owners/console-events/${event.id}/resolve`],
    ];

    for (const [method, path, body] of cases) {
      const res = await app.request(path, {
        method,
        headers: json(b.token),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      // 404, not 403: a foreign id must be indistinguishable from a missing one.
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 });
    }

    // Nothing B did touched A's agent: A's original token still works.
    const still = await app.request("/auth/ws-ticket", { method: "POST", headers: json(aAgent.agentToken) });
    expect(still.status).toBe(201);
    const ev = await db.query.consoleEvents.findFirst({ where: eq(consoleEvents.id, event.id) });
    expect(ev?.resolvedAt).toBeNull();

    // And B's list never includes A's agents.
    const list = await app.request("/owners/agents", { headers: json(b.token) });
    const { agents } = await list.json();
    expect(agents.map((x: { id: string }) => x.id)).toEqual([bAgent.agentId]);
  });
});

describe("owner session revocation", () => {
  test("logout-all kills every outstanding token", async () => {
    await resetMemoryStoreForTests();
    const o = await registerOwner();
    const login = await app.request("/owners/login", {
      method: "POST",
      headers: json(),
      body: JSON.stringify({ email: o.email, password: PASSWORD }),
    });
    const { token: second } = await login.json();
    expect((await me(o.token)).status).toBe(200);
    expect((await me(second)).status).toBe(200);

    expect((await app.request("/owners/logout-all", { method: "POST", headers: json(second) })).status).toBe(200);
    expect((await me(o.token)).status).toBe(401);
    expect((await me(second)).status).toBe(401);
  });

  test("deleting the account invalidates its token", async () => {
    await resetMemoryStoreForTests();
    const o = await registerOwner();
    expect((await app.request("/owners/me", { method: "DELETE", headers: json(o.token), body: JSON.stringify({ confirmEmail: o.email }) })).status).toBe(200);
    expect((await me(o.token)).status).toBe(401);
  });

  test("password change needs the current password and revokes other sessions", async () => {
    await resetMemoryStoreForTests();
    const o = await registerOwner();

    const wrong = await app.request("/owners/password", {
      method: "POST",
      headers: json(o.token),
      body: JSON.stringify({ currentPassword: "nope-nope", newPassword: "newpassword456" }),
    });
    expect(wrong.status).toBe(401);

    const ok = await app.request("/owners/password", {
      method: "POST",
      headers: json(o.token),
      body: JSON.stringify({ currentPassword: PASSWORD, newPassword: "newpassword456" }),
    });
    expect(ok.status).toBe(200);
    const { token: fresh } = await ok.json();
    expect((await me(o.token)).status).toBe(401);
    expect((await me(fresh)).status).toBe(200);

    const oldLogin = await app.request("/owners/login", {
      method: "POST",
      headers: json(),
      body: JSON.stringify({ email: o.email, password: PASSWORD }),
    });
    expect(oldLogin.status).toBe(401);
  });
});

describe("registration input rules", () => {
  test("short passwords are rejected", async () => {
    await resetMemoryStoreForTests();
    const res = await app.request("/owners/register", {
      method: "POST",
      headers: json(),
      body: JSON.stringify({ email: `short-${Date.now()}@example.com`, password: "1234567" }),
    });
    expect(res.status).toBe(400);
  });

  test("email is case-insensitive for signup uniqueness and login", async () => {
    await resetMemoryStoreForTests();
    const base = `Case-${Date.now()}-${Math.random().toString(36).slice(2)}@Example.com`;
    await registerOwner(base);
    const dup = await app.request("/owners/register", {
      method: "POST",
      headers: json(),
      body: JSON.stringify({ email: base.toLowerCase(), password: PASSWORD }),
    });
    expect(dup.status).toBe(409);
    const login = await app.request("/owners/login", {
      method: "POST",
      headers: json(),
      body: JSON.stringify({ email: base.toUpperCase(), password: PASSWORD }),
    });
    expect(login.status).toBe(200);
  });
});

describe("password reset", () => {
  const realFetch = globalThis.fetch;
  const sent: { to: string; text: string }[] = [];

  beforeEach(() => {
    sent.length = 0;
    env.RESEND_API_KEY = "re_test";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "https://api.resend.com/emails") {
        sent.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
      }
      return realFetch(input, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    env.RESEND_API_KEY = undefined;
  });

  const requestReset = (email: string) =>
    app.request("/owners/password-reset/request", { method: "POST", headers: json(), body: JSON.stringify({ email }) });
  const confirm = (token: string, newPassword: string) =>
    app.request("/owners/password-reset/confirm", {
      method: "POST",
      headers: json(),
      body: JSON.stringify({ token, newPassword }),
    });

  test("unknown email gets the same 200 and no mail", async () => {
    await resetMemoryStoreForTests();
    const res = await requestReset(`nobody-${Date.now()}@example.com`);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  test("full reset: link works once, sets the password, revokes old sessions", async () => {
    await resetMemoryStoreForTests();
    const o = await registerOwner();
    sent.length = 0; // drop the signup verification email

    expect((await requestReset(o.email.toUpperCase())).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(o.email);
    const token = sent[0].text.match(/token=([0-9a-f]{64})/)![1];

    expect((await confirm(token, "short")).status).toBe(400);
    const ok = await confirm(token, "resetpassword789");
    expect(ok.status).toBe(200);
    const { token: fresh } = await ok.json();

    expect((await confirm(token, "anotherpassword0")).status).toBe(400); // single use
    expect((await me(o.token)).status).toBe(401);
    const meRes = await me(fresh);
    expect(meRes.status).toBe(200);
    expect((await meRes.json()).owner.emailVerified).toBe(true);

    const login = await app.request("/owners/login", {
      method: "POST",
      headers: json(),
      body: JSON.stringify({ email: o.email, password: "resetpassword789" }),
    });
    expect(login.status).toBe(200);
  });
});

describe("agent credential lifecycle", () => {
  test("rotate-token: old bearer stops working, new one works", async () => {
    await resetMemoryStoreForTests();
    const o = await registerOwner();
    const ag = await createAgent(o.token, "RotateMe");

    const rot = await app.request(`/owners/agents/${ag.agentId}/rotate-token`, { method: "POST", headers: json(o.token) });
    expect(rot.status).toBe(200);
    const { agentToken } = await rot.json();
    expect(agentToken).not.toBe(ag.agentToken);

    expect((await app.request("/auth/ws-ticket", { method: "POST", headers: json(ag.agentToken) })).status).toBe(401);
    expect((await app.request("/auth/ws-ticket", { method: "POST", headers: json(agentToken) })).status).toBe(201);
  });

  test("kill locks out an Ed25519 agent: live session dies and it cannot re-authenticate", async () => {
    await resetMemoryStoreForTests();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
    const reg = await app.request("/agents/register", {
      method: "POST",
      headers: json(),
      body: JSON.stringify({ name: "KeyedKill", publicKey: x }),
    });
    const { agentId, claimCode } = await reg.json();
    const o = await registerOwner();
    expect(
      (await app.request("/owners/agents/claim", { method: "POST", headers: json(o.token), body: JSON.stringify({ claimCode }) })).status,
    ).toBe(200);

    const login = async () => {
      const ch = await app.request("/auth/challenge", { method: "POST", headers: json(), body: JSON.stringify({ agentId }) });
      if (ch.status !== 200) return ch.status;
      const { nonce } = await ch.json();
      const signature = cryptoSign(null, Buffer.from(nonce), privateKey).toString("base64");
      const v = await app.request("/auth/verify", { method: "POST", headers: json(), body: JSON.stringify({ agentId, signature }) });
      return v.status === 200 ? ((await v.json()).token as string) : v.status;
    };

    const session = await login();
    expect(typeof session).toBe("string");
    expect((await app.request("/auth/ws-ticket", { method: "POST", headers: json(session as string) })).status).toBe(201);

    expect((await app.request(`/owners/agents/${agentId}/kill`, { method: "POST", headers: json(o.token) })).status).toBe(200);

    expect((await app.request("/auth/ws-ticket", { method: "POST", headers: json(session as string) })).status).toBe(401);
    expect(await login()).toBe(404); // no key left to challenge against
  });
});
