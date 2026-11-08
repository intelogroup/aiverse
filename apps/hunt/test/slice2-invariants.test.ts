import { describe, expect, test } from "bun:test";
import { evaluateClaim, RateLimiter } from "../src/claims";
import { adminCreateEvent, adminSeedPrize, forceLive, makeHarness, req } from "./helpers";

describe("slice 2 — data layer invariants", () => {
  test("I2: seeding beyond the pool cap fails atomically (zero partial rows)", async () => {
    const h = makeHarness();
    const ev = await adminCreateEvent(h, { pool_cap_cents: 1000 });
    const bulk = (prizes: unknown[]) =>
      req(h.app, "POST", `/v1/admin/events/${ev.id}/prizes:bulk`, { admin: true, body: { prizes } });
    const p = (label: string, cents: number) => ({
      label_public: label,
      kind: "gift_code",
      face_value_cents: cents,
      x: 0,
      y: 0,
      z: 0,
      code: `CODE-${label}`,
    });
    // 600 + 500 = 1100 > 1000 → whole batch rejected.
    const over = await bulk([p("a", 600), p("b", 500)]);
    expect(over.status).toBe(422);
    const count = h.db.query("SELECT COUNT(*) AS n FROM prizes WHERE event_id = ?").get(ev.id) as {
      n: number;
    };
    expect(count.n).toBe(0);
    const ledger = h.db
      .query("SELECT COUNT(*) AS n FROM pool_ledger WHERE event_id = ?")
      .get(ev.id) as { n: number };
    expect(ledger.n).toBe(0);
    // 600 + 400 fits exactly; one more cent breaks it.
    expect((await bulk([p("a", 600), p("b", 400)])).status).toBe(201);
    expect((await bulk([p("c", 1)])).status).toBe(422);
  });

  test("I1: the partial unique index exists and refuses a second winner", async () => {
    const h = makeHarness();
    const idx = h.db
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_one_winner'")
      .get();
    expect(idx).not.toBeNull();
    const ev = await adminCreateEvent(h);
    await adminSeedPrize(h, ev.id, {
      label_public: "prize",
      kind: "gift_code",
      face_value_cents: 100,
      x: 0,
      y: 0,
      z: 0,
      code: "X",
    });
    const prize = h.db.query("SELECT id FROM prizes WHERE event_id = ?").get(ev.id) as { id: string };
    const insertWon = (user: string) =>
      h.db
        .query(
          `INSERT INTO claim_attempts (id, event_id, prize_id, user_id, x, y, z, body_id, received_at, verdict, via)
           VALUES (?, ?, ?, ?, 0, 0, 0, 'remy', ?, 'won', 'claim')`,
        )
        .run(crypto.randomUUID(), ev.id, prize.id, user, Date.now());
    insertWon("user-a");
    expect(() => insertWon("user-b")).toThrow();
  });

  test("I5: ledger reconciles — seeded = awarded + expired/voided + still-live", async () => {
    const h = makeHarness();
    const ev = await adminCreateEvent(h, { pool_cap_cents: 10_000 });
    for (const [label, cents] of [
      ["p1", 100],
      ["p2", 200],
      ["p3", 300],
    ] as const) {
      await adminSeedPrize(h, ev.id, {
        label_public: label,
        kind: "gift_code",
        face_value_cents: cents,
        x: 10,
        y: 0,
        z: 10,
        code: `CODE-${label}`,
      });
    }
    forceLive(h, ev.id);
    const evRow = h.db.query("SELECT * FROM events WHERE id = ?").get(ev.id) as any;
    const user = h.db
      .query("SELECT * FROM hunt_users WHERE email = 'i5@example.com'")
      .get() as any;
    const { makeUser } = await import("./helpers");
    const u = await makeUser(h, "i5@example.com");
    void user;
    const userRow = h.db.query("SELECT * FROM hunt_users WHERE id = ?").get(u.userId) as any;
    // Win p1 via the claim engine.
    const r = evaluateClaim(h.db, {
      user: userRow,
      event: evRow,
      bodyId: "remy",
      position: { x: 10, y: 0, z: 10 },
      clientTs: null,
      via: "claim",
      now: Date.now(),
      codeKey: h.codeKey,
      limiter: new RateLimiter(),
    });
    expect(r.result).toBe("won");
    // Void p2 through the admin endpoint.
    const p2 = h.db
      .query("SELECT id FROM prizes WHERE event_id = ? AND label_public = 'p2'")
      .get(ev.id) as { id: string };
    const v = await req(h.app, "POST", `/v1/admin/prizes/${p2.id}/void`, { admin: true });
    expect(v.status).toBe(200);

    const sums = h.db
      .query(
        `SELECT entry_type, COALESCE(SUM(amount_cents),0) AS s FROM pool_ledger WHERE event_id = ? GROUP BY entry_type`,
      )
      .all(ev.id) as { entry_type: string; s: number }[];
    const by = Object.fromEntries(sums.map((r) => [r.entry_type, r.s]));
    const stillLive = h.db
      .query(
        "SELECT COALESCE(SUM(face_value_cents),0) AS s FROM prizes WHERE event_id = ? AND state = 'seeded'",
      )
      .get(ev.id) as { s: number };
    expect(by.seed).toBe(600);
    expect(by.claim_award + by.void + (by.expire_return ?? 0) + stillLive.s).toBe(by.seed);
  });
});
