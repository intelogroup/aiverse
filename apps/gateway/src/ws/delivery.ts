// Offline delivery: reconnect backlog, subscription catch-up, and ack
// handling (extracted from ws/gateway.ts, cleanup L2; behavior unchanged).
import { and, eq, gt, isNotNull, isNull, lt, ne } from "drizzle-orm";
import { a2aTasks, conversationParticipants, mentions, messages } from "@aiverse/shared/schema";
import { db } from "../db/client";
import { INGEST_STREAM, recentCacheKey } from "../jobs/ingestConsumer";
import { redis } from "../redis/client";
import { log } from "../util/log";
import {
  ackCursorMode,
  ackCursorsEnabled,
  addMentionAck,
  advanceAckCursor,
  getAckCursorMs,
  getAckCursorsMs,
} from "./ackCursors";
import type { WSContext } from "./connections";
import { WS_EVENTS, envelope } from "./events";
import { sendToAgent } from "./fanout";

// Early-ACK stash: a client can ACK a message/mention that arrived on the
// live socket before the ingest consumer persisted its row (the async
// persist window). The ACK's UPDATE then matches zero rows and would be
// silently dropped, causing a duplicate on the next reconnect. Stash the
// ack in Redis; the reconnect backlog filters stashed ids out. The durable
// ackedAt / lastDeliveredAt columns stay the source of truth once the row
// exists — the stash only bridges the persist window, hence the TTL.
const EARLY_ACK_TTL_SECONDS = 86400;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function earlyAckKey(kind: "msg" | "mention", parts: string[]): string {
  return `earlyack:${kind}:${parts.join(":")}`;
}

// Drops backlog entries the client already acked early (see above). One
// pipeline per call; ids are pre-generated UUIDs so key construction is
// safe. getId defaults to `.id` (message/mention rows); stream-merged
// mention payloads carry `mention_id` instead.
async function filterEarlyAcked<T>(
  kind: "msg" | "mention",
  keyParts: (id: string) => string[],
  entries: T[],
  getId: (e: T) => string = (e) => (e as { id: string }).id,
): Promise<T[]> {
  if (!entries.length) return entries;
  const pipe = redis.pipeline();
  for (const e of entries) pipe.exists(earlyAckKey(kind, keyParts(getId(e))));
  const hits = await pipe.exec();
  return entries.filter((_, i) => {
    const r = hits?.[i]?.[1];
    return r !== 1 && r !== "1";
  });
}

// Bounded per source so a long-absent agent reconnecting doesn't get flooded
// — this is at-least-once catch-up, not a full history replay.
const BACKLOG_MESSAGES_PER_CONVERSATION = 50;

const BACKLOG_A2A_TASKS = 50;

const BACKLOG_MENTIONS = 20;

// Item 3: reconnect message backlog reads from the per-conversation
// recent-message cache the ingest consumer maintains
// (verse:recent:<id>, newest-first, capped at RECENT_CACHE_CAP) instead of
// Postgres. Returns null when the cache can't cover the cursor — cold,
// evicted, or trimmed past lastDeliveredAt — and the caller falls back to
// the Postgres query, which stays the source of truth.
//
// Coverage rule: the cache is a contiguous newest-first suffix of the
// conversation (LPUSH in stream order, LREM+LPUSH on replay, atomic
// pipeline), so it holds every undelivered message iff its oldest entry is
// at or before the cursor. Pre-item-1 messages never entered the cache, so
// an old cursor correctly misses and falls back.
interface BacklogCacheEntry {
  id: string;
  conversationId: string;
  senderAgentId: string;
  content: string;
  replyToId: string | null;
  createdAt: number;
}

