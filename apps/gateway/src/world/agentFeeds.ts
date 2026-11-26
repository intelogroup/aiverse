import { createHash } from "node:crypto";
import { redis } from "../redis/client";
import { log } from "../util/log";

// Real-world feeds for agents (owner design, 2026-11-26): radio and news
// as tools every agent has — radio_on/radio_off, news_on/news_off.
//
// - Radio: a live station's speech, transcribed and delivered as lines in
//   the listening agent's perception. Earpod model: ONLY the subscribed
//   agent receives its station's lines; nobody else hears them.
// - News: world headlines aggregated from open RSS wires into one pool;
//   a subscribed agent receives fresh items at observe time, filtered by
//   the topics it chose (empty = all topics).
// - Ephemeral by design (and by the feature's legal posture): lines and
//   headlines live ONLY in Redis with short TTLs, are delivered once
//   (observe drains them), never touch Postgres, and are never logged —
//   only counts and station ids are.
// - Cost gate: transcription runs only while at least one agent listens
//   to a station, and one transcription serves every listener on it.

export interface FeedStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: "EX", ttlSec?: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  rpush(key: string, value: string): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  expire(key: string, ttlSec: number): Promise<unknown>;
  sadd(key: string, member: string): Promise<unknown>;
  srem(key: string, member: string): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  scard(key: string): Promise<number>;
}

const store = (): FeedStore => redis as unknown as FeedStore;

// ---------------------------------------------------------------------------
// Stations and news sources (env-extensible; defaults verified live
// 2026-11-26: the BBC World Service stream pulls and transcribes cleanly).

export interface RadioStation {
  id: string;
  name: string;
  url: string;
  kind: "talk" | "news";
}

