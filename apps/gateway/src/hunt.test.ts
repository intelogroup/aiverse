/**
 * Hunt embed gates (apps/hunt/GATEWAY-INTEGRATION.md §f, G3/G4):
 *  - mode off ⇒ hunt routes absent, gateway behavior untouched;
 *  - mode on ⇒ the mounted app answers, the gateway's own /health
 *    stays authoritative, and a gateway owner JWT is the hunt's
 *    primary identity path (create on first sight; adopt by email);
 *  - the leader-section ticker job transitions events.
 * Env is set/restored per test and the runtime singleton reset, so the
 * rest of the suite keeps seeing mode-off (shared-process hygiene, the
 * app.test.ts health-cache pattern).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agents, eggCashBounties, eggHuntWins, owners } from "@aiverse/shared/schema";
import { mockCashPaypal } from "./testUtils/cashPaypal";
import { createApp } from "./app";
import { signOwnerSession } from "./auth/session";
import { db } from "./db/client";
import { getHuntRuntime, resetHuntRuntimeForTests, scheduleHuntTicker } from "./hunt";

const ENV_KEYS = ["AIVERSE_HUNT_MODE", "HUNT_DB_PATH", "HUNT_ADMIN_TOKEN",
  "PAYPAL_MODE", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_API_BASE"] as const;
let savedEnv: Record<string, string | undefined> = {};
let dir = "";
let ownerIds: string[] = [];

function enableHunt() {
  dir = mkdtempSync(join(tmpdir(), "hunt-mount-"));
  process.env.AIVERSE_HUNT_MODE = "1";
  process.env.HUNT_DB_PATH = join(dir, "hunt.db");
  process.env.HUNT_ADMIN_TOKEN = "mount-test-admin-token";
}

async function makeOwner(email: string) {
  const [owner] = await db
    .insert(owners)
    .values({ email, passwordHash: "mount-test", displayName: "Mount Tester" })
    .returning();
  ownerIds.push(owner.id);
  const token = await signOwnerSession(owner.id, owner.sessionVersion);
  return { owner, token };
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  resetHuntRuntimeForTests();
});

afterEach(async () => {
  resetHuntRuntimeForTests();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const id of ownerIds) await db.delete(owners).where(eq(owners.id, id));
  ownerIds = [];
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("hunt embed (AIVERSE_HUNT_MODE)", () => {
  test.each(["sandbox", "live"] as const)("an approved embodied bounty pays the verified owner once in %s mode with mocked PayPal", async (mode) => {
    enableHunt();
    const winner = await makeOwner(`cash-winner-${crypto.randomUUID()}@example.com`);
    const outsider = await makeOwner(`cash-outsider-${crypto.randomUUID()}@example.com`);
    const [agent] = await db.insert(agents).values({
      ownerId: winner.owner.id, name: `CashPilot-${crypto.randomUUID()}`, apiKeyHash: "fixture-never-used",
    }).returning();
    const approval = { amountCents: 100, mode, ownerId: winner.owner.id };
    process.env.PAYPAL_MODE = mode;
    process.env.PAYPAL_CLIENT_ID = "fake-cash-client";
    process.env.PAYPAL_CLIENT_SECRET = "fake-cash-secret";
    delete process.env.PAYPAL_API_BASE;

    let contestId: string | undefined;
    let paypal: ReturnType<typeof mockCashPaypal> | undefined;

    try {
      const app = createApp({ paypalFetch: (url, request) => paypal!.transport(url, request) });
      const admin = { authorization: "Bearer mount-test-admin-token", "content-type": "application/json" };
      const publish = (body: unknown, authorization = admin.authorization) => app.request("/v1/admin/embodied-bounties", {
        method: "POST", headers: { ...admin, authorization }, body: JSON.stringify(body),
      });
      const term = { eggId: "egg-bazaar-02", clue: "Look near the Tea House", payload: "Compass", amountCents: 100 };
      expect((await publish(term, `Bearer ${winner.token}`)).status).toBe(401);
      expect((await publish({ ...term, ownerId: winner.owner.id })).status).toBe(400);
      const created = await publish(term);
      expect(created.status).toBe(201);
      const { bounty } = await created.json() as { bounty: { id: string } };
      contestId = bounty.id;
      paypal = mockCashPaypal(contestId, mode, winner.owner.email);
      expect((await publish(term)).status).toBe(409);
      const path = `/v1/admin/embodied-bounties/${contestId}/payout`;
      const send = (body: unknown) => app.request(path, { method: "POST", headers: admin, body: JSON.stringify(body) });
      expect((await send(approval)).status).toBe(404);
      await db.insert(eggHuntWins).values({ contestId, agentId: agent.id, ownerId: winner.owner.id, payload: "Compass", credits: 0 });
      expect((await send(approval)).status).toBe(404);
      expect(paypal.batches).toBe(0);
      await db.update(owners).set({ emailVerified: true }).where(eq(owners.id, winner.owner.id));

      const preview = await app.request(path, { headers: admin });
      expect(preview.status).toBe(200);
      expect(await preview.json()).toMatchObject({ ...approval, currency: "USD", payout: null });
      expect((await app.request(path, {
        method: "POST", headers: { ...admin, authorization: `Bearer ${winner.token}` }, body: JSON.stringify(approval),
      })).status).toBe(401);
      expect((await send({ ...approval, amountCents: 200 })).status).toBe(422);
      expect((await send({ ...approval, mode: mode === "live" ? "sandbox" : "live" })).status).toBe(422);
      expect((await send({ ...approval, ownerId: outsider.owner.id })).status).toBe(422);
      expect(paypal.batches).toBe(0);

      const [submit, concurrent] = await Promise.all([send(approval), send(approval)]);
      expect(submit.status).toBe(200);
      const { payout } = await submit.json() as { payout: { id: string; status: string; transaction_id: string | null } };
      expect(payout).toMatchObject({ status: "processing", transaction_id: null });
      expect(await concurrent.json()).toMatchObject({ payout: { id: payout.id } });
      expect(await (await send(approval)).json()).toMatchObject({ payout: { id: payout.id } });
      expect(paypal.batches).toBe(1);

      const settled = await app.request(`/v1/admin/payouts/${payout.id}`, { headers: admin });
      expect(await settled.json()).toMatchObject({ payout: { status: "success", transaction_id: "TEST-TRANSACTION" } });
      const ownerPath = `/owners/agents/${agent.id}/hunt-receipts`;
      expect((await app.request(ownerPath, { headers: { authorization: `Bearer ${outsider.token}` } })).status).toBe(404);
      const ownerReceipt = await app.request(ownerPath, { headers: { authorization: `Bearer ${winner.token}` } });
      expect(await ownerReceipt.json()).toMatchObject({ receipts: [{
        contestId, payload: "Compass",
        cashPayout: { amountCents: 100, currency: "USD", mode, status: "success", transactionId: "TEST-TRANSACTION" },
      }] });
    } finally {
      if (contestId) {
        await db.delete(eggHuntWins).where(eq(eggHuntWins.contestId, contestId));
        await db.delete(eggCashBounties).where(eq(eggCashBounties.id, contestId));
      }
      await db.delete(agents).where(eq(agents.id, agent.id));
    }
  });

  test("mode off: hunt routes are absent", async () => {
    // Explicitly off (afterEach restores the ambient value): this test
    // must hold even inside a suite run with the mode exported globally.
    delete process.env.AIVERSE_HUNT_MODE;
    const app = createApp();
    const res = await app.request("/v1/events");
    expect(res.status).toBe(404);
  });

  test("mode on: mounted app answers /v1/events; gateway /health stays authoritative", async () => {
    enableHunt();
    const app = createApp();
    const events = await app.request("/v1/events");
    expect(events.status).toBe(200);
    const body = await events.json();
    expect(Array.isArray(body.events)).toBe(true);

    const health = await app.request("/health");
    expect(health.status).toBe(200);
    const hbody = await health.json();
    // Gateway shape ({status, db, redis, natives}), NOT the hunt app's
    // standalone {ok, version, server_time} — registration order wins.
    expect(hbody.status).toBe("ok");
    expect(hbody.db).toBe("ok");
    expect(hbody.ok).toBeUndefined();
  });

  test("gateway JWT: first sight creates the hunt user, stable afterwards", async () => {
    enableHunt();
    const app = createApp();
    const email = `hunt-mount-${Date.now()}@example.com`;
    const { owner, token } = await makeOwner(email);

    const first = await app.request("/v1/me", { headers: { Authorization: `Bearer ${token}` } });
    expect(first.status).toBe(200);
    const me1 = await first.json();
    expect(me1.email).toBe(email);

    const second = await app.request("/v1/me", { headers: { Authorization: `Bearer ${token}` } });
    const me2 = await second.json();
    expect(me2.id).toBe(me1.id);

    const rt = getHuntRuntime();
    const row = rt!.db.query("SELECT gateway_owner_id FROM hunt_users WHERE id = ?").get(me1.id) as {
      gateway_owner_id: string;
    };
    expect(row.gateway_owner_id).toBe(owner.id);
  });

  test("adoption: a magic-link account with the owner's email is adopted, not duplicated", async () => {
    enableHunt();
    const app = createApp();
    const email = `hunt-adopt-${Date.now()}@example.com`;

    // Magic-link leg (fallback identity): link lands in the outbox file
    // beside the hunt DB (embedded stub posture).
    const req = await app.request("/v1/auth/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    expect(req.status).toBe(202);
    const outbox = readFileSync(join(dir, "dev-outbox.jsonl"), "utf8").trim().split("\n");
    const link = JSON.parse(outbox[outbox.length - 1]).link as string;
    const magicToken = new URL(link).searchParams.get("token")!;

    const consume = await app.request(`/v1/auth/consume?token=${encodeURIComponent(magicToken)}`);
    expect(consume.status).toBe(302);
    const session = new URL(consume.headers.get("location")!).hash.split("hunt_session=")[1];
    const viaSession = await app.request("/v1/me", {
      headers: { Authorization: `Bearer ${decodeURIComponent(session)}` },
    });
    expect(viaSession.status).toBe(200);
    const sessionMe = await viaSession.json();
    expect(sessionMe.email).toBe(email);

    // Gateway leg: same email behind an owner JWT adopts the same row.
    const { owner, token } = await makeOwner(email);
    const viaJwt = await app.request("/v1/me", { headers: { Authorization: `Bearer ${token}` } });
    expect(viaJwt.status).toBe(200);
    const jwtMe = await viaJwt.json();
    expect(jwtMe.id).toBe(sessionMe.id);

    const rt = getHuntRuntime();
    const row = rt!.db.query("SELECT gateway_owner_id FROM hunt_users WHERE id = ?").get(sessionMe.id) as {
      gateway_owner_id: string;
    };
    expect(row.gateway_owner_id).toBe(owner.id);
  });

  test("a non-gateway bearer token is rejected (no silent identity)", async () => {
    enableHunt();
    const app = createApp();
    const jwtShaped = await app.request("/v1/me", {
      headers: { Authorization: "Bearer aaa.bbb.ccc" },
    });
    expect(jwtShaped.status).toBe(401);
    const opaque = await app.request("/v1/me", { headers: { Authorization: "Bearer not-a-token" } });
    expect(opaque.status).toBe(401);
  });

  test("leader ticker job transitions a scheduled event to live", async () => {
    enableHunt();
    const rt = getHuntRuntime();
    expect(rt).not.toBeNull();
    const now = Date.now();
    rt!.db
      .query(
        `INSERT INTO events (id, slug, title, district, starts_at, ends_at, state, pool_cap_cents, claim_radius_m, tier, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'scheduled', 100, 1.5, 'major', 'test', ?)`,
      )
      .run("evt-mount-1", "mount-smoke", "Mount Smoke", "bazaar", now - 1000, now + 600_000, now);

    scheduleHuntTicker();
    await new Promise((r) => setTimeout(r, 1400));

    const row = rt!.db.query("SELECT state FROM events WHERE id = ?").get("evt-mount-1") as {
      state: string;
    };
    expect(row.state).toBe("live");
    const starts = rt!.db
      .query("SELECT COUNT(*) AS n FROM announcements WHERE event_id = ? AND type = 'hunt_start'")
      .get("evt-mount-1") as { n: number };
    expect(starts.n).toBe(1);
  });
});