async function readBacklogCache(
  conversationId: string,
  agentId: string,
  lastDeliveredAt: Date,
): Promise<BacklogCacheEntry[] | null> {
  const raw = await redis.lrange(recentCacheKey(conversationId), 0, -1);
  if (!raw.length) return null;
  const entries: BacklogCacheEntry[] = [];
  for (const item of raw) {
    let e: Partial<BacklogCacheEntry>;
    try {
      e = JSON.parse(item) as Partial<BacklogCacheEntry>;
    } catch {
      // Malformed entry: the cache no longer provably holds a contiguous
      // newest-first suffix, so the coverage check below can't be trusted
      // (the oldest remaining parseable entry could mask a gap). Fall back
      // to Postgres rather than risk silently omitting messages.
      return null;
    }
    if (typeof e.id !== "string" || typeof e.createdAt !== "number" || !Number.isFinite(e.createdAt)) {
      // Structurally invalid entry: same reasoning — can't prove coverage.
      return null;
    }
    entries.push({
      id: e.id,
      conversationId: typeof e.conversationId === "string" ? e.conversationId : conversationId,
      senderAgentId: typeof e.senderAgentId === "string" ? e.senderAgentId : "",
      content: typeof e.content === "string" ? e.content : "",
      replyToId: typeof e.replyToId === "string" ? e.replyToId : null,
      createdAt: e.createdAt,
    });
  }
  if (!entries.length) return null;
  const cursorMs = lastDeliveredAt.getTime();
  if (entries[entries.length - 1].createdAt > cursorMs) return null;
  // Same filter-then-bound as the Postgres query below: only messages after
  // the cursor, not from the reconnecting agent, at most the cap.
  return entries
    .filter((e) => e.createdAt > cursorMs && e.senderAgentId !== agentId)
    .slice(0, BACKLOG_MESSAGES_PER_CONVERSATION);
}

// Entries published to the ingest stream but not yet persisted by the
// consumer (the ≤250ms window, or a consumer outage): they already fanned
// out live, so a reconnect racing the persist window would miss them —
// neither the recent-message cache nor Postgres has them yet. Reads the
// stream tail directly (stream ids are "<ms>-<seq>", so min-id "<cursorMs>-0"
// starts the range at the cursor without scanning older history), oldest-
// first. `seenIds` dedupes against what the cache/Postgres read already
// returned — the consumer may persist an entry between the two reads, in
// which case it appears in both. Unpersisted entries are strictly newer than
// anything persisted, so the caller appends these after the persisted
// backlog and wire order stays oldest-first.
const PENDING_INGEST_SCAN_COUNT = 100;

async function readPendingIngest(
  conversationId: string,
  agentId: string,
  lastDeliveredAt: Date,
  seenIds: Set<string>,
): Promise<BacklogCacheEntry[]> {
  const cursorMs = lastDeliveredAt.getTime();
  let raw: Array<[string, string[]]>;
  try {
    raw = (await redis.xrange(INGEST_STREAM, `${cursorMs}-0`, "+", "COUNT", PENDING_INGEST_SCAN_COUNT)) as Array<
      [string, string[]]
    >;
  } catch {
    return [];
  }
  const out: BacklogCacheEntry[] = [];
  for (const [, flat] of raw) {
    const m = new Map<string, string>();
    for (let i = 0; i + 1 < flat.length; i += 2) m.set(flat[i], flat[i + 1]);
    const id = m.get("id") ?? "";
    const ts = Number(m.get("ts") ?? NaN);
    if (!id || !Number.isFinite(ts) || ts <= cursorMs) continue;
    if (m.get("conversationId") !== conversationId) continue;
    if ((m.get("senderAgentId") ?? "") === agentId) continue;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    out.push({
      id,
      conversationId,
      senderAgentId: m.get("senderAgentId") ?? "",
      content: m.get("content") ?? "",
      replyToId: m.get("replyToId") || null,
      createdAt: ts,
    });
  }
  return out;
}

// Same race one level up for @-mentions: the durable mention row is written
// by the ingest consumer, but the live MENTIONED push fires at send time. A
// reconnect inside the persist window misses the row in the Postgres query
// below, so merge unpersisted mentions straight from the stream entries'
// pre-generated mention payloads. Time-bounded (not cursor-bounded — the
// mentions backlog is "all unacked", and anything unpersisted is by
// definition younger than the consumer lag).
const PENDING_MENTION_SCAN_MINUTES = 5;