export const RADIO_STATIONS: RadioStation[] = (() => {
  try {
    const raw = process.env.AIVERSE_RADIO_STATIONS;
    if (raw) {
      const parsed = JSON.parse(raw) as RadioStation[];
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch {
    // A malformed override falls back to the defaults, never breaks boot.
  }
  return [
    {
      id: "bbc-world-service",
      name: "BBC World Service",
      url: "https://stream.live.vc.bbcmedia.co.uk/bbc_world_service",
      kind: "news" as const,
    },
  ];
})();

export function stationById(id: string): RadioStation | null {
  return RADIO_STATIONS.find((s) => s.id === id) ?? null;
}

export interface NewsSource {
  id: string;
  name: string;
  url: string;
}

export const NEWS_SOURCES: NewsSource[] = [
  { id: "bbc-world", name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { id: "npr-news", name: "NPR News", url: "https://feeds.npr.org/1001/rss.xml" },
  { id: "aljazeera", name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
];

// ---------------------------------------------------------------------------
// Subscription state (per agent, Redis only).

export interface FeedSubscription {
  radioStationId: string | null;
  newsTopics: string[] | null; // null = news off; [] = on, all topics
  newsCursorMs: number; // deliver pool items published after this
}

const subKey = (agentId: string) => `feeds:sub:${agentId}`;
const bufKey = (agentId: string) => `feeds:buf:${agentId}`;
const listenersKey = (stationId: string) => `feeds:radio:listeners:${stationId}`;
const NEWS_POOL_KEY = "feeds:news:pool";

const SUB_TTL_SEC = 24 * 3600; // a subscription forgotten for a day is off
const BUF_TTL_SEC = 10 * 60; // undelivered radio lines go stale fast
const BUF_CAP = 50;
const POOL_TTL_SEC = 3600;
const POOL_CAP = 300;

export async function getSubscription(
  agentId: string,
  s: FeedStore = store(),
): Promise<FeedSubscription> {
  const raw = await s.get(subKey(agentId));
  if (!raw) return { radioStationId: null, newsTopics: null, newsCursorMs: 0 };
  try {
    const parsed = JSON.parse(raw) as FeedSubscription;
    return {
      radioStationId: parsed.radioStationId ?? null,
      newsTopics: parsed.newsTopics ?? null,
      newsCursorMs: parsed.newsCursorMs ?? 0,
    };
  } catch {
    return { radioStationId: null, newsTopics: null, newsCursorMs: 0 };
  }
}

async function saveSubscription(
  agentId: string,
  sub: FeedSubscription,
  s: FeedStore,
): Promise<void> {
  await s.set(subKey(agentId), JSON.stringify(sub), "EX", SUB_TTL_SEC);
}

export async function radioOn(
  agentId: string,
  stationId: string,
  s: FeedStore = store(),
): Promise<FeedSubscription> {
  const station = stationById(stationId);
  if (!station) throw new Error(`unknown station: ${stationId}`);
  const sub = await getSubscription(agentId, s);
  if (sub.radioStationId && sub.radioStationId !== stationId) {
    await s.srem(listenersKey(sub.radioStationId), agentId);
  }
  sub.radioStationId = stationId;
  await s.sadd(listenersKey(stationId), agentId);
  await saveSubscription(agentId, sub, s);
  log("feeds_radio_on", { station: stationId });
  return sub;
}

export async function radioOff(
  agentId: string,
  s: FeedStore = store(),
): Promise<FeedSubscription> {
  const sub = await getSubscription(agentId, s);
  if (sub.radioStationId) {
    await s.srem(listenersKey(sub.radioStationId), agentId);
    sub.radioStationId = null;
  }
  await saveSubscription(agentId, sub, s);
  log("feeds_radio_off", {});
  return sub;
}

// A fresh subscription starts with a lookback snapshot — the latest
// headlines from the last two hours — then only genuinely new items.
// (Starting the cursor at "now" was tried first and heard nothing at
// all: wire items carry their publication time, which always predates
// the subscribe moment. Caught by the live proof, 2026-11-26.)
export const NEWS_LOOKBACK_MS = 2 * 3600_000;

export async function newsOn(
  agentId: string,
  topics: string[] = [],
  s: FeedStore = store(),
): Promise<FeedSubscription> {
  const sub = await getSubscription(agentId, s);
  const wasOff = sub.newsTopics === null;
  sub.newsTopics = topics.map((t) => t.toLowerCase().trim()).filter(Boolean);
  if (wasOff || !sub.newsCursorMs) sub.newsCursorMs = Date.now() - NEWS_LOOKBACK_MS;
  await saveSubscription(agentId, sub, s);
  log("feeds_news_on", { topics: sub.newsTopics.length });
  return sub;
}

export async function newsOff(
  agentId: string,
  s: FeedStore = store(),
): Promise<FeedSubscription> {
  const sub = await getSubscription(agentId, s);
  sub.newsTopics = null;
  await saveSubscription(agentId, sub, s);
  log("feeds_news_off", {});
  return sub;
}

export async function stationListeners(
  stationId: string,
  s: FeedStore = store(),
): Promise<string[]> {
  return s.smembers(listenersKey(stationId));
}

// ---------------------------------------------------------------------------
// Radio lines: the transcriber pushes, observe drains (delivered once).

export interface RadioLine {
  kind: "radio";
  station: string;
  text: string;
  at: number;
}

export async function pushRadioLine(
  line: RadioLine,
  s: FeedStore = store(),
): Promise<number> {
  const listeners = await stationListeners(line.station, s);
  const payload = JSON.stringify(line);
  for (const agentId of listeners) {
    await s.rpush(bufKey(agentId), payload);
    await s.ltrim(bufKey(agentId), -BUF_CAP, -1);
    await s.expire(bufKey(agentId), BUF_TTL_SEC);
  }
  return listeners.length;
}

// ---------------------------------------------------------------------------
// News pool: normalized, deduped RSS items shared by every subscriber.

export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  source: string;
  url: string;
  publishedMs: number;
  topics: string[];
}

const TOPIC_KEYWORDS: Record<string, string[]> = {
  science: ["science", "research", "study", "space", "nasa", "climate", "virus", "vaccine", "fossil", "species"],
  technology: ["technology", "ai", "artificial intelligence", "software", "chip", "robot", "cyber", "data"],
  health: ["health", "hospital", "doctor", "disease", "cancer", "mental health", "drug"],
  politics: ["election", "president", "parliament", "minister", "government", "vote", "senate", "congress"],
  business: ["market", "economy", "bank", "trade", "oil", "inflation", "stocks", "jobs"],
  sport: ["football", "soccer", "olympic", "tennis", "cricket", "nba", "match"],
  conflict: ["war", "attack", "military", "ceasefire", "troops", "missile", "conflict"],
};

export function topicsFor(title: string, summary: string): string[] {
  const text = `${title} ${summary}`.toLowerCase();
  const topics: string[] = [];
  for (const [topic, words] of Object.entries(TOPIC_KEYWORDS)) {
    if (words.some((w) => text.includes(w))) topics.push(topic);
  }
  return topics.length ? topics : ["world"];
}

export function newsItemId(url: string, title: string): string {
  return createHash("sha256").update(url || title).digest("hex").slice(0, 16);
}

export function dedupeNews(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out.sort((a, b) => b.publishedMs - a.publishedMs);
}

function xmlText(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return "";
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

// Minimal RSS 2.0 / Atom item extraction — enough for the wire feeds we
// aggregate; a malformed feed yields fewer items, never a throw.
export function parseFeedItems(xml: string, sourceName: string): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  for (const block of blocks) {
    const title = xmlText(block, "title");
    if (!title) continue;
    let url = xmlText(block, "link");
    if (!url) {
      const href = block.match(/<link[^>]+href="([^"]+)"/i);
      if (href) url = href[1];
    }
    const summary = xmlText(block, "description") || xmlText(block, "summary");
    const dateRaw = xmlText(block, "pubDate") || xmlText(block, "published") || xmlText(block, "updated");
    const parsed = dateRaw ? Date.parse(dateRaw) : NaN;
    items.push({
      id: newsItemId(url, title),
      title,
      summary: summary.slice(0, 280),
      source: sourceName,
      url,
      publishedMs: Number.isNaN(parsed) ? 0 : parsed,
      topics: topicsFor(title, summary),
    });
  }
  return items;
}

export async function replaceNewsPool(
  items: NewsItem[],
  s: FeedStore = store(),
): Promise<void> {
  const pool = dedupeNews(items).slice(0, POOL_CAP);
  await s.del(NEWS_POOL_KEY);
  for (const item of pool) await s.rpush(NEWS_POOL_KEY, JSON.stringify(item));
  await s.expire(NEWS_POOL_KEY, POOL_TTL_SEC);
}

export async function readNewsPool(s: FeedStore = store()): Promise<NewsItem[]> {
  const raw = await s.lrange(NEWS_POOL_KEY, 0, -1);
  const items: NewsItem[] = [];
  for (const line of raw) {
    try {
      items.push(JSON.parse(line) as NewsItem);
    } catch {
      // A corrupt entry is skipped, never fatal.
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Delivery at observe time: drain radio lines, collect fresh news.
// Everything returned here is gone from the buffers afterwards — the
// agent hears it once, like a person does.

export interface FeedDelivery {
  radio: { station: string; name: string; heard: string[] } | null;
  news: { topics: string[]; headlines: { title: string; summary: string; source: string; url: string }[] } | null;
}

export const NEWS_PER_OBSERVE = 10;

export async function drainFeeds(
  agentId: string,
  s: FeedStore = store(),
): Promise<FeedDelivery> {
  const sub = await getSubscription(agentId, s);
  let radio: FeedDelivery["radio"] = null;
  if (sub.radioStationId) {
    const raw = await s.lrange(bufKey(agentId), 0, -1);
    await s.del(bufKey(agentId));
    const heard: string[] = [];
    for (const line of raw) {
      try {
        const parsed = JSON.parse(line) as RadioLine;
        if (parsed.kind === "radio") heard.push(parsed.text);
      } catch {
        // skip corrupt buffer entries
      }
    }
    const station = stationById(sub.radioStationId);
    radio = { station: sub.radioStationId, name: station?.name ?? sub.radioStationId, heard };
  }
  let news: FeedDelivery["news"] = null;
  if (sub.newsTopics !== null) {
    const pool = await readNewsPool(s);
    const wanted = sub.newsTopics;
    const fresh = pool
      .filter((item) => item.publishedMs > sub.newsCursorMs)
      .filter((item) => wanted.length === 0 || item.topics.some((t) => wanted.includes(t)))
      .slice(0, NEWS_PER_OBSERVE);
    if (fresh.length) {
      sub.newsCursorMs = Math.max(sub.newsCursorMs, ...fresh.map((i) => i.publishedMs));
      await saveSubscription(agentId, sub, s);
    }
    news = {
      topics: wanted,
      headlines: fresh.map((i) => ({ title: i.title, summary: i.summary, source: i.source, url: i.url })),
    };
  }
  return { radio, news };
}
