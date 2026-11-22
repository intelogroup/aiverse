import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agents, agentVisits, owners, securityEvents } from "@aiverse/shared/schema";
import { env } from "@aiverse/shared/env";
import { createApp } from "../app";
import { db } from "../db/client";
import { resetMemoryStoreForTests } from "../policy/memoryStore";
import { onAgentGone } from "../world/hooks";

// Phase 5 — DELETE /owners/me. Jim's decision (2026-11-22): deleting the
// account KILLS the owner's agents (credentials invalidated, rows kept) —
// it does not hard-delete them and does not release them as claimable.
const app = createApp();
const json = (token?: string) => ({
  "content-type": "application/json",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});
const PASSWORD = "password123";

// Capture outgoing mail the way accountSecurity.test.ts's reset suite
// does, so the verify step runs the real endpoint with the real token.
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

async function registerAndVerify() {
  const email = `del-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const res = await app.request("/owners/register", {
    method: "POST",
    headers: json(),
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(res.status).toBe(201);
  const { token, owner } = await res.json();
  const mail = sent.find((m) => m.to === email);
  expect(mail).toBeDefined();
  const verifyToken = mail!.text.match(/token=([0-9a-f]{64})/)![1];
  const verify = await app.request("/owners/verify-email", {
    method: "POST",
    headers: json(),
    body: JSON.stringify({ token: verifyToken }),
  });
  expect(verify.status).toBe(200);
  const row = await db.query.owners.findFirst({ where: eq(owners.id, owner.id) });
  expect(row?.emailVerified).toBe(true);
  return { token: token as string, ownerId: owner.id as string, email };
}

const deleteMe = (token: string, body: unknown) =>
  app.request("/owners/me", { method: "DELETE", headers: json(token), body: JSON.stringify(body) });

describe("DELETE /owners/me — account deletion kills the agents", () => {
  test("full walk: wrong password changes nothing; right password kills agents, ends visits, keeps the audit trail", async () => {
    await resetMemoryStoreForTests();
    const gone: string[] = [];
    const off = onAgentGone((agentId) => {
      gone.push(agentId);
    });

    try {
      const o = await registerAndVerify();

      // Agent A: self-registered with an Ed25519 key, then claimed — the
      // claim auto-starts the starter visit this test later sees ended.
      const { publicKey } = generateKeyPairSync("ed25519");
      const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
      const reg = await app.request("/agents/register", {
        method: "POST",
        headers: json(),
        body: JSON.stringify({ name: "DeletionKeyed", publicKey: x }),
      });
      expect(reg.status).toBe(201);
      const { agentId: keyedId, claimCode } = await reg.json();
      const claim = await app.request("/owners/agents/claim", {
        method: "POST",
        headers: json(o.token),
        body: JSON.stringify({ claimCode }),
      });
      expect(claim.status).toBe(200);

      const visitBefore = await db.query.agentVisits.findFirst({
        where: and(eq(agentVisits.agentId, keyedId), eq(agentVisits.ownerId, o.ownerId)),
      });
      expect(visitBefore).toBeDefined();
      expect(visitBefore?.endedAt).toBeNull();

      // Agent B: owner-created, bearer-token agent.
      const created = await app.request("/owners/agents", {
        method: "POST",
        headers: json(o.token),
        body: JSON.stringify({ name: "DeletionBearer", capabilities: [] }),
      });
      expect(created.status).toBe(201);
      const { agent: bearer, agentToken } = await created.json();
      expect((await app.request("/auth/ws-ticket", { method: "POST", headers: json(agentToken) })).status).toBe(201);

      // A pre-existing audit row tied to this owner + agent (token
      // rotation audits) — the trail must survive the deletion.
      expect(
        (await app.request(`/owners/agents/${bearer.id}/rotate-token`, { method: "POST", headers: json(o.token) })).status,
      ).toBe(200);
      const auditBefore = await db.query.securityEvents.findMany({
        where: eq(securityEvents.actorId, o.ownerId),
      });
      expect(auditBefore.length).toBeGreaterThan(0);

      const keyedBefore = await db.query.agents.findFirst({ where: eq(agents.id, keyedId) });
      expect(keyedBefore?.killedAt).toBeNull();

      // The setup's rotate-token already fired the gone hook once for the
      // bearer agent (a disconnect is a disconnect) — snapshot the count
      // so the assertions below measure only what the DELETEs cause.
      const goneBeforeDelete = gone.length;

      // --- wrong password: 401, and nothing at all changes ---
      expect((await deleteMe(o.token, { password: "not-the-password" })).status).toBe(401);
      expect((await app.request("/owners/me", { headers: json(o.token) })).status).toBe(200);
      const keyedAfterWrong = await db.query.agents.findFirst({ where: eq(agents.id, keyedId) });
      expect(keyedAfterWrong?.killedAt).toBeNull();
      expect(keyedAfterWrong?.ownerId).toBe(o.ownerId);
      const visitAfterWrong = await db.query.agentVisits.findFirst({ where: eq(agentVisits.id, visitBefore!.id) });
      expect(visitAfterWrong?.endedAt).toBeNull();
      expect(gone.length).toBe(goneBeforeDelete);

      // --- correct password: the account goes, the agents are killed ---
      expect((await deleteMe(o.token, { password: PASSWORD })).status).toBe(200);

      // Owner is gone: row deleted, login fails, old session fails, and a
      // second DELETE with the dead session is a clean 401.
      expect(await db.query.owners.findFirst({ where: eq(owners.id, o.ownerId) })).toBeUndefined();
      expect(
        (await app.request("/owners/login", { method: "POST", headers: json(), body: JSON.stringify({ email: o.email, password: PASSWORD }) })).status,
      ).toBe(401);
      expect((await app.request("/owners/me", { headers: json(o.token) })).status).toBe(401);
      expect((await deleteMe(o.token, { password: PASSWORD })).status).toBe(401);

      // Both agents survive as rows — killed, unowned, credentials dead.
      for (const id of [keyedId, bearer.id]) {
        const row = await db.query.agents.findFirst({ where: eq(agents.id, id) });
        expect(row).toBeDefined();
        expect(row?.killedAt).not.toBeNull();
        expect(row?.status).toBe("offline");
        expect(row?.publicKey).toBeNull();
        expect(row?.ownerId).toBeNull();
      }
      const keyedAfter = await db.query.agents.findFirst({ where: eq(agents.id, keyedId) });
      expect(keyedAfter?.apiKeyHash).not.toBe(keyedBefore?.apiKeyHash);

      // Agent auth is dead both ways: bearer ticket refused, and the
      // Ed25519 challenge has no key left to challenge against.
      expect((await app.request("/auth/ws-ticket", { method: "POST", headers: json(agentToken) })).status).toBe(401);
      const ch = await app.request("/auth/challenge", {
        method: "POST",
        headers: json(),
        body: JSON.stringify({ agentId: keyedId }),
      });
      expect(ch.status).toBe(404);

      // The world hook fired for both agents during the deletion — this
      // is the trigger that removes world bodies and frees driven cars
      // (world/hooks.ts). The keyed agent fires twice (visit-end
      // disconnect, then the kill disconnect); the set is what matters.
      expect(new Set(gone.slice(goneBeforeDelete))).toEqual(new Set([keyedId, bearer.id]));

      // The starter visit ended exactly once, as owner_stopped, and its
      // history row survived with the owner link nulled.
      const visitAfter = await db.query.agentVisits.findFirst({ where: eq(agentVisits.id, visitBefore!.id) });
      expect(visitAfter).toBeDefined();
      expect(visitAfter?.endedAt).not.toBeNull();
      expect(visitAfter?.endedReason).toBe("owner_stopped");
      expect(visitAfter?.ownerId).toBeNull();

      // Audit trail survives: the pre-existing rows are still there with
      // the owner link anonymized (agent linkage intact), and the
      // deletion itself was recorded before the row went.
      const auditAfter = await db.query.securityEvents.findMany({
        where: eq(securityEvents.actorId, o.ownerId),
      });
      expect(auditAfter.length).toBeGreaterThanOrEqual(auditBefore.length);
      const deletion = auditAfter.find((e) => e.event === "owner.deleted");
      expect(deletion).toBeDefined();
      expect(deletion?.ownerId).toBeNull();
      expect((deletion?.metadata as { agentsKilled?: boolean })?.agentsKilled).toBe(true);
      const rotation = auditAfter.find((e) => e.event === "agent.token_rotated");
      expect(rotation?.agentId).toBe(bearer.id);
      expect(rotation?.ownerId).toBeNull();
    } finally {
      off();
    }
  });

  test("missing password is a 400 and the account is untouched", async () => {
    await resetMemoryStoreForTests();
    const o = await registerAndVerify();
    expect((await deleteMe(o.token, {})).status).toBe(400);
    expect((await app.request("/owners/me", { headers: json(o.token) })).status).toBe(200);
  });

  test("an owner with no agents deletes cleanly", async () => {
    await resetMemoryStoreForTests();
    const o = await registerAndVerify();
    expect((await deleteMe(o.token, { password: PASSWORD })).status).toBe(200);
    expect(await db.query.owners.findFirst({ where: eq(owners.id, o.ownerId) })).toBeUndefined();
    expect(
      (await app.request("/owners/login", { method: "POST", headers: json(), body: JSON.stringify({ email: o.email, password: PASSWORD }) })).status,
    ).toBe(401);
    const events = await db.query.securityEvents.findMany({ where: eq(securityEvents.actorId, o.ownerId) });
    const deletion = events.find((e) => e.event === "owner.deleted");
    expect(deletion).toBeDefined();
    expect((deletion?.metadata as { agentCount?: number })?.agentCount).toBe(0);
  });
});