interface PendingMention {
  mention_id: string;
  conversation_id: string;
  is_public: boolean;
  room_slug: string | null;
  message_id: string;
  by: string;
  by_name: string;
  content: string;
  ts: number;
}

async function readPendingMentions(agentId: string, seenIds: Set<string>): Promise<PendingMention[]> {
  const sinceMs = Date.now() - PENDING_MENTION_SCAN_MINUTES * 60_000;
  let raw: Array<[string, string[]]>;
  try {
    raw = (await redis.xrange(INGEST_STREAM, `${sinceMs}-0`, "+", "COUNT", PENDING_INGEST_SCAN_COUNT)) as Array<
      [string, string[]]
    >;
  } catch {
    return [];
  }
  const out: PendingMention[] = [];
  for (const [, flat] of raw) {
    const m = new Map<string, string>();
    for (let i = 0; i + 1 < flat.length; i += 2) m.set(flat[i], flat[i + 1]);
    let payloads: unknown;
    try {
      payloads = JSON.parse(m.get("mentions") ?? "[]");
    } catch {
      continue;
    }
    if (!Array.isArray(payloads)) continue;
    const ts = Number(m.get("ts") ?? Date.now());
    for (const men of payloads as Array<Record<string, unknown>>) {
      if (men?.targetAgentId !== agentId) continue;
      const id = typeof men.id === "string" ? men.id : "";
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      out.push({
        mention_id: id,
        conversation_id: typeof men.conversationId === "string" ? men.conversationId : "",
        is_public: men.isPublic === true,
        room_slug: typeof men.roomSlug === "string" ? men.roomSlug : null,
        message_id: typeof men.messageId === "string" ? men.messageId : "",
        by: typeof men.byAgentId === "string" ? men.byAgentId : "",
        by_name: typeof men.byName === "string" ? men.byName : "",
        content: typeof men.content === "string" ? men.content : "",
        ts: Number.isFinite(ts) ? ts : Date.now(),
      });
    }
  }
  return out;
}

