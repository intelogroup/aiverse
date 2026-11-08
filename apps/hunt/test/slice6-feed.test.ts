import { afterAll, describe, expect, test } from "bun:test";
import { tickOnce } from "../src/ticker";
import {
  adminCreateEvent,
  adminSeedPrize,
  makeHarness,
  makeUser,
  req,
  type Harness,
} from "./helpers";

interface SseEvent {
  event: string;
  data: string;
}

async function openFeed(url: string, token?: string): Promise<{ events: SseEvent[]; close: () => void }> {
  const ctrl = new AbortController();
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: ctrl.signal,
  });
  if (!res.ok || !res.body) throw new Error(`feed status ${res.status}`);
  const events: SseEvent[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = "message";
          const dataLines: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length) events.push({ event, data: dataLines.join("\n") });
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return { events, close: () => ctrl.abort() };
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitFor timed out");
}

describe("slice 6 — announcements + counter", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  afterAll(() => server?.stop(true));

  test("scripted run: start → hint → claim → progress hint → end, counter + ETag live", async () => {
    const h: Harness = makeHarness();
    server = Bun.serve({ port: 0, fetch: h.app.fetch, idleTimeout: 255 });
    const base = `http://localhost:${server.port}`;
    const now = Date.now();

    const ev = await adminCreateEvent(h, {
      slug: "feed-event",
      starts_at: now - 1000,
      ends_at: now + 3_600_000,
    });
    await adminSeedPrize(h, ev.id, {
      label_public: "prize one",
      kind: "gift_code",
      face_value_cents: 500,
      x: 10,
      y: 0,
      z: 10,
      code: "FEED-CODE-1",
    });
    await adminSeedPrize(h, ev.id, {
      label_public: "prize two",
      kind: "gift_code",
      face_value_cents: 500,
      x: -30,
      y: 0,
      z: -30,
      code: "FEED-CODE-2",
    });
    // Time hint already due; progress hint scheduled far in the future.
    await req(h.app, "POST", `/v1/admin/events/${ev.id}/hints:bulk`, {
      admin: true,
      body: {
        hints: [
          { tier: "district", text: "Somewhere in the Bazaar", fires_at: now - 500 },
          {
            tier: "room",
            text: "Half the pool is gone — think presses",
            fires_at: now + 3_500_000,
            progress_kind: "prizes_claimed_fraction",
            progress_value: 0.5,
          },
        ],
      },
    });
    h.db.query("UPDATE events SET state = 'scheduled' WHERE id = ?").run(ev.id);

    const hunter = await makeUser(h, "feedhunter@example.com");
    const pubFeed = await openFeed(`${base}/v1/events/feed-event/feed`);
    const privFeed = await openFeed(`${base}/v1/feed`, hunter.session);

    // Counter before start.
    const s0 = await req(h.app, "GET", "/v1/events/feed-event/state");
    expect(s0.json.prizes_total).toBe(2);
    expect(s0.json.prizes_claimed).toBe(0);
    const etag0 = s0.headers.get("ETag");

    // Tick: event goes live, hunt_start + private ping + district hint fire.
    tickOnce(h.db, Date.now());
    await waitFor(() => pubFeed.events.some((e) => e.event === "hunt_start"));
    const start = pubFeed.events.find((e) => e.event === "hunt_start")!;
    const startPayload = JSON.parse(start.data);
    expect(startPayload.tier).toBe("major");
    expect(startPayload.event_slug).toBe("feed-event");
    await waitFor(() => pubFeed.events.some((e) => e.event === "hint"));
    await waitFor(() => privFeed.events.some((e) => e.event === "ping"));
    // The public feed never carries private pings.
    expect(pubFeed.events.some((e) => e.event === "ping")).toBe(false);

    // Claim prize one → prize_claimed on the public feed, no code, no coords.
    const win = await req(h.app, "POST", "/v1/claims", {
      token: hunter.session,
      body: { event_id: ev.id, body_id: "remy", position: { x: 10, y: 0, z: 10 }, client_ts: Date.now() },
    });
    expect(win.json.result).toBe("won");
    await waitFor(() => pubFeed.events.some((e) => e.event === "prize_claimed"));
    const claimedEv = pubFeed.events.find((e) => e.event === "prize_claimed")!;
    expect(claimedEv.data).toContain("feedhunter");
    expect(claimedEv.data).not.toContain("FEED-CODE-1");
    expect(claimedEv.data).not.toContain('"x"');

    // Counter moved + ETag rotated + 304 works.
    const s1 = await req(h.app, "GET", "/v1/events/feed-event/state");
    expect(s1.json.prizes_claimed).toBe(1);
    expect(s1.json.prizes_remaining).toBe(1);
    const etag1 = s1.headers.get("ETag");
    expect(etag1).not.toBe(etag0);
    const cached = await h.app.request("/v1/events/feed-event/state", {
      headers: { "If-None-Match": etag1! },
    });
    expect(cached.status).toBe(304);

    // Progress pacing (delta 3): the room hint fires NOW, ~58 min early,
    // because half the pool is claimed.
    tickOnce(h.db, Date.now());
    await waitFor(
      () => pubFeed.events.filter((e) => e.event === "hint").length >= 2,
    );
    const roomHint = h.db
      .query("SELECT fired_at FROM hint_schedule WHERE event_id = ? AND tier = 'room'")
      .get(ev.id) as { fired_at: number };
    expect(roomHint.fired_at).not.toBeNull();

    // End the event: hunt_end fires; the unclaimed prize expires back to the pool.
    const end = await req(h.app, "POST", `/v1/admin/events/${ev.id}/end`, { admin: true });
    expect(end.json.state).toBe("ended");
    await waitFor(() => pubFeed.events.some((e) => e.event === "hunt_end"));
    const endPayload = JSON.parse(pubFeed.events.find((e) => e.event === "hunt_end")!.data);
    expect(endPayload.claimed_count).toBe(1);
    expect(endPayload.total_count).toBe(2);
    const expired = h.db
      .query("SELECT COUNT(*) AS n FROM prizes WHERE event_id = ? AND state = 'expired'")
      .get(ev.id) as { n: number };
    expect(expired.n).toBe(1);
    const returns = h.db
      .query("SELECT COUNT(*) AS n FROM pool_ledger WHERE event_id = ? AND entry_type = 'expire_return'")
      .get(ev.id) as { n: number };
    expect(returns.n).toBe(1);

    pubFeed.close();
    privFeed.close();
  }, 30000);

  test("catch-up: ?after= replays the outbox from an id", async () => {
    const h: Harness = makeHarness();
    server = Bun.serve({ port: 0, fetch: h.app.fetch, idleTimeout: 255 });
    const base = `http://localhost:${server.port}`;
    const now = Date.now();
    const ev = await adminCreateEvent(h, {
      slug: "replay-event",
      starts_at: now - 1000,
      ends_at: now + 3_600_000,
    });
    h.db.query("UPDATE events SET state = 'scheduled' WHERE id = ?").run(ev.id);
    tickOnce(h.db, Date.now());
    const first = h.db.query("SELECT MIN(id) AS id FROM announcements").get() as { id: number };
    const feed = await openFeed(`${base}/v1/events/replay-event/feed?after=${first.id}`);
    await new Promise((r) => setTimeout(r, 1200));
    // after= the hunt_start id → it is NOT replayed.
    expect(feed.events.some((e) => e.event === "hunt_start")).toBe(false);
    feed.close();
    const feed2 = await openFeed(`${base}/v1/events/replay-event/feed?after=0`);
    await waitFor(() => feed2.events.some((e) => e.event === "hunt_start"));
    feed2.close();
  }, 30000);
});
