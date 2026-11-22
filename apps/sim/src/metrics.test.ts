import { describe, expect, test } from "bun:test";
import { RollingWindow, routeClass } from "./metrics";
import { createSimServer, SIM_API_VERSION } from "./server";
import type { WorldService } from "@aiverse/world-sim/worldService";

describe("RollingWindow", () => {
  test("percentiles, max and status counts over 100 samples", () => {
    const w = new RollingWindow();
    for (let i = 1; i <= 100; i++) w.record(5_000, i, i <= 3 ? 429 : i === 4 ? 503 : 200);
    const s = w.summary(5_000);
    expect(s.n).toBe(100);
    expect(s.max).toBe(100);
    expect(s.p50).toBeGreaterThanOrEqual(50);
    expect(s.p50).toBeLessThanOrEqual(63); // histogram bucket upper bound, <= 25% over
    expect(s.p99).toBeGreaterThanOrEqual(99);
    expect(s.p99).toBeLessThanOrEqual(100);
    expect([s.rateLimited, s.worldFull]).toEqual([3, 1]);
  });

  test("samples older than 60 s drop out, reused slots reset", () => {
    const w = new RollingWindow();
    w.record(1_000, 10, 429);
    expect(w.summary(60_999).n).toBe(1); // second 1 is still inside the window at second 60
    expect(w.summary(61_000).n).toBe(0);
    w.record(61_000, 3); // same slot index as second 1: must not inherit it
    const s = w.summary(61_000);
    expect([s.n, s.rateLimited, s.max]).toEqual([1, 0, 3]);
  });

  test("empty window is zeros; routeClass", () => {
    expect(new RollingWindow().summary(0)).toEqual({ n: 0, p50: 0, p99: 0, max: 0, rateLimited: 0, worldFull: 0 });
    expect(routeClass("GET", "/bodies/abc/observe")).toBe("observe");
    expect(routeClass("POST", "/bodies/abc/act")).toBe("act");
    expect(routeClass("GET", "/bodies/abc/act/x")).toBe("other");
    expect(routeClass("GET", "/stats")).toBe("other");
  });
});

describe("GET /stats", () => {
  const SECRET = "s".repeat(40);
  let clock = 1_000_000;
  // /stats and the rate limiter never touch the world: a stub service keeps this test off the City 3 load.
  const service = { bodyCount: 7, sim: { ready: true, t: 0 }, observe: () => ({}) } as unknown as WorldService;
  const app = createSimServer({ service, secret: SECRET, now: () => clock, readPerS: 5, maxBodies: 200, tickMs: 50 });
  const call = (path: string, h: Record<string, string> = {}) =>
    app.fetch(new Request(`http://sim${path}`, { headers: { authorization: `Bearer ${SECRET}`, "x-sim-api": String(SIM_API_VERSION), ...h } }));

  test("same auth and version gate as every route", async () => {
    expect((await call("/stats", { authorization: "Bearer nope" })).status).toBe(401);
    expect((await call("/stats", { "x-sim-api": "1" })).status).toBe(426);
  });

  test("reports bodies, tick window and per-class request counts with 429s", async () => {
    for (let i = 0; i < 5; i++) app.recordTick(10 + i);
    for (let i = 0; i < 20; i++) await call("/bodies/a/observe"); // burst 10, then 429s (no time passes)
    await call("/healthz");
    const s = (await (await call("/stats")).json()) as any;
    expect(s).toMatchObject({ windowS: 60, bodies: 7, maxBodies: 200, tick: { budgetMs: 50, n: 5, max: 14 } });
    expect(s.requests.observe.n).toBe(20);
    expect(s.requests.observe.rateLimited).toBe(10);
    expect(s.requests.other.n).toBeGreaterThanOrEqual(1);
    expect(s.rssMb).toBeGreaterThan(0);
    clock += 61_000; // everything ages out
    const later = (await (await call("/stats")).json()) as any;
    expect([later.tick.n, later.requests.observe.n]).toEqual([0, 0]);
  });
});