// Per-conversation backlog replay: the messages + participant joins one
// agent missed in ONE conversation, oldest-first, each source bounded by
// BACKLOG_MESSAGES_PER_CONVERSATION. Extracted from deliverBacklog
// (PHASE1_SPEC WI-2): the reconnect path replays every conversation
// through here, and a passive→active subscription flip replays exactly
// one conversation through the same code — a single implementation, so
// the two paths cannot drift on cursor semantics, the early-ack filter,
// or the pending-ingest merge. `redisCursorMs` is the agent's Redis hot
// cursor for this conversation (WI-4); the effective cursor is
// max(PG lastDeliveredAt, Redis) — inside the checkpoint window the PG
// column alone lags by up to one interval and reading it directly would
// replay already-acked messages. `send` is the frame sink: the
// reconnect path writes to the connecting socket, the subscription
// path publishes through the Redis fanout (the socket may live on
// another gateway process).
async function deliverConversationBacklog(
  agentId: string,
  p: { conversationId: string; lastDeliveredAt: Date },
  redisCursorMs: number | undefined,
  send: (event: ReturnType<typeof envelope>) => void,
): Promise<{ messages: number; participantJoins: number; messageIds: Set<string> }> {
  let messagesDelivered = 0;
  let participantJoinsDelivered = 0;
  const messageIds = new Set<string>();
  {
    const lastDeliveredAt =
      redisCursorMs !== undefined && redisCursorMs > p.lastDeliveredAt.getTime()
        ? new Date(redisCursorMs)
        : p.lastDeliveredAt;
    // Cache-first (item 3): the Postgres query below is the fallback for a
    // cold or cursor-uncovered cache. Cached entries are newest-first; the
    // wire order stays oldest-first like the Postgres ORDER BY.
    const cached = await readBacklogCache(p.conversationId, agentId, lastDeliveredAt);
    const persisted =
      cached !== null
        ? [...cached].reverse()
        : await db.query.messages.findMany({
            where: and(
              eq(messages.conversationId, p.conversationId),
              gt(messages.createdAt, lastDeliveredAt),
              ne(messages.senderAgentId, agentId),
            ),
            orderBy: (m, { asc }) => [asc(m.createdAt)],
            limit: BACKLOG_MESSAGES_PER_CONVERSATION,
          });
    // Unpersisted stream tail (see readPendingIngest): strictly newer than
    // anything above, so it appends after and wire order stays oldest-first.
    const seenBacklogIds = new Set(persisted.map((m) => m.id));
    const backlog = await filterEarlyAcked("msg", (id) => [p.conversationId, agentId, id], [
      ...persisted,
      ...(await readPendingIngest(p.conversationId, agentId, lastDeliveredAt, seenBacklogIds)),
    ]);
    for (const m of backlog) {
      send(
        envelope(WS_EVENTS.MESSAGE, {
          conversation_id: m.conversationId,
          message_id: m.id,
          sender_id: m.senderAgentId,
          content: m.content,
          reply_to_id: m.replyToId,
          ts: typeof m.createdAt === "number" ? m.createdAt : m.createdAt.getTime(),
        }),
      );
      messageIds.add(m.id);
      messagesDelivered += 1;
    }

    // THREAD_PARTICIPANT_JOINED is otherwise fire-and-forget (routes/
    // conversations.ts, routes/rooms.ts) — an offline participant simply
    // never learns a peer joined while they were away, no different from
    // the pre-fix @-mention gap. Reuses the same durable lastDeliveredAt
    // cursor messages already have; no new column needed, since every
    // conversation_participants row already carries its own joinedAt.
    const newJoins = await db.query.conversationParticipants.findMany({
      where: and(
        eq(conversationParticipants.conversationId, p.conversationId),
        gt(conversationParticipants.joinedAt, lastDeliveredAt),
        ne(conversationParticipants.agentId, agentId),
      ),
      orderBy: (cp, { asc }) => [asc(cp.joinedAt)],
      limit: BACKLOG_MESSAGES_PER_CONVERSATION,
    });
    for (const joined of newJoins) {
      send(
        envelope(WS_EVENTS.THREAD_PARTICIPANT_JOINED, {
          conversation_id: p.conversationId,
          agent_id: joined.agentId,
          invited_by: null,
        }),
      );
      participantJoinsDelivered += 1;
    }
  }
  return { messages: messagesDelivered, participantJoins: participantJoinsDelivered, messageIds };
}

// WI-2 subscription catch-up: when a participant flips passive → active
// (POST /conversations/:id/subscription), the messages suppressed while
// passive are replayed immediately instead of waiting for a reconnect.
// Runs the same per-conversation backlog as a reconnect — the cursor is
// untouched (the client's acks still advance it) and at-least-once is
// intact. Delivery goes through the Redis fanout via sendToAgent because
// the agent's socket may live on any gateway process; an agent with no
// live socket gets nothing here and still receives the same backlog on
// its next connect, so a flip while offline loses nothing.
export async function deliverSubscriptionCatchUp(
  agentId: string,
  conversationId: string,
): Promise<{ messages: number; participantJoins: number }> {
  const participant = await db.query.conversationParticipants.findFirst({
    where: and(
      eq(conversationParticipants.conversationId, conversationId),
      eq(conversationParticipants.agentId, agentId),
    ),
  });
  if (!participant) return { messages: 0, participantJoins: 0 };
  const redisCursorMs = ackCursorsEnabled()
    ? ((await getAckCursorMs(agentId, conversationId)) ?? undefined)
    : undefined;
  const part = await deliverConversationBacklog(agentId, participant, redisCursorMs, (event) =>
    sendToAgent(agentId, event),
  );
  return { messages: part.messages, participantJoins: part.participantJoins };
}

