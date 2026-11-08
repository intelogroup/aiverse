import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { loadConfig } from "../src/config";
import { makeHarness, req } from "./helpers";

describe("slice 1 — skeleton", () => {
  test("config rejects an invalid port and a short code key", () => {
    expect(() => loadConfig({ HUNT_PORT: "abc" })).toThrow();
    expect(() => loadConfig({ HUNT_CODE_KEY: Buffer.alloc(8).toString("base64") })).toThrow();
    expect(() => loadConfig({ NODE_ENV: "production", HUNT_ADMIN_TOKEN: "x".repeat(20) })).toThrow(
      /HUNT_CODE_KEY/,
    );
  });

  test("db opens with migrations applied and body constants seeded", () => {
    const db = openDb(":memory:");
    const v = db.query("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBe(1);
    const remy = db.query("SELECT max_speed_mps FROM body_constants WHERE body_id = 'remy'").get() as {
      max_speed_mps: number;
    };
    // Measured in apps/console bodies.ts (BODY_REMY run speed, post-scale).
    expect(remy.max_speed_mps).toBeCloseTo(3.6894, 3);
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r: any) => r.name);
    for (const t of [
      "hunt_users",
      "auth_tokens",
      "events",
      "prizes",
      "claim_attempts",
      "position_samples",
      "payout_addresses",
      "hint_schedule",
      "pool_ledger",
      "announcements",
      "audit_log",
    ]) {
      expect(tables).toContain(t);
    }
  });

  test("service boots and /health answers 200", async () => {
    const h = makeHarness();
    const r = await req(h.app, "GET", "/health");
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(typeof r.json.server_time).toBe("number");
  });

  test("default claim radius is 1.5 m (hunt v0 delta 2)", async () => {
    const h = makeHarness();
    const { adminCreateEvent } = await import("./helpers");
    const ev = await adminCreateEvent(h);
    const row = h.db.query("SELECT claim_radius_m FROM events WHERE id = ?").get(ev.id) as {
      claim_radius_m: number;
    };
    expect(row.claim_radius_m).toBe(1.5);
  });
});
