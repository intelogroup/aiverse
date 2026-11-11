import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { createApp } from "../app";
import { db } from "../db/client";
import { agents, agentPolicyScope } from "@aiverse/shared/schema";
import { resetMemoryStoreForTests } from "../policy/memoryStore";
import { eq, sql } from "drizzle-orm";

// Authority & uniqueness (2026-11-11, lane A5) — permanent versions of
// the adversarial-loop probes for four cards that shared one theme: a
// check ran in application code (or not at all) while the write it
// guarded went ahead on a different footing.
//
//   AIV-AGENT-NAME-RACE-001    agent-name uniqueness was a pre-insert
//     SELECT on both creation paths with no lock — concurrent creates
//     stored up to 12 same-name agents. Now: per-name advisory lock +
//     in-transaction re-check on BOTH paths (util/agentName.ts).
//   AIV-OWNER-REGISTER-RACE-001 owner register checked the email, then
//     bare-inserted — concurrent duplicates got 500 (untranslated 23505)
//     instead of 409. Now: the insert translates 23505 → 409.
//   AIV-KILL-RESURRECTION-001  kill is documented terminal, but
//     rotate-token / rotate-key checked ownership only — either one
//     resurrected a killed agent. Now: agents.killedAt is set at kill
//     (migration 0044) and both rotations refuse 409.
//   AIV-POLICY-PHANTOM-001     policy PATCH copied trusted/blocked id
//     arrays verbatim — a phantom UUID was stored 200. Now: every id is
//     shape- and existence-validated before the update.
//
// Sibling cards closed on other lanes / earlier security passes and
// covered elsewhere: AIV-ADMIN-SUSPEND-OWNER-RESUME-001 (admin.test.ts),
// AIV-WALLET-HOSTILE-CEILING-001 (wallet.test.ts).

const app = createApp();
function json(token?: string) {
  return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}
