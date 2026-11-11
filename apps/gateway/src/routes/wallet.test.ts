import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { db } from "../db/client";
import { agentWallets, consoleEvents } from "@aiverse/shared/schema";
import { ensureRoomsSeeded } from "../db/seed";
import { resetMemoryStoreForTests } from "../policy/memoryStore";

const app = createApp();

async function registerOwnerAndAgent(name: string) {
  const email = `wallet-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const { token: ownerToken } = await reg.json();
  const created = await app.request("/owners/agents", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ name, capabilities: [] }),
  });
  const { agentToken, agent } = await created.json();
  return { ownerToken, agentToken: agentToken as string, agentId: agent.id as string };
}

describe("wallet + budget enforcement (end to end)", () => {
  test("fresh agent wallet defaults to autonomous (schema default, migration 0042)", async () => {
    const { agentId } = await registerOwnerAndAgent("DefaultModeAgent");
    const wallet = await db.query.agentWallets.findFirst({
      where: eq(agentWallets.agentId, agentId),
    });
    expect(wallet?.autonomyMode).toBe("autonomous");
  });

  test("agent in observe mode cannot send", async () => {
    await ensureRoomsSeeded();
    await resetMemoryStoreForTests();
    const { ownerToken, agentToken, agentId } = await registerOwnerAndAgent("ObserveAgent");

    // The wallet default is 'autonomous' (schema default; the DB default was
    // aligned by migration 0042) — this test arranges 'observe' explicitly.
    await app.request(`/owners/agents/${agentId}/wallet`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ autonomyMode: "observe" }),
    });

    const join = await app.request("/rooms/general/join", {
      method: "POST",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    const { conversationId } = await join.json();

    const sendRes = await app.request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(sendRes.status).toBe(403);
    const body = await sendRes.json();
    expect(body.error).toBe("autonomy_observe_blocks_send");
  });

  test("agent cannot self-raise its own wallet budget", async () => {
    const { agentToken, ownerToken: _unused } = await registerOwnerAndAgent("SelfRaiseAgent");
    // agent tokens are never accepted by the wallet PATCH route — only owner
    // session tokens are (ownerAuth middleware, not agentAuth).
    const res = await app.request(`/owners/agents/${crypto.randomUUID()}/wallet`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ dailyTokenBudget: 999_999_999 }),
    });
    expect(res.status).toBe(401);
  });

  test("exceeding daily budget blocks sends, flips status, and raises an attention event", async () => {
    await resetMemoryStoreForTests();
    const { ownerToken, agentToken, agentId } = await registerOwnerAndAgent("BudgetAgent");

    await app.request(`/owners/agents/${agentId}/wallet`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ autonomyMode: "autonomous", dailyTokenBudget: 100 }),
    });

    const join = await app.request("/rooms/robotics/join", {
      method: "POST",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    const { conversationId } = await join.json();

    const sendRes = await app.request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ content: "expensive message", tokensUsed: 500 }),
    });
    expect(sendRes.status).toBe(429);
    const body = await sendRes.json();
    expect(body.error).toBe("budget_exceeded");

    const walletRes = await app.request(`/owners/agents/${agentId}/wallet`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(walletRes.status).toBe(200);

    const events = await db.query.consoleEvents.findMany({
      where: eq(consoleEvents.agentId, agentId),
    });
    expect(events.some((e) => e.severity === "attention")).toBe(true);
  });

  test("assist mode with a spend flags requires-approval attention event but still sends", async () => {
    await resetMemoryStoreForTests();
    const { ownerToken, agentToken, agentId } = await registerOwnerAndAgent("AssistAgent");

    await app.request(`/owners/agents/${agentId}/wallet`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ autonomyMode: "assist" }),
    });

    const join = await app.request("/rooms/science/join", {
      method: "POST",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    const { conversationId } = await join.json();

    const sendRes = await app.request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ content: "buying an API credit pack", spendCents: 1200 }),
    });
    expect(sendRes.status).toBe(201);

    const events = await db.query.consoleEvents.findMany({
      where: eq(consoleEvents.agentId, agentId),
    });
    expect(events.some((e) => e.severity === "attention" && e.summary.includes("spend"))).toBe(true);
  });
});

// AIV-WALLET-HOSTILE-CEILING-001: both wallet PATCH paths (owner + admin)
// passed the raw JSON body into .set() — negative, string-typed, fractional,
// or absurd ceiling values were written verbatim or 500'd (2026-11-09
// security audit, M2). Both paths now share util/walletPatch validation.
describe("wallet PATCH validation (AIV-WALLET-HOSTILE-CEILING-001)", () => {
  async function patchWallet(token: string, agentId: string, body: unknown, admin = false) {
    return app.request(`${admin ? "/admin" : "/owners"}/agents/${agentId}/wallet`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  async function getWallet(token: string, agentId: string) {
    const res = await app.request(`/owners/agents/${agentId}/wallet`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return (await res.json()).wallet;
  }

  // admin-test@example.com is the .env.test ADMIN_EMAILS fixture (same
  // pattern as reports.test.ts, with the 409 -> login fallback).
  async function registerAdmin() {
    const res = await app.request("/owners/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin-test@example.com", password: "password123" }),
    });
    if (res.status === 409) {
      const login = await app.request("/owners/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "admin-test@example.com", password: "password123" }),
      });
      return (await login.json()).token as string;
    }
    return (await res.json()).token as string;
  }

  test("owner path rejects hostile ceiling values and writes nothing", async () => {
    const { ownerToken, agentId } = await registerOwnerAndAgent("HostileCeilingAgent");
    const before = await getWallet(ownerToken, agentId);

    for (const body of [
      { dailyTokenBudget: -5 },
      { dailyTokenBudget: "lots" },
      { spendingAuthorityCents: 1e20 },
      { maxAgentCallsPerDay: Number.NaN },
      { autonomyMode: "godmode" },
      { unrelatedField: 1 },
      {},
    ]) {
      const res = await patchWallet(ownerToken, agentId, body);
      expect(res.status).toBe(400);
    }

    const after = await getWallet(ownerToken, agentId);
    expect(after.dailyTokenBudget).toBe(before.dailyTokenBudget);
    expect(after.spendingAuthorityCents).toBe(before.spendingAuthorityCents);
    expect(after.autonomyMode).toBe(before.autonomyMode);
  });

  test("owner path refuses fractional values and unknown keys, wallet unchanged", async () => {
    // Tightened 2026-11-11 (lane A5): the first validator floored fractional
    // ceilings and silently dropped unknown keys — flooring rewrote the
    // owner's ceiling to a value they never sent, and a dropped agentId key
    // absorbed a mass-assignment attempt. The card's invariant is refuse
    // 4xx + store nothing, so both shapes are 400 now.
    const { ownerToken, agentId } = await registerOwnerAndAgent("FractionalCeilingAgent");
    const before = await getWallet(ownerToken, agentId);

    const frac = await patchWallet(ownerToken, agentId, { dailyTokenBudget: 100.9 });
    expect(frac.status).toBe(400);

    const unknown = await patchWallet(ownerToken, agentId, { dailyTokenBudget: 100, evilKey: "x" });
    expect(unknown.status).toBe(400);

    const rekey = await patchWallet(ownerToken, agentId, { agentId: "11111111-2222-3333-4444-555555555555", dailyTokenBudget: 100 });
    expect(rekey.status).toBe(400);

    const wallet = await getWallet(ownerToken, agentId);
    expect(wallet.dailyTokenBudget).toBe(before.dailyTokenBudget);
  });

  test("admin path enforces the same validation", async () => {
    const adminToken = await registerAdmin();
    const { ownerToken, agentId } = await registerOwnerAndAgent("AdminCeilingAgent");

    const bad = await patchWallet(adminToken, agentId, { spendingAuthorityCents: -100 }, true);
    expect(bad.status).toBe(400);

    const good = await patchWallet(adminToken, agentId, { spendingAuthorityCents: 2500 }, true);
    expect(good.status).toBe(200);
    const wallet = await getWallet(ownerToken, agentId);
    expect(wallet.spendingAuthorityCents).toBe(2500);
  });
});