// Offline delivery: replays anything this agent missed while disconnected.
// Messages replay from each conversation's lastDeliveredAt cursor (only
// advanced by an explicit client ack, see onMessage below); A2A tasks replay
// every still-'submitted' task addressed to this agent, since 'submitted'
// already means "not yet acted on" — no separate delivered/acked column
// needed there, the state machine itself gates redelivery.
export async function deliverBacklog(agentId: string, ws: WSContext): Promise<{ messages: number; tasks: number; mentions: number; participantJoins: number; messageIds: Set<string> }> {
  const participantRows = await db.query.conversationParticipants.findMany({
    where: eq(conversationParticipants.agentId, agentId),
  });

  // Cursor acks v1 (PHASE1_SPEC WI-4 / discrepancy D4): one pipelined
  // fetch of the agent's Redis hot cursors up front;
  // deliverConversationBacklog applies the max(PG, Redis) rule per
  // conversation. Legacy mode never touches Redis here — PG only, as
  // before.
  const redisCursors = ackCursorsEnabled()
    ? await getAckCursorsMs(agentId, participantRows.map((p) => p.conversationId))
    : new Map<string, number>();

  let messagesDelivered = 0;
  let participantJoinsDelivered = 0;
  // Ids of every message envelope written here — the register-first
  // flush dedupes the setting-up buffer against this set (a frame that
  // fanned out live during setup AND made the backlog is delivered
  // once, from the backlog).
  const deliveredMessageIds = new Set<string>();
  for (const p of participantRows) {
    const part = await deliverConversationBacklog(agentId, p, redisCursors.get(p.conversationId), (event) =>
      ws.send(JSON.stringify(event)),
    );
    messagesDelivered += part.messages;
    participantJoinsDelivered += part.participantJoins;
    for (const id of part.messageIds) deliveredMessageIds.add(id);
  }

  const pendingTasks = await db.query.a2aTasks.findMany({
    where: and(eq(a2aTasks.targetAgentId, agentId), eq(a2aTasks.state, "submitted")),
    limit: BACKLOG_A2A_TASKS,
  });
  for (const task of pendingTasks) {
    ws.send(
      JSON.stringify(
        envelope(WS_EVENTS.A2A_TASK_REQUEST, {
          taskId: task.id,
          fromAgentId: task.callerAgentId,
          message: task.requestMessage,
        }),
      ),
    );
  }

  // Pending mentions: unlike message backlog above, NOT scoped to
  // conversationParticipants — a mention is deliberately allowed to reach a
  // non-participant (see routes/conversations.ts), so it needs its own
  // per-agent query rather than riding the participant-row loop.
  const allPersistedMentions = await db.query.mentions.findMany({
    where: and(eq(mentions.targetAgentId, agentId), isNull(mentions.ackedAt)),
    orderBy: (m, { asc }) => [asc(m.createdAt)],
    limit: BACKLOG_MENTIONS,
  });
  // seenMentionIds is built from the UNFILTERED rows: a mention dropped by
  // the early-ACK filter below must still suppress its stream-tail twin in
  // readPendingMentions, or the stash would just move the duplicate from
  // the Postgres path to the stream path.
  const seenMentionIds = new Set(allPersistedMentions.map((m) => m.id));
  // Acked mentions suppress their stream twins too (cursor acks v1 made
  // this load-bearing: the checkpoint now sets ackedAt for early-acked
  // mentions, which removes them from the unacked query above — without
  // this, their stream copies would replay on every reconnect inside
  // the scan window). Bounded by the same window readPendingMentions
  // scans.
  const recentlyAckedMentions = await db.query.mentions.findMany({
    where: and(
      eq(mentions.targetAgentId, agentId),
      isNotNull(mentions.ackedAt),
      gt(mentions.createdAt, new Date(Date.now() - PENDING_MENTION_SCAN_MINUTES * 60_000)),
    ),
    columns: { id: true },
    limit: PENDING_INGEST_SCAN_COUNT,
  });
  for (const m of recentlyAckedMentions) seenMentionIds.add(m.id);
  const persistedMentions = await filterEarlyAcked("mention", (id) => [id], allPersistedMentions);
  // Unpersisted mention rows still sitting in the ingest stream (same race
  // as messages above): append after the persisted ones, oldest-first.
  // The merged copies pass through the early-ACK filter as well — the
  // stash contract (ACK_CURSORS_V1 §1) covers the whole backlog, not
  // just the Postgres half of it.
  const pendingMentions: PendingMention[] = persistedMentions.map((m) => ({
    mention_id: m.id,
    conversation_id: m.conversationId,
    is_public: m.isPublic,
    room_slug: m.roomSlug,
    message_id: m.messageId,
    by: m.byAgentId,
    by_name: m.byName,
    content: m.content,
    ts: m.createdAt.getTime(),
  }));
  pendingMentions.push(
    ...(await filterEarlyAcked(
      "mention",
      (id) => [id],
      await readPendingMentions(agentId, seenMentionIds),
      (m) => m.mention_id,
    )),
  );
  for (const m of pendingMentions) {
    ws.send(
      JSON.stringify(
        envelope(WS_EVENTS.MENTIONED, {
          mention_id: m.mention_id,
          conversation_id: m.conversation_id,
          is_public: m.is_public,
          room_slug: m.room_slug,
          message_id: m.message_id,
          by: m.by,
          by_name: m.by_name,
          content: m.content,
          ts: m.ts,
        }),
      ),
    );
  }

  return { messages: messagesDelivered, tasks: pendingTasks.length, mentions: pendingMentions.length, participantJoins: participantJoinsDelivered, messageIds: deliveredMessageIds };
}

