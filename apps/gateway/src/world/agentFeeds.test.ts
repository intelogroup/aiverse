import { describe, expect, test } from "bun:test";
import {
  dedupeNews,
  drainFeeds,
  newsOff,
  newsOn,
  parseFeedItems,
  pushRadioLine,
  radioOff,
  radioOn,
  replaceNewsPool,
  stationListeners,
  topicsFor,
  type FeedStore,
  type NewsItem,
} from "./agentFeeds";

// In-memory FeedStore fake — the feeds state surface is Redis-shaped by
// design, so tests exercise the real logic hermetically.
class FakeStore implements FeedStore {
  kv = new Map<string, string>();
  lists = new Map<string, string[]>();
  sets = new Map<string, Set<string>>();
  async get(key: string) {
    return this.kv.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.kv.set(key, value);
  }
  async del(key: string) {
    this.kv.delete(key);
    this.lists.delete(key);
    this.sets.delete(key);
  }
  async rpush(key: string, value: string) {
    const list = this.lists.get(key) ?? [];
    list.push(value);
    this.lists.set(key, list);
  }
  async lrange(key: string, start: number, stop: number) {
    const list = this.lists.get(key) ?? [];
    return list.slice(start, stop === -1 ? undefined : stop + 1);
  }
  async ltrim(key: string, start: number, stop: number) {
    const list = this.lists.get(key) ?? [];
    this.lists.set(key, list.slice(start, stop === -1 ? undefined : stop + 1));
  }
  async expire() {}
  async sadd(key: string, member: string) {
    const set = this.sets.get(key) ?? new Set();
    set.add(member);
    this.sets.set(key, set);
  }
  async srem(key: string, member: string) {
    this.sets.get(key)?.delete(member);
  }
  async smembers(key: string) {
    return [...(this.sets.get(key) ?? new Set<string>())];
  }
  async scard(key: string) {
    return this.sets.get(key)?.size ?? 0;
  }
}

const item = (id: string, publishedMs: number, topics: string[] = ["world"]): NewsItem => ({
  id,
  title: `title-${id}`,
  summary: `summary-${id}`,
  source: "Test Wire",
  url: `https://example.test/${id}`,
  publishedMs,
  topics,
});

describe("radio subscriptions", () => {
  test("radio_on registers the listener; radio_off removes it", async () => {
    const s = new FakeStore();
    await radioOn("agent-a", "bbc-world-service", s);
    expect(await stationListeners("bbc-world-service", s)).toEqual(["agent-a"]);
    await radioOff("agent-a", s);
    expect(await stationListeners("bbc-world-service", s)).toEqual([]);
  });

  test("switching stations moves the listener", async () => {
    const s = new FakeStore();
    // Only one default station exists; simulate a switch off and back on.
    await radioOn("agent-a", "bbc-world-service", s);
    await radioOff("agent-a", s);
    await radioOn("agent-a", "bbc-world-service", s);
    expect(await stationListeners("bbc-world-service", s)).toEqual(["agent-a"]);
  });

  test("unknown station is refused", async () => {
    const s = new FakeStore();
    expect(radioOn("agent-a", "no-such-station", s)).rejects.toThrow("unknown station");
  });

  test("a pushed line reaches only that station's listeners, once", async () => {
    const s = new FakeStore();
    await radioOn("agent-a", "bbc-world-service", s);
    // agent-b never subscribed.
    const delivered = await pushRadioLine(
      { kind: "radio", station: "bbc-world-service", text: "the news at ten", at: Date.now() },
      s,
    );
    expect(delivered).toBe(1);
    const a = await drainFeeds("agent-a", s);
    expect(a.radio?.heard).toEqual(["the news at ten"]);
    // Delivered once: a second drain hears nothing new.
    const again = await drainFeeds("agent-a", s);
    expect(again.radio?.heard).toEqual([]);
    const b = await drainFeeds("agent-b", s);
    expect(b.radio).toBeNull();
  });
});

describe("news", () => {
  test("parseFeedItems extracts RSS items with topics", () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title>NASA announces a new moon study</title><link>https://example.test/1</link>
      <description>Research into lunar dust.</description><pubDate>Thu, 26 Nov 2026 10:00:00 GMT</pubDate></item>
      <item><title>Markets rally as bank shares climb</title><link>https://example.test/2</link>
      <description>Stocks rose on trade hopes.</description><pubDate>Thu, 26 Nov 2026 11:00:00 GMT</pubDate></item>
    </channel></rss>`;
    const items = parseFeedItems(xml, "Test Wire");
    expect(items).toHaveLength(2);
    expect(items[0].topics).toContain("science");
    expect(items[1].topics).toContain("business");
    expect(items[0].publishedMs).toBeGreaterThan(0);
  });

  test("topicsFor falls back to world", () => {
    expect(topicsFor("A quiet day in the valley", "Nothing much happened.")).toEqual(["world"]);
  });

  test("dedupeNews drops duplicate ids and sorts newest first", () => {
    const out = dedupeNews([item("a", 100), item("b", 300), item("a", 200)]);
    expect(out.map((i) => i.id)).toEqual(["b", "a"]);
  });

  test("news delivery respects the cursor and the topic filter", async () => {
    const s = new FakeStore();
    const now = Date.now();
    await replaceNewsPool(
      [item("stale", now - 3 * 3600_000), item("sci", now - 60_000, ["science"]), item("biz", now - 30_000, ["business"])],
      s,
    );
    // A fresh subscription snapshots the lookback window: the recent
    // science item arrives, the business one is filtered out, and the
    // 3-hour-old item predates the window.
    await newsOn("agent-a", ["science"], s);
    const first = await drainFeeds("agent-a", s);
    expect(first.news?.headlines.map((h) => h.title)).toEqual(["title-sci"]);
    // Cursor advanced: nothing is delivered twice.
    const second = await drainFeeds("agent-a", s);
    expect(second.news?.headlines).toEqual([]);
    await newsOff("agent-a", s);
    const off = await drainFeeds("agent-a", s);
    expect(off.news).toBeNull();
  });
});
