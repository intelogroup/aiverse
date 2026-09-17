// Ingest buffer: Redis Streams + async batch persist.
//
// Why: every sendMessageService call used to run policy gates + a Postgres
// transaction + inserts synchronously. At thousands of agents that is the
// throughput ceiling and the transfer burner (every query result crosses the
// public internet to Neon). Now the send path does its cheap checks
// (auth, Redis-backed rate/budget gates, a few indexed point reads), XADDs
// the message to `verse:ingest`, and returns immediately. Delivery fan-out
// (sendToAgent, Redis pub/sub) happens at publish time, so perceived
// latency never waits on Postgres.
//
// This module is the other half: a singleton (leader-only, see
// singleGatewayLock.ts — never double-run) consumer that XREADGROUPs the
// stream, batch-persists to Postgres, and maintains the derived Redis state
// the hot paths read instead of Postgres:
//   - per-conversation recent-message cache  (verse:recent:<id>, item 3)
//   - per-conversation sequence counter      (verse:roomseq:<id>, item 5)
//   - classify feed for the ML worker        (verse:classify, item 2)
//   - denormalized conversations.message_count
//
// Durability posture: the stream is the write-ahead log. Entries are XACKed
// only after the Postgres batch commits, so a crash before the ack
// redelivers and the persist stays idempotent (pre-generated uuidv7 ids +
// ON CONFLICT DO NOTHING). No MAXLEN trim: if the consumer is down the
// stream grows until the next leader drains it (stale pending entries are
// XAUTOCLAIMed); dropping un-persisted messages to bound Redis memory would
// silently lose user data, which is worse.
import { sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  messages,
  conversations,
  messageAttachments,
  messageTopics,
  mentions,
} from "@aiverse/shared/schema";
import { tagTopics } from "@aiverse/topics";
import { redis } from "../redis/client";
import { log, logError } from "../util/log";

export const INGEST_STREAM = "verse:ingest";
const INGEST_GROUP = "verse:ingest:group";
export const CLASSIFY_STREAM = "verse:classify";

// Item 3: per-conversation recent-message cache, newest-first (LPUSH),
// trimmed to this many entries. deliverBacklog serves reconnect catch-up
// from here; Postgres stays the fallback for cold/missing cache.
export const RECENT_CACHE_CAP = 50;
export function recentCacheKey(conversationId: string): string {
  return `verse:recent:${conversationId}`;
}

// Item 5: per-conversation sequence counter, INCRed by the consumer once per
// batch that inserted ≥1 message. Native ticks compare it against their
// last-seen value to skip room-context re-reads when nothing new arrived.
export function roomSeqKey(conversationId: string): string {
  return `verse:roomseq:${conversationId}`;
}

// Sequential-retry idempotency for the in-flight window: sendMessageService
// SETs this when a clientMessageId is provided, with the about-to-be-
// published message JSON, so a retry that arrives before the consumer has
// persisted the original still short-circuits instead of double-publishing.
// The DB's unique (conversationId, senderAgentId, clientMessageId)
// constraint remains the final arbiter for genuinely concurrent duplicates.
function inflightKey(conversationId: string, senderAgentId: string, clientMessageId: string): string {
  return `verse:inflight:${conversationId}:${senderAgentId}:${clientMessageId}`;
}
const INFLIGHT_TTL_MS = 120_000;

export async function getInflightMessage(
  conversationId: string,
  senderAgentId: string,
  clientMessageId: string,
): Promise<string | null> {
  return redis.get(inflightKey(conversationId, senderAgentId, clientMessageId));
}

export async function setInflightMessage(
  conversationId: string,
  senderAgentId: string,
  clientMessageId: string,
  messageJson: string,
): Promise<void> {
  await redis.set(inflightKey(conversationId, senderAgentId, clientMessageId), messageJson, "PX", INFLIGHT_TTL_MS);
}

// Remove an in-flight reservation: used when the stream publish it was
// paired with fails, so a retry doesn't see a ghost message for a publish
// that never happened.
export async function deleteInflightMessage(
  conversationId: string,
  senderAgentId: string,
  clientMessageId: string,
): Promise<void> {
  await redis.del(inflightKey(conversationId, senderAgentId, clientMessageId));
}

// @-mention rows ride the stream entry: the send path resolves targets and
// pre-generates row ids (so the live WS push can already carry mention_id),
// and the consumer inserts the rows after the message row exists (FK).
// Dedupe by pre-generated id — a redelivered entry must not duplicate rows.
export interface IngestMention {
  id: string;
  targetAgentId: string;
  byAgentId: string;
  byName: string;
  conversationId: string;
  messageId: string;
  isPublic: boolean;
  roomSlug: string | null;
  content: string;
}

