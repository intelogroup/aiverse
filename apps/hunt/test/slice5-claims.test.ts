import { describe, expect, test } from "bun:test";
import { RateLimiter } from "../src/claims";
import {
  adminCreateEvent,
  adminSeedPrize,
  forceLive,
  makeHarness,
  makeUser,
  req,
  type Harness,
} from "./helpers";

const SPOT = { x: 10, y: 0.2, z: 10 };

async function liveEventWithPrize(h: Harness, code = "WINNER-CODE-1") {
  const ev = await adminCreateEvent(h);
  await adminSeedPrize(h, ev.id, {
    label_public: "a $10 gift code",
    kind: "gift_code",
    face_value_cents: 1000,
    ...SPOT,
    code,
  });
  forceLive(h, ev.id);
  return ev;
}

const claimBody = (eventId: string, pos = SPOT) => ({
  event_id: eventId,
  body_id: "remy",
  position: pos,
  client_ts: Date.now(),
});

describe("slice 5 — claims", () => {
  test("win path: code revealed to the winner only; prize, ledger, announcement settle", async () => {
    const h = makeHarness();
    const ev = await liveEventWithPrize(h);
    const winner = await makeUser(h, "winner@example.com");
    const r = await req(h.app, "POST", "/v1/claims", {
      token: winner.session,
      body: claimBody(ev.id, { x: 10.4, y: 0.2, z: 10.3 }),
    });
    expect(r.status).toBe(200);
    expect(r.json.result).toBe("won");
    expect(r.json.code).toBe("WINNER-CODE-1");
    expect(r.json.prize.label).toBe("a $10 gift code");
    expect(JSON.stringify(r.json)).not.toContain('"x"'); // no coordinates in the verdict

    const prize = h.db.query("SELECT state, claimed_by_user_id FROM prizes WHERE event_id = ?").get(ev.id) as {
      state: string;
      claimed_by_user_id: string;
    };
    expect(prize.state).toBe("claimed");
    expect(prize.claimed_by_user_id).toBe(winner.userId);
    const award = h.db
      .query("SELECT COUNT(*) AS n FROM pool_ledger WHERE event_id = ? AND entry_type = 'claim_award'")
      .get(ev.id) as { n: number };
    expect(award.n).toBe(1);
    const ann = h.db
      .query("SELECT payload_json FROM announcements WHERE event_id = ? AND type = 'prize_claimed'")
      .get(ev.id) as { payload_json: string };
    expect(ann.payload_json).toContain("winner"); // display name (email prefix)
    expect(ann.payload_json).not.toContain("WINNER-CODE-1");
    expect(ann.payload_json).not.toContain("10.4");

    // Winner re-read works; a second hunter sees nothing.
    const wins = await req(h.app, "GET", "/v1/me/wins", { token: winner.session });
    expect(wins.json.wins).toHaveLength(1);
    expect(wins.json.wins[0].code).toBe("WINNER-CODE-1");
    const other = await makeUser(h, "other@example.com");
    const otherWins = await req(h.app, "GET", "/v1/me/wins", { token: other.session });
    expect(otherWins.json.wins).toHaveLength(0);
  });

  test("second hunter at the spot gets already_claimed; elsewhere gets no_prize_in_radius", async () => {
    const h = makeHarness();
    const ev = await liveEventWithPrize(h);
    const a = await makeUser(h, "a@example.com");
    await req(h.app, "POST", "/v1/claims", { token: a.session, body: claimBody(ev.id) });
    const b = await makeUser(h, "b@example.com");
    const second = await req(h.app, "POST", "/v1/claims", { token: b.session, body: claimBody(ev.id) });
    expect(second.json.result).toBe("already_claimed");
    expect(second.json.code).toBeUndefined();
    const far = await req(h.app, "POST", "/v1/claims", {
      token: b.session,
      body: claimBody(ev.id, { x: -100, y: 0, z: -100 }),
    });
    // b claimed 0ms ago → rate limiter answers first; use a fresh user for the far check.
    void far;
    const c = await makeUser(h, "c@example.com");
    const farC = await req(h.app, "POST", "/v1/claims", {
      token: c.session,
      body: claimBody(ev.id, { x: -100, y: 0, z: -100 }),
    });
    expect(farC.json.result).toBe("no_prize_in_radius");
  });

  test("window: claims before the event is live get event_not_live (409)", async () => {
    const h = makeHarness();
    const now = Date.now();
    const ev = await adminCreateEvent(h, { starts_at: now + 3_600_000, ends_at: now + 7_200_000 });
    await adminSeedPrize(h, ev.id, {
      label_public: "future",
      kind: "gift_code",
      face_value_cents: 100,
      ...SPOT,
      code: "FUTURE",
    });
    h.db.query("UPDATE events SET state = 'scheduled' WHERE id = ?").run(ev.id);
    const u = await makeUser(h, "early@example.com");
    const r = await req(h.app, "POST", "/v1/claims", { token: u.session, body: claimBody(ev.id) });
    expect(r.status).toBe(409);
    expect(r.json.result).toBe("event_not_live");
  });

  test("speed: a teleport between samples is too_fast and cannot win", async () => {
    // Zero-interval limiter seam: the spec checks rate limits BEFORE speed
    // (§6.2 order), so isolating the speed verdict needs the limiter open.
    const h = makeHarness(":memory:", new RateLimiter(0, 10_000, 100_000));
    const ev = await liveEventWithPrize(h);
    const u = await makeUser(h, "speedy@example.com");
    // First sample at origin via a ping.
    const ping = await req(h.app, "POST", "/v1/positions", {
      token: u.session,
      body: claimBody(ev.id, { x: 0, y: 0, z: 0 }),
    });
    expect(ping.status).toBe(204);
    // Instant jump 800+ m to the prize spot — far beyond remy's cap × 1.25.
    const r = await req(h.app, "POST", "/v1/claims", { token: u.session, body: claimBody(ev.id) });
    expect(r.json.result).toBe("too_fast");
    const prize = h.db.query("SELECT state FROM prizes WHERE event_id = ?").get(ev.id) as { state: string };
    expect(prize.state).toBe("seeded");
  });

  test("rate limit: a second attempt inside 2 s is rate_limited (429)", async () => {
    const h = makeHarness();
    const ev = await liveEventWithPrize(h);
    const u = await makeUser(h, "eager@example.com");
    const far = { x: -50, y: 0, z: -50 };
    const first = await req(h.app, "POST", "/v1/claims", { token: u.session, body: claimBody(ev.id, far) });
    expect(first.json.result).toBe("no_prize_in_radius");
    const second = await req(h.app, "POST", "/v1/claims", { token: u.session, body: claimBody(ev.id, far) });
    expect(second.status).toBe(429);
    expect(second.json.result).toBe("rate_limited");
    expect(second.json.retry_after_s).toBeGreaterThanOrEqual(1);
  });

  test("suspended users are blocked (403)", async () => {
    const h = makeHarness();
    const ev = await liveEventWithPrize(h);
    const u = await makeUser(h, "fraud@example.com");
    await req(h.app, "POST", `/v1/admin/users/${u.userId}/suspend`, { admin: true });
    const r = await req(h.app, "POST", "/v1/claims", { token: u.session, body: claimBody(ev.id) });
    expect(r.status).toBe(403);
    expect(r.json.result).toBe("suspended_user");
  });

  test("I4: public surfaces carry no coordinates and no other user's email", async () => {
    const h = makeHarness();
    const ev = await liveEventWithPrize(h);
    const state = await req(h.app, "GET", `/v1/events/${ev.slug}/state`);
    const list = await req(h.app, "GET", "/v1/events");
    const blob = JSON.stringify(state.json) + JSON.stringify(list.json);
    expect(blob).not.toContain("winner@");
    expect(blob).not.toContain('"x"');
    expect(blob).not.toContain("10"); // no coordinate leakage via counts either (total=1)
    expect(state.json.prizes_total).toBe(1);
  });

  test("CONCURRENCY GATE: 50 parallel claims → exactly one winner", async () => {
    const h = makeHarness();
    const ev = await liveEventWithPrize(h);
    const users = await Promise.all(
      Array.from({ length: 50 }, (_, i) => makeUser(h, `stampede${i}@example.com`)),
    );
    const results = await Promise.all(
      users.map((u) => req(h.app, "POST", "/v1/claims", { token: u.session, body: claimBody(ev.id) })),
    );
    const won = results.filter((r) => r.json?.result === "won");
    const honest = results.filter((r) => r.json && r.json.result !== "won");
    expect(won).toHaveLength(1);
    expect(honest).toHaveLength(49);
    for (const r of honest) expect(r.json.result).toBe("already_claimed");
    expect(won[0].json.code).toBe("WINNER-CODE-1");
    const wonRows = h.db
      .query("SELECT COUNT(*) AS n FROM claim_attempts WHERE event_id = ? AND verdict = 'won'")
      .get(ev.id) as { n: number };
    expect(wonRows.n).toBe(1);
    const awards = h.db
      .query("SELECT COUNT(*) AS n FROM pool_ledger WHERE event_id = ? AND entry_type = 'claim_award'")
      .get(ev.id) as { n: number };
    expect(awards.n).toBe(1);
  });

  test("continuous checks (delta 1): a position ping on the spot wins; a far ping is a silent 204", async () => {
    const h = makeHarness();
    const ev = await liveEventWithPrize(h, "PING-CODE-9");
    const u = await makeUser(h, "walker@example.com");
    const far = await req(h.app, "POST", "/v1/positions", {
      token: u.session,
      body: claimBody(ev.id, { x: 0, y: 0, z: 0 }),
    });
    expect(far.status).toBe(204);
    // Walk plausibly: origin → near → spot, spaced by hand via samples at
    // increasing positions within remy's cap over the elapsed wall time is
    // not possible in a fast test — instead the win ping is the user's
    // second-ever sample pair at short range: origin (0,0) to (9,9) is
    // 12.7 m; with the 250 ms floor that reads 50 m/s. Use a body whose
    // first sample IS the spot: fresh user, first contact is the win ping.
    const v = await makeUser(h, "arriver@example.com");
    const win = await req(h.app, "POST", "/v1/positions", { token: v.session, body: claimBody(ev.id) });
    expect(win.status).toBe(200);
    expect(win.json.result).toBe("won");
    expect(win.json.code).toBe("PING-CODE-9");
    const attempt = h.db
      .query("SELECT via, verdict FROM claim_attempts WHERE event_id = ? AND verdict = 'won'")
      .get(ev.id) as { via: string; verdict: string };
    expect(attempt.via).toBe("ping");
    void u;
  });

  test("limiter is configurable (test seam): zero-interval limiter never rate-limits back-to-back claims", async () => {
    const h = makeHarness(":memory:", new RateLimiter(0, 10_000, 100_000));
    const ev = await liveEventWithPrize(h);
    const u = await makeUser(h, "rapid@example.com");
    const far = { x: -50, y: 0, z: -50 };
    for (let i = 0; i < 3; i++) {
      const r = await req(h.app, "POST", "/v1/claims", { token: u.session, body: claimBody(ev.id, far) });
      expect(r.json.result).toBe("no_prize_in_radius");
    }
  });
});