// Resolves a message's real createdAt for an ack (ACK_CURSORS_V1 §3.2
// step 1): the client's timestamp is never trusted, and the durable
// lookup is the last resort, not the first — the recent-message cache
// and the pending-ingest stream tail both carry the authoritative ts
// the send path assigned. Null = unresolvable everywhere; the caller
// falls back to the early-ack stash, exactly as the old PG-only lookup
// did when it found no row.
async function resolveAckMessageCreatedAt(conversationId: string, messageId: string): Promise<Date | null> {
  const cached = await redis.lrange(recentCacheKey(conversationId), 0, -1);
  for (const item of cached) {
    try {
      const e = JSON.parse(item) as { id?: unknown; createdAt?: unknown };
      if (e.id === messageId && typeof e.createdAt === "number" && Number.isFinite(e.createdAt)) {
        return new Date(e.createdAt);
      }
    } catch {
      // Malformed cache entry — not a resolution source; keep looking.
    }
  }
  try {
    const tail = (await redis.xrevrange(INGEST_STREAM, "+", "-", "COUNT", PENDING_INGEST_SCAN_COUNT)) as Array<
      [string, string[]]
    >;
    for (const [, flat] of tail) {
      const fields = new Map<string, string>();
      for (let i = 0; i + 1 < flat.length; i += 2) fields.set(flat[i], flat[i + 1]);
      if (fields.get("id") === messageId && fields.get("conversationId") === conversationId) {
        const ts = Number(fields.get("ts") ?? NaN);
        if (Number.isFinite(ts)) return new Date(ts);
      }
    }
  } catch {
    // Stream unreadable — fall through to Postgres.
  }
  const row = await db.query.messages.findFirst({
    where: and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)),
    columns: { createdAt: true },
  });
  return row?.createdAt ?? null;
}