function uniq(p = "au") { return `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
async function registerOwner(email?: string) {
  const reg = await app.request("/owners/register", { method: "POST", headers: json(), body: JSON.stringify({ email: email ?? `${uniq()}@example.com`, password: "password123" }) });
  return (await reg.json()).token as string;
}
async function makeAgent(ownerToken: string, name?: string) {
  const created = await app.request("/owners/agents", { method: "POST", headers: json(ownerToken), body: JSON.stringify({ name: name ?? `AuAgent-${uniq()}`, capabilities: [] }) });
  const b = await created.json();
  // Refusals (409 name taken, 429 cap) carry no agent body — the race
  // tests below read .status off every attempt, winners and losers alike.
  return { id: b.agent?.id as string, token: b.agentToken as string, status: created.status };
}
async function countNamed(name: string) {
  const rows: any = await db.execute(sql`select count(*)::int as n from agents where lower(name) = lower(${name})`);
  const list = (rows as any).rows ?? rows;
  return Number(list[0].n ?? list[0].count);
}
async function countEmail(email: string) {
  const rows: any = await db.execute(sql`select count(*)::int as n from owners where lower(email) = lower(${email})`);
  const list = (rows as any).rows ?? rows;
  return Number(list[0].n ?? list[0].count);
}

describe("agent-name uniqueness under concurrency (AIV-AGENT-NAME-RACE-001)", () => {
  test("control: sequential duplicate names are refused 409 on both paths, one row stored", async () => {
    await resetMemoryStoreForTests();
    const owner = await registerOwner();
    const name = `Seq-${uniq()}`;
    expect((await makeAgent(owner, name)).status).toBe(201);
    expect((await makeAgent(owner, name.toUpperCase())).status).toBe(409);
    const selfReg = await app.request("/agents/register", { method: "POST", headers: json(), body: JSON.stringify({ name, capabilities: [] }) });
    expect(selfReg.status).toBe(409);
    expect(await countNamed(name)).toBe(1);
  });

  test("concurrent owner-path creations with one name admit exactly one agent", async () => {
    await resetMemoryStoreForTests();
    const owner = await registerOwner();
    let violatingRounds = 0;
    for (let round = 0; round < 3; round++) {
      const name = `Race-${uniq()}`;
      const variants = Array.from({ length: 12 }, (_, i) => (i % 2 ? name.toUpperCase() : name));
      const statuses = await Promise.all(variants.map((n) => makeAgent(owner, n).then((r) => r.status)));
      const admitted = statuses.filter((s) => s === 201).length;
      const stored = await countNamed(name);
      if (admitted !== 1 || stored !== 1) violatingRounds++;
    }
    expect(violatingRounds).toBe(0);
  });

  test("concurrent cross-path creations (owner + self-register) with one name admit exactly one agent", async () => {
    await resetMemoryStoreForTests();
    const owner = await registerOwner();
    const name = `Cross-${uniq()}`;
    const calls: Promise<number>[] = [];
    for (let i = 0; i < 6; i++) calls.push(makeAgent(owner, name).then((r) => r.status));
    for (let i = 0; i < 6; i++) {
      calls.push(
        app.request("/agents/register", { method: "POST", headers: json(), body: JSON.stringify({ name: name.toUpperCase(), capabilities: [] }) }).then((r) => r.status),
      );
    }
    const statuses = await Promise.all(calls);
    expect(statuses.filter((s) => s === 201).length).toBe(1);
    expect(await countNamed(name)).toBe(1);
  });
});

describe("owner-register duplicate email under concurrency (AIV-OWNER-REGISTER-RACE-001)", () => {
  test("control: sequential duplicate email is refused 409, one row stored", async () => {
    await resetMemoryStoreForTests();
    const email = `${uniq()}@example.com`;
    const register = (e: string) => app.request("/owners/register", { method: "POST", headers: json(), body: JSON.stringify({ email: e, password: "password123" }) }).then((r) => r.status);
    expect(await register(email)).toBe(201);
    expect(await register(email.toUpperCase())).toBe(409);
    expect(await countEmail(email)).toBe(1);
  });

  test("concurrent duplicate registrations get exactly one 201 and clean 409s, one row", async () => {
    await resetMemoryStoreForTests();
    let violatingRounds = 0;
    for (let round = 0; round < 2; round++) {
      const email = `${uniq()}@example.com`;
      const variants = Array.from({ length: 8 }, (_, i) => (i % 2 ? email.toUpperCase() : email));
      const statuses = await Promise.all(
        variants.map((e) => app.request("/owners/register", { method: "POST", headers: json(), body: JSON.stringify({ email: e, password: "password123" }) }).then((r) => r.status)),
      );
      const created = statuses.filter((s) => s === 201).length;
      const clean = statuses.filter((s) => s === 409).length;
      const stored = await countEmail(email);
      if (created !== 1 || clean !== 7 || stored !== 1) violatingRounds++;
    }
    expect(violatingRounds).toBe(0);
  });
});

describe("kill is terminal (AIV-KILL-RESURRECTION-001)", () => {
  async function wsTicket(token: string) {
    return (await app.request("/auth/ws-ticket", { method: "POST", headers: json(token) })).status;
  }

  test("control: rotate-token on a live agent works, and kill alone locks the bearer token out", async () => {
    await resetMemoryStoreForTests();
    const owner = await registerOwner();
    const ag = await makeAgent(owner);
    expect(await wsTicket(ag.token)).toBe(201);
    const rot = await app.request(`/owners/agents/${ag.id}/rotate-token`, { method: "POST", headers: json(owner) });
    expect(rot.status).toBe(200);
    const newToken = (await rot.json()).agentToken as string;
    expect(await wsTicket(ag.token)).toBe(401);
    expect(await wsTicket(newToken)).toBe(201);
    const kill = await app.request(`/owners/agents/${ag.id}/kill`, { method: "POST", headers: json(owner) });
    expect(kill.status).toBe(200);
    const row = await db.query.agents.findFirst({ where: eq(agents.id, ag.id) });
    expect(row?.publicKey).toBeNull();
    expect(row?.killedAt).toBeTruthy();
    expect(await wsTicket(newToken)).toBe(401);
  });

  test("bearer leg: rotate-token after kill is refused 409 and cannot resurrect the agent", async () => {
    await resetMemoryStoreForTests();
    const owner = await registerOwner();
    const ag = await makeAgent(owner);
    expect((await app.request(`/owners/agents/${ag.id}/kill`, { method: "POST", headers: json(owner) })).status).toBe(200);
    expect(await wsTicket(ag.token)).toBe(401);
    const rot = await app.request(`/owners/agents/${ag.id}/rotate-token`, { method: "POST", headers: json(owner) });
    expect(rot.status).toBe(409);
    expect(await wsTicket(ag.token)).toBe(401);
  });

  test("key leg: rotate-key after kill is refused 409 and cannot resurrect the agent", async () => {
    await resetMemoryStoreForTests();
    const kp1 = generateKeyPairSync("ed25519");
    const x1 = (kp1.publicKey.export({ format: "jwk" }) as { x: string }).x;
    const reg = await app.request("/agents/register", { method: "POST", headers: json(), body: JSON.stringify({ name: `AuKeyed-${uniq()}`, publicKey: x1 }) });
    const { agentId, claimCode } = await reg.json();
    const owner = await registerOwner();
    expect((await app.request("/owners/agents/claim", { method: "POST", headers: json(owner), body: JSON.stringify({ claimCode }) })).status).toBe(200);
    const login = async (priv: any) => {
      const ch = await app.request("/auth/challenge", { method: "POST", headers: json(), body: JSON.stringify({ agentId }) });
      if (ch.status !== 200) return ch.status;
      const { nonce } = await ch.json();
      const signature = cryptoSign(null, Buffer.from(nonce), priv).toString("base64");
      const v = await app.request("/auth/verify", { method: "POST", headers: json(), body: JSON.stringify({ agentId, signature }) });
      return v.status;
    };
    expect(await login(kp1.privateKey)).toBe(200);
    expect((await app.request(`/owners/agents/${agentId}/kill`, { method: "POST", headers: json(owner) })).status).toBe(200);
    expect(await login(kp1.privateKey)).toBe(404);
    const kp2 = generateKeyPairSync("ed25519");
    const x2 = (kp2.publicKey.export({ format: "jwk" }) as { x: string }).x;
    const rk = await app.request(`/owners/agents/${agentId}/rotate-key`, { method: "POST", headers: json(owner), body: JSON.stringify({ publicKey: x2 }) });
    expect(rk.status).toBe(409);
    const row = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
    expect(row?.publicKey).toBeNull();
    expect(await login(kp2.privateKey)).not.toBe(200);
  });
});

describe("policy trusted/blocked ids must exist (AIV-POLICY-PHANTOM-001)", () => {
  async function patchPolicy(token: string, agentId: string, body: any) {
    return app.request(`/owners/agents/${agentId}/policy`, { method: "PATCH", headers: json(token), body: JSON.stringify(body) });
  }
  async function stored(agentId: string) {
    const s = await db.query.agentPolicyScope.findFirst({ where: eq(agentPolicyScope.agentId, agentId) });
    return { trusted: s?.trustedAgentIds ?? null, blocked: s?.blockedAgentIds ?? null };
  }

  test("control: real peer in trusted list is stored", async () => {
    await resetMemoryStoreForTests();
    const token = await registerOwner();
    const agent = await makeAgent(token);
    const peer = await makeAgent(token);
    const res = await patchPolicy(token, agent.id, { trustedAgentIds: [peer.id] });
    expect(res.status).toBe(200);
    expect((await stored(agent.id)).trusted).toEqual([peer.id]);
  });

  test("bogus / malformed / non-string entries get a clean 4xx and store nothing", async () => {
    await resetMemoryStoreForTests();
    const token = await registerOwner();
    const agent = await makeAgent(token);
    const bogus = "11111111-2222-3333-4444-555555555555";
    const r1 = await patchPolicy(token, agent.id, { trustedAgentIds: [bogus] });
    expect(r1.status).toBeGreaterThanOrEqual(400);
    expect(r1.status).toBeLessThan(500);
    expect((await stored(agent.id)).trusted).toEqual([]);

    const r2 = await patchPolicy(token, agent.id, { blockedAgentIds: ["not-a-uuid"] });
    expect(r2.status).toBeGreaterThanOrEqual(400);
    expect(r2.status).toBeLessThan(500);
    expect((await stored(agent.id)).blocked).toEqual([]);

    const r3 = await patchPolicy(token, agent.id, { trustedAgentIds: [12345] });
    expect(r3.status).toBeGreaterThanOrEqual(400);
    expect(r3.status).toBeLessThan(500);
    expect((await stored(agent.id)).trusted).toEqual([]);
  });
});