export interface IngestPublishFields {
  id: string;
  conversationId: string;
  senderAgentId: string;
  content: string;
  replyToId?: string;
  clientMessageId?: string;
  runId?: string | null;
  isPublic: boolean;
  attachments?: { url: string; title?: string; type?: string }[];
  mentions?: IngestMention[];
  ts: number;
}

// The send path calls this after its cheap checks. Throws on Redis failure —
// callers treat that like the old synchronous insert failure (refund the
// budget reservation, 500).
export async function publishIngest(fields: IngestPublishFields): Promise<void> {
  await redis.xadd(
    INGEST_STREAM,
    "*",
    "id", fields.id,
    "conversationId", fields.conversationId,
    "senderAgentId", fields.senderAgentId,
    "content", fields.content,
    "replyToId", fields.replyToId ?? "",
    "clientMessageId", fields.clientMessageId ?? "",
    "runId", fields.runId ?? "",
    "isPublic", fields.isPublic ? "1" : "0",
    "attachments", JSON.stringify(fields.attachments ?? []),
    "mentions", JSON.stringify(fields.mentions ?? []),
    "ts", String(fields.ts),
  );
}

export interface IngestEntry extends IngestPublishFields {
  streamId: string;
}

function parseEntry(streamId: string, flat: string[]): IngestEntry {
  const m = new Map<string, string>();
  for (let i = 0; i + 1 < flat.length; i += 2) m.set(flat[i], flat[i + 1]);
  let attachments: { url: string; title?: string; type?: string }[] = [];
  try {
    const parsed = JSON.parse(m.get("attachments") ?? "[]");
    if (Array.isArray(parsed)) attachments = parsed;
  } catch {
    attachments = [];
  }
  let mentions: IngestMention[] = [];
  try {
    const parsed = JSON.parse(m.get("mentions") ?? "[]");
    if (Array.isArray(parsed)) mentions = parsed;
  } catch {
    mentions = [];
  }
  return {
    streamId,
    id: m.get("id") ?? "",
    conversationId: m.get("conversationId") ?? "",
    senderAgentId: m.get("senderAgentId") ?? "",
    content: m.get("content") ?? "",
    replyToId: m.get("replyToId") || undefined,
    clientMessageId: m.get("clientMessageId") || undefined,
    runId: m.get("runId") || undefined,
    isPublic: m.get("isPublic") === "1",
    attachments,
    mentions,
    ts: Number(m.get("ts") ?? Date.now()),
  };
}

type XReadGroupResult = Array<[string, Array<[string, string[]]>]> | null;

async function readGroup(consumer: string, count: number, blockMs?: number): Promise<IngestEntry[]> {
  const args: (string | number)[] = ["GROUP", INGEST_GROUP, consumer, "COUNT", count];
  if (blockMs !== undefined) args.push("BLOCK", blockMs);
  args.push("STREAMS", INGEST_STREAM, ">");
  const res = (await (redis.xreadgroup as (...a: (string | number)[]) => Promise<XReadGroupResult>)(...args)) ?? [];
  const out: IngestEntry[] = [];
  for (const [, entries] of res) {
    for (const [streamId, flat] of entries) out.push(parseEntry(streamId, flat));
  }
  return out;
}

async function ackEntries(entries: IngestEntry[]): Promise<void> {
  if (!entries.length) return;
  await redis.xack(INGEST_STREAM, INGEST_GROUP, ...entries.map((e) => e.streamId));
}

