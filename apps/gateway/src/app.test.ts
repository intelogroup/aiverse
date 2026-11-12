import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { db } from "./db/client";
import { agents, conversations, messages } from "@aiverse/shared/schema";

describe("health", () => {
  test("GET /health pings DB and Redis, returns ok when both are up", async () => {
    const app = createApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.db).toBe("ok");
    expect(body.redis).toBe("ok");
    // native liveness never gates the HTTP status/overall status — see app.ts.
    expect(["active", "stale", "unknown"]).toContain(body.natives);
    // which process leads the singleton jobs (a second gateway on the same database shows up here)
    expect(["leader", "follower"]).toContain(body.role);
  });

  test("GET /health reuses cached probes within AIVERSE_HEALTH_PROBE_CACHE_MS, re-probes after", async () => {
    process.env.AIVERSE_HEALTH_PROBE_CACHE_MS = "1500";
    let nativeId: string | undefined;
    let convId: string | undefined;
    try {
      const app = createApp();
      const first = await (await app.request("/health")).json();

      // A native message lands AFTER the first probe. Within the TTL the
      // cached snapshot must be served unchanged; after expiry a fresh
      // probe must see the message and flip natives to "active".
      const [native] = await db
        .insert(agents)
        .values({ name: `HealthCacheNative-${Date.now()}`, agentCard: {}, apiKeyHash: `hc-${Date.now()}`, status: "online", isNative: true })
        .returning();
      nativeId = native.id;
      const [conv] = await db
        .insert(conversations)
        .values({ kind: "room", isPublic: true })
        .returning();
      convId = conv.id;
      await db.insert(messages).values({ conversationId: conv.id, senderAgentId: native.id, content: "health cache probe" });

      const second = await (await app.request("/health")).json();
      expect(second.natives).toBe(first.natives);
      expect(second.db).toBe(first.db);

      await new Promise((r) => setTimeout(r, 1600));
      const third = await (await app.request("/health")).json();
      expect(third.natives).toBe("active");
    } finally {
      delete process.env.AIVERSE_HEALTH_PROBE_CACHE_MS;
      // Shared test DB: a stray isNative agent breaks nativeAgents.test.ts's
      // cooldown-roster assertion — remove everything this test seeded.
      if (convId) await db.delete(messages).where(eq(messages.conversationId, convId));
      if (convId) await db.delete(conversations).where(eq(conversations.id, convId));
      if (nativeId) await db.delete(agents).where(eq(agents.id, nativeId));
    }
  });
});

// 2026-11-09 security audit, L1: the gateway set no security headers at
// all (no HSTS, no nosniff, no frame protection, no Referrer-Policy).
describe("security headers", () => {
  function expectSecurityHeaders(res: Response) {
    expect(res.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  }

  test("present on a normal response", async () => {
    const app = createApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
  });

  test("present on an error response too", async () => {
    const app = createApp();
    const res = await app.request("/no-such-route");
    expect(res.status).toBe(404);
    expectSecurityHeaders(res);
  });

  test("CORS whitelist behavior is unchanged alongside the headers", async () => {
    const app = createApp();
    const res = await app.request("/health", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5183",
        "access-control-request-method": "GET",
      },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5183");
    expectSecurityHeaders(res);

    const evil = await app.request("/health", {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example.com",
        "access-control-request-method": "GET",
      },
    });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });
});