// Advances the delivery cursor for one conversation, gated on the message's
// real createdAt looked up server-side — never trust a client-supplied
// timestamp, and never move the cursor backward on an out-of-order ack.
//
// Early-ACK race (async persist window): the client can ACK a message or
// mention that arrived on the live socket before the ingest consumer wrote
// its row. The lookup below then finds nothing and the ACK would be
// silently dropped — a guaranteed duplicate on the next reconnect. Instead
// the ACK is stashed in Redis (see earlyAckKey); deliverBacklog filters
// stashed ids out, so the client effectively gets exactly-once within the
// stash TTL even across the persist window.
// Exported so HTTP-only clients (no WS connection — MCP/plain-poll agents)
// can ack the same way a WS client does: conversations.ts's POST
// /:id/messages/:messageId/ack calls this directly instead of duplicating
// the cursor-advance logic.
export async function handleAck(agentId: string, payload: unknown): Promise<void> {
  const { conversationId, messageId, mentionId } = (payload ?? {}) as {
    conversationId?: string;
    messageId?: string;
    mentionId?: string;
  };
  const mode = ackCursorMode();
  // A mention ack is keyed on the mentions row id (not conversationId +
  // messageId): the target may not be a conversation participant, so
  // conversationParticipants.lastDeliveredAt has no row to advance for them.
  if (mentionId) {
    const row = await db.query.mentions.findFirst({
      where: and(eq(mentions.id, mentionId), eq(mentions.targetAgentId, agentId)),
      columns: { id: true },
    });
    if (!row) {
      // Not persisted yet — stash the ACK (guard the key shape: mention ids
      // are server-generated UUIDs, never trust client input for key parts).
      if (UUID_RE.test(mentionId)) {
        await redis.set(earlyAckKey("mention", [mentionId]), "1", "EX", EARLY_ACK_TTL_SECONDS);
        // Cursor acks v1: the id also joins the checkpoint set, so the ack
        // lands on the row once the ingest consumer persists it — the
        // stash alone only filters one reconnect's backlog.
        if (mode !== "legacy") await addMentionAck(agentId, mentionId);
      }
      return;
    }
    if (mode !== "redis") {
      await db.update(mentions).set({ ackedAt: new Date() }).where(and(eq(mentions.id, mentionId), eq(mentions.targetAgentId, agentId)));
      log("ack_pg_writes", { agentId, kind: "mention", count: 1 });
    }
    if (mode !== "legacy") await addMentionAck(agentId, mentionId);
    return;
  }
  if (!conversationId || !messageId) return;

  const createdAt = await resolveAckMessageCreatedAt(conversationId, messageId);
  if (!createdAt) {
    // Same early-ACK race as mentions above: stash it for the backlog filter.
    if (UUID_RE.test(messageId)) {
      await redis.set(earlyAckKey("msg", [conversationId, agentId, messageId]), "1", "EX", EARLY_ACK_TTL_SECONDS);
    }
    return;
  }

  // Cursor acks v1 (ACK_CURSORS_V1 §3.2/§4): dual mode keeps today's PG
  // write AND advances the Redis cursor; redis mode advances the cursor
  // only — PG moves at checkpoint. Legacy is today's path untouched.
  if (mode !== "redis") {
    await db
      .update(conversationParticipants)
      .set({ lastDeliveredAt: createdAt })
      .where(
        and(
          eq(conversationParticipants.conversationId, conversationId),
          eq(conversationParticipants.agentId, agentId),
          lt(conversationParticipants.lastDeliveredAt, createdAt),
        ),
      );
    log("ack_pg_writes", { agentId, conversationId, kind: "message", count: 1 });
  }
  if (mode !== "legacy") {
    const advanced = await advanceAckCursor(agentId, conversationId, createdAt.getTime(), messageId);
    if (advanced) log("ack_redis_advances", { agentId, conversationId, count: 1 });
  }

  log("message_ack", {
    agentId,
    conversationId,
    messageId,
    ackLatencyMs: Date.now() - createdAt.getTime(),
  });
}

// ── Burst defenses (PHASE0_SPEC §2) ─────────────────────────────────────
// Two independent guards against connect storms, sized as seatbelts, not
// product limits: storms are hundreds of connects; normal agents connect
// a handful of times an hour.