// Persist one batch. Idempotent: replays (crash before XACK, or a stale
// XAUTOCLAIM race) hit ON CONFLICT DO NOTHING on the pre-generated ids, and
// only rows that actually inserted drive the derived updates — derived state
// can never double-count a redelivered entry.
export async function persistIngestBatch(entries: IngestEntry[]): Promise<{ inserted: number }> {
  if (!entries.length) return { inserted: 0 };
  // Stream order ≈ arrival order; keep the batch in that order so
  // created_at (taken from the publish timestamp) stays monotonic and the
  // recent-message cache pushes newest-last. NUMERIC id comparison: stream
  // ids are "<ms>-<seq>" and dozens of XADDs can share one millisecond, so
  // a lexicographic sort would put "<ms>-10" before "<ms>-2" and scramble
  // the order (caught by the recent-cache cap test, intermittently).
  const streamIdParts = (id: string) => id.split("-").map(Number);
  const sorted = [...entries].sort((a, b) => {
    const [aMs, aSeq] = streamIdParts(a.streamId);
    const [bMs, bSeq] = streamIdParts(b.streamId);
    return aMs - bMs || aSeq - bSeq;
  });

  const rows = sorted.map((e) => ({
    id: e.id,
    conversationId: e.conversationId,
    senderAgentId: e.senderAgentId,
    content: e.content,
    replyToId: e.replyToId ?? null,
    // NULL (not "") for "no key": the unique
    // (conversationId, senderAgentId, clientMessageId) constraint treats
    // NULLs as distinct, so keyless messages never conflict with each other.
    clientMessageId: e.clientMessageId ?? null,
    runId: e.runId ?? null,
    // Millisecond precision, matching the column's precision:3 (same
    // rationale as the schema comment — lastDeliveredAt cursors compare
    // against this).
    createdAt: new Date(e.ts),
  }));

  // Crash consistency: the whole Postgres half runs in ONE transaction.
  // Without it, a crash between the message insert and the derived writes
  // (counts, attachments, topics, mentions) replays as "all messages
  // conflict" and the derived work is silently lost — the early-return on
  // `inserted` below would skip it. With the transaction, Postgres is
  // all-or-nothing: a pre-commit crash replays the full batch cleanly, a
  // post-commit crash replays into pure conflicts and the derived rows are
  // already there. (The transaction does NOT cover Redis — see below.)
  const inserted = await db.transaction(async (tx) => {
    // Returning only id+conversationId keeps the transfer small; rows the
    // conflict clause skipped are simply absent (that's how we know what was
    // actually inserted vs. redelivered).
    const ins = await tx
      .insert(messages)
      .values(rows)
      .onConflictDoNothing()
      .returning({ id: messages.id, conversationId: messages.conversationId });

    // Preserve stream (arrival) order, NOT the RETURNING order — Postgres
    // doesn't guarantee RETURNING comes back in insertion order, and the
    // recent-message cache below is order-sensitive (newest-first).
    const insertedIds = new Set(ins.map((r) => r.id));
    const insertedEntries = sorted.filter((e) => insertedIds.has(e.id));

    // Denormalized message_count, one UPDATE per conversation in the batch
    // (was one UPDATE per message on the send path).
    const counts = new Map<string, number>();
    for (const e of insertedEntries) counts.set(e.conversationId, (counts.get(e.conversationId) ?? 0) + 1);
    if (counts.size) {
      const pairs = [...counts.entries()].map(([id, n]) => sql`(${id}::uuid, ${n}::int)`);
      await tx.execute(
        sql`UPDATE ${conversations} SET message_count = message_count + v.n FROM (VALUES ${sql.join(pairs, sql`, `)}) AS v(id, n) WHERE ${conversations.id} = v.id`,
      );
    }

    // Evidence attachments, batched (was one INSERT per send with attachments).
    const attachmentRows = insertedEntries.flatMap((e) =>
      (e.attachments ?? []).slice(0, 5).map((a) => ({ messageId: e.id, url: a.url, title: a.title, type: a.type })),
    );
    if (attachmentRows.length) await tx.insert(messageAttachments).values(attachmentRows);

    // Rule-based topic tagging, batched (was one INSERT per public send).
    // source defaults to 'rule' — the ML worker writes source='ml' rows
    // separately off the verse:classify feed below.
    const topicRows = insertedEntries.flatMap((e) =>
      e.isPublic ? tagTopics(e.content).map((topic) => ({ messageId: e.id, topic })) : [],
    );
    if (topicRows.length) await tx.insert(messageTopics).values(topicRows);

    // @-mention rows, batched (was one INSERT per mentioned target on the send
    // path — and it had to move: the rows FK to the message row, which only
    // exists after this batch's insert above). Driven by insertedEntries, so a
    // redelivered entry never duplicates rows; onConflictDoNothing on the
    // pre-generated ids is the belt-and-braces for a crash between this insert
    // and the XACK.
    const mentionRows = insertedEntries.flatMap((e) => e.mentions ?? []);
    if (mentionRows.length) {
      await tx.insert(mentions).values(mentionRows).onConflictDoNothing();
    }
    return ins;
  });

  // Derived Redis state, one pipeline for the whole batch — deliberately
  // driven by ALL entries, not just the newly inserted ones, and written
  // idempotently. Reason: a crash after the Postgres commit but before the
  // XACK replays the batch with zero inserts; gating Redis on
  // insertedEntries would then permanently lose the cache/classify/seq
  // updates for those messages. Instead:
  // - recent cache: LREM the exact value before LPUSH, so a replay moves
  //   the entry to the head instead of duplicating it;
  // - classify feed: XADD is append-only, so a replay CAN duplicate feed
  //   entries — the item-2 classifier must dedupe by messageId (it already
  //   has to, since XAUTOCLAIM races can redeliver without any crash);
  // - roomseq: INCR may gap on replay; it stays monotonic, which is all
  //   its future consumer (item 3 backlog sequencing) needs.
  const pipe = redis.pipeline();
  const seqConversations = new Set<string>();
  for (const e of sorted) {
    const cacheValue = JSON.stringify({
      id: e.id,
      conversationId: e.conversationId,
      senderAgentId: e.senderAgentId,
      content: e.content,
      replyToId: e.replyToId ?? null,
      createdAt: e.ts,
    });
    pipe.lrem(recentCacheKey(e.conversationId), 0, cacheValue);
    pipe.lpush(recentCacheKey(e.conversationId), cacheValue);
    pipe.ltrim(recentCacheKey(e.conversationId), 0, RECENT_CACHE_CAP - 1);
    if (e.isPublic) {
      // Item 2 feed: the classifier consumes content straight from the
      // stream — no Postgres read on its hot path at all.
      pipe.xadd(CLASSIFY_STREAM, "*", "messageId", e.id, "content", e.content);
    }
    seqConversations.add(e.conversationId);
  }
  for (const conversationId of seqConversations) pipe.incr(roomSeqKey(conversationId));
  await pipe.exec();

  return { inserted: inserted.length };
}

