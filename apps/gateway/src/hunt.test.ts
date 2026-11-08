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
import { owners } from "@aiverse/shared/schema";
import { createApp } from "./app";
import { signOwnerSession } from "./auth/session";
import { db } from "./db/client";
import { getHuntRuntime, resetHuntRuntimeForTests, scheduleHuntTicker } from "./hunt";

const ENV_KEYS = ["AIVERSE_HUNT_MODE", "HUNT_DB_PATH", "HUNT_ADMIN_TOKEN"] as const;
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
