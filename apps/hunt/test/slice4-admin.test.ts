import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness, req } from "./helpers";

describe("slice 4 — events + admin", () => {
  test("admin routes require the admin token", async () => {
    const h = makeHarness();
    const noAuth = await req(h.app, "POST", "/v1/admin/events", {
      body: { slug: "x", title: "x", district: "x", starts_at: 0, ends_at: 1, pool_cap_cents: 1 },
    });
    expect(noAuth.status).toBe(401);
    const wrong = await h.app.request("/v1/admin/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer nope" },
      body: JSON.stringify({ slug: "x", title: "x", district: "x", starts_at: 0, ends_at: 1, pool_cap_cents: 1 }),
    });
    expect(wrong.status).toBe(401);
  });

  test("seeded codes never appear as plaintext in the raw DB file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunt-slice4-"));
    const dbPath = join(dir, "hunt.db");
    const h = makeHarness(dbPath);
    const ev = await req(h.app, "POST", "/v1/admin/events", {
      admin: true,
      body: {
        slug: "grep-event",
        title: "Grep",
        district: "Bazaar",
        starts_at: Date.now() - 1000,
        ends_at: Date.now() + 3_600_000,
        pool_cap_cents: 5000,
      },
    });
    expect(ev.status).toBe(201);
    const SECRET = "PLAINTEXT-CODE-XYZZY-123";
    const seeded = await req(h.app, "POST", `/v1/admin/events/${ev.json.id}/prizes:bulk`, {
      admin: true,
      body: {
        prizes: [
          { label_public: "a code", kind: "gift_code", face_value_cents: 500, x: 1, y: 2, z: 3, code: SECRET },
        ],
      },
    });
    expect(seeded.status).toBe(201);
    h.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    const raw = readFileSync(dbPath);
    expect(raw.includes(Buffer.from(SECRET))).toBe(false);
    // Sanity: the label (public data) IS in the file, so the grep is real.
    expect(raw.includes(Buffer.from("a code"))).toBe(true);
  });

  test("CLI-shaped flow: create → seed → schedule → public list + ledger", async () => {
    const h = makeHarness();
    const now = Date.now();
    const ev = await req(h.app, "POST", "/v1/admin/events", {
      admin: true,
      body: {
        slug: "flow-event",
        title: "Flow",
        district: "Bazaar",
        starts_at: now - 1000,
        ends_at: now + 3_600_000,
        pool_cap_cents: 5000,
      },
    });
    const id = ev.json.id;
    await req(h.app, "POST", `/v1/admin/events/${id}/prizes:bulk`, {
      admin: true,
      body: {
        prizes: [
          { label_public: "one", kind: "gift_code", face_value_cents: 700, x: 0, y: 0, z: 0, code: "C1" },
          { label_public: "two", kind: "coupon", face_value_cents: 300, x: 5, y: 0, z: 5, code: "C2" },
        ],
      },
    });
    const hints = await req(h.app, "POST", `/v1/admin/events/${id}/hints:bulk`, {
      admin: true,
      body: {
        hints: [
          { tier: "district", text: "Somewhere in the Bazaar", fires_at: now },
          {
            tier: "room",
            text: "A room with a press",
            progress_kind: "prizes_claimed_fraction",
            progress_value: 0.5,
          },
        ],
      },
    });
    expect(hints.status).toBe(201);
    const sched = await req(h.app, "POST", `/v1/admin/events/${id}/schedule`, { admin: true });
    expect(sched.json.state).toBe("live"); // window already open → ticker settles it

    const pub = await req(h.app, "GET", "/v1/events");
    const found = pub.json.events.find((e: any) => e.slug === "flow-event");
    expect(found).toBeTruthy();
    expect(found.state).toBe("live");

    const ledger = await req(h.app, "GET", `/v1/admin/events/${id}/ledger`, { admin: true });
    const seedSum = ledger.json.ledger
      .filter((l: any) => l.entry_type === "seed")
      .reduce((s: number, l: any) => s + l.amount_cents, 0);
    expect(seedSum).toBe(1000);

    // Progress fields were persisted on the hint row.
    const hint = h.db
      .query("SELECT progress_kind, progress_value FROM hint_schedule WHERE event_id = ? AND tier = 'room'")
      .get(id) as { progress_kind: string; progress_value: number };
    expect(hint.progress_kind).toBe("prizes_claimed_fraction");
    expect(hint.progress_value).toBe(0.5);
  });
});