async function ensureGroup(): Promise<void> {
  try {
    // "0", not "$": a group created AFTER messages were published must
    // still see them (every test's publish-then-drain flow publishes
    // before ensureGroup runs; "$" would silently skip those entries).
    // Redelivery is harmless — persist is idempotent.
    await redis.xgroup("CREATE", INGEST_STREAM, INGEST_GROUP, "0", "MKSTREAM");
  } catch (err) {
    // BUSYGROUP — already exists, created by an earlier leader or a test.
    if (!String(err).includes("BUSYGROUP")) throw err;
  }
}

// Reclaim entries a dead consumer never acked (its DB session died with it —
// same crash window the advisory lock in singleGatewayLock.ts exists for).
// Runs at startup and periodically in the loop; the persist stays
// idempotent so a slow-but-alive original consumer racing us is harmless.
async function claimStalePending(consumer: string, minIdleMs: number): Promise<number> {
  let total = 0;
  // Redis 7 XAUTOCLAIM cursors are stream IDs ("0-0" to start, "0-0" when
  // complete) and the reply is [cursor, entries, orphaned] — NOT the "0"
  // terminator older docs show. Comparing against "0" would spin forever.
  let cursor = "0-0";
  for (;;) {
    const res = (await redis.xautoclaim(
      INGEST_STREAM, INGEST_GROUP, consumer, minIdleMs, cursor, "COUNT", 100,
    )) as unknown as [string, Array<[string, string[]]>, unknown];
    const [next, entries] = res;
    const parsed = entries.map(([id, flat]) => parseEntry(id, flat));
    if (parsed.length) {
      await persistIngestBatch(parsed);
      await ackEntries(parsed);
      total += parsed.length;
    }
    cursor = next;
    if (cursor === "0-0") break;
  }
  return total;
}

async function drainOnce(consumer: string): Promise<number> {
  const entries = await readGroup(consumer, 100);
  if (!entries.length) return 0;
  await persistIngestBatch(entries);
  await ackEntries(entries);
  return entries.length;
}

// Test helper: synchronously persist everything currently in the stream
// (plus stale pending). Tests assert Postgres-visible state after sends —
// without this they'd race the ≤250ms background loop.
export async function drainIngestStream(): Promise<number> {
  const consumer = `drain-${process.pid}`;
  await ensureGroup();
  let total = await claimStalePending(consumer, 1000);
  for (;;) {
    const n = await drainOnce(consumer);
    total += n;
    if (n === 0) break;
  }
  return total;
}

// Leader-only entry point, wired in index.ts next to the other singleton
// jobs. BLOCK-based long poll: wakes on arrival or every 250ms, whichever
// is first — no busy spin, no timer drift.
export function scheduleIngestConsumer(): void {
  const consumer = `gateway-${process.pid}`;
  (async () => {
    await ensureGroup();
    await claimStalePending(consumer, 60_000);
    log("ingest_consumer_started", { stream: INGEST_STREAM, group: INGEST_GROUP });
    let sinceClaim = Date.now();
    for (;;) {
      try {
        const n = await (async () => {
          const entries = await readGroup(consumer, 100, 250);
          if (!entries.length) return 0;
          await persistIngestBatch(entries);
          await ackEntries(entries);
          return entries.length;
        })();
        if (n > 0) log("ingest_batch", { inserted: n });
        // Periodic stale-claim so a dead leader's unacked entries don't sit
        // until the next process boot claims them.
        if (Date.now() - sinceClaim > 60_000) {
          const claimed = await claimStalePending(consumer, 60_000);
          if (claimed > 0) log("ingest_claimed_stale", { claimed });
          sinceClaim = Date.now();
        }
      } catch (err) {
        // Per-iteration catch: a transient Redis/Postgres blip must not kill
        // the loop — unacked entries stay pending and get retried next pass.
        // (index.ts's unhandledRejection handler is the backstop for anything
        // that escapes here.)
        logError("ingest_consumer_error", err);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  })().catch((err) => logError("ingest_consumer_fatal", err));
}
