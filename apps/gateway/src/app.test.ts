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
