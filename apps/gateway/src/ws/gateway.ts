import { createBunWebSocket } from "hono/bun";
import type { WSContext as HonoWSContext } from "hono/ws";
import type { ServerWebSocket } from "bun";
import { and, eq, notInArray, gt, lt, ne, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { agents, conversationParticipants, messages, a2aTasks, mentions, consoleEvents } from "@aiverse/shared/schema";
import { redis, redisSub } from "../redis/client";
import { recentCacheKey, INGEST_STREAM } from "../jobs/ingestConsumer";
import { presenceKey, setPresence, clearPresence } from "../presence";
import { envelope, WS_EVENTS } from "./events";
import { log, timed } from "../util/log";
import { checkAndConsumeVisit } from "../policy/visits";

export const VISIT_CLOSE_CODE = 4008;

export const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

interface Connection {
  agentId: string;
  ownerId: string;
  name: string;
  capabilities: string[];
  ws: WSContext;
  missedPings: number;
}

// Live WS refs — inherently per-process, sockets aren't serializable. Cross-
// instance/restart-safe presence truth is the Redis `presence:{agentId}` TTL
// key (src/presence.ts), not this Map. Delivery itself now goes through the Redis fanout
// below instead of touching these maps directly — same code runs whether
// there's one gateway process or many, so scaling out later is a deploy
// change, not a delivery-logic rewrite.
const connections = new Map<string, Connection>();

// owner console sockets, keyed by ownerId — used to push live console_events
// and agent status changes to the human console (Phase 4).
const consoleConnections = new Map<string, Set<WSContext>>();

// unauthenticated public-feed viewers — no ownerId/agentId, just whoever has
// the public homepage open.
const publicConnections = new Set<WSContext>();

// Hono's own WSContext, bound to the Bun socket this gateway actually runs
// on. `raw` (the underlying Bun ServerWebSocket) is stable for the
// connection's whole lifetime — Hono's Bun adapter constructs a brand-new
// WSContext wrapper on every single event, so `raw` is the only thing safe
// to compare for identity, never the WSContext object itself.
type WSContext = HonoWSContext<ServerWebSocket>;

// ── Redis fanout ────────────────────────────────────────────────────────
// Every delivery path (agent DM, room broadcast, console push, public feed)
// publishes here instead of writing to the local Maps above directly. This
// process's own subscriber below is what actually walks the Maps and calls
// ws.send — publish-then-deliver-to-self, same as any other subscriber
// would. That makes "how many gateway processes are running" purely a
// deploy question: every instance sees every event and only delivers to the
// sockets it actually holds.
const WS_FANOUT_CHANNEL = "ws:fanout";

type FanoutMessage =
  | { kind: "agent"; agentId: string; event: ReturnType<typeof envelope> }
  | { kind: "broadcast"; event: ReturnType<typeof envelope>; exceptAgentId?: string }
  | { kind: "console"; ownerId: string; event: ReturnType<typeof envelope> }
  | { kind: "public"; event: ReturnType<typeof envelope> };

function publishFanout(msg: FanoutMessage) {
  redis.publish(WS_FANOUT_CHANNEL, JSON.stringify(msg)).catch((err) => {
    log("ws_fanout_publish_error", { kind: msg.kind, error: String(err) });
  });
}

redisSub.subscribe(WS_FANOUT_CHANNEL).catch((err) => {
  console.error("[ws-fanout] subscribe failed", err);
});

redisSub.on("message", (_channel: string, raw: string) => {
  let msg: FanoutMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  switch (msg.kind) {
    case "agent": {
      const conn = connections.get(msg.agentId);
      conn?.ws.send(JSON.stringify(msg.event));
      break;
    }
    case "broadcast": {
      const payload = JSON.stringify(msg.event);
      for (const [agentId, conn] of connections) {
        if (agentId === msg.exceptAgentId) continue;
        conn.ws.send(payload);
      }
      break;
    }
    case "console": {
      const sockets = consoleConnections.get(msg.ownerId);
      if (!sockets) break;
      const payload = JSON.stringify(msg.event);
      for (const ws of sockets) ws.send(payload);
      break;
    }
    case "public": {
      if (publicConnections.size === 0) break;
      const payload = JSON.stringify(msg.event);
      for (const ws of publicConnections) ws.send(payload);
      break;
    }
  }
});

export function broadcastToOwnerConsole(ownerId: string, event: ReturnType<typeof envelope>): void {
  publishFanout({ kind: "console", ownerId, event });
}

// The disconnect+notify side effect of a visit ending — one place for it
// since every caller (agentAuth, this module's own WS connect handler,
// jobs/visits.ts's sweep, owners.ts's stop-visit route) needs the exact same
// three things: kick any live socket, leave an attention trail in the
// console event log, and push a live update to any open console.
export async function announceVisitEnded(ended: { agentId: string; ownerId: string; id: string; reason: string }): Promise<void> {
  forceDisconnectAgent(ended.agentId, VISIT_CLOSE_CODE, `visit ended: ${ended.reason}`);
  await db.insert(consoleEvents).values({
    agentId: ended.agentId,
    ownerId: ended.ownerId,
    severity: "attention",
    summary: `Visit ended (${ended.reason.replace(/_/g, " ")})`,
  });
  broadcastToOwnerConsole(
    ended.ownerId,
    envelope(WS_EVENTS.VISIT_ENDED, { agent_id: ended.agentId, visit_id: ended.id, reason: ended.reason }),
  );
  log("visit_ended", { agentId: ended.agentId, ownerId: ended.ownerId, visitId: ended.id, reason: ended.reason });
}

export function broadcastToPublic(event: ReturnType<typeof envelope>): void {
  publishFanout({ kind: "public", event });
}

function broadcast(event: ReturnType<typeof envelope>, exceptAgentId?: string) {
  publishFanout({ kind: "broadcast", event, exceptAgentId });
}

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
// safe.
async function filterEarlyAcked<T extends { id: string }>(
  kind: "msg" | "mention",
  keyParts: (id: string) => string[],
  entries: T[],
): Promise<T[]> {
  if (!entries.length) return entries;
  const pipe = redis.pipeline();
  for (const e of entries) pipe.exists(earlyAckKey(kind, keyParts(e.id)));
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

// Offline delivery: replays anything this agent missed while disconnected.
// Messages replay from each conversation's lastDeliveredAt cursor (only
// advanced by an explicit client ack, see onMessage below); A2A tasks replay
// every still-'submitted' task addressed to this agent, since 'submitted'
// already means "not yet acted on" — no separate delivered/acked column
// needed there, the state machine itself gates redelivery.
async function deliverBacklog(agentId: string, ws: WSContext): Promise<{ messages: number; tasks: number; mentions: number; participantJoins: number }> {
  const participantRows = await db.query.conversationParticipants.findMany({
    where: eq(conversationParticipants.agentId, agentId),
  });

  let messagesDelivered = 0;
  let participantJoinsDelivered = 0;
  for (const p of participantRows) {
    // Cache-first (item 3): the Postgres query below is the fallback for a
    // cold or cursor-uncovered cache. Cached entries are newest-first; the
    // wire order stays oldest-first like the Postgres ORDER BY.
    const cached = await readBacklogCache(p.conversationId, agentId, p.lastDeliveredAt);
    const persisted =
      cached !== null
        ? [...cached].reverse()
        : await db.query.messages.findMany({
            where: and(
              eq(messages.conversationId, p.conversationId),
              gt(messages.createdAt, p.lastDeliveredAt),
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
      ...(await readPendingIngest(p.conversationId, agentId, p.lastDeliveredAt, seenBacklogIds)),
    ]);
    for (const m of backlog) {
      ws.send(
        JSON.stringify(
          envelope(WS_EVENTS.MESSAGE, {
            conversation_id: m.conversationId,
            message_id: m.id,
            sender_id: m.senderAgentId,
            content: m.content,
            reply_to_id: m.replyToId,
            ts: typeof m.createdAt === "number" ? m.createdAt : m.createdAt.getTime(),
          }),
        ),
      );
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
        gt(conversationParticipants.joinedAt, p.lastDeliveredAt),
        ne(conversationParticipants.agentId, agentId),
      ),
      orderBy: (cp, { asc }) => [asc(cp.joinedAt)],
      limit: BACKLOG_MESSAGES_PER_CONVERSATION,
    });
    for (const joined of newJoins) {
      ws.send(
        JSON.stringify(
          envelope(WS_EVENTS.THREAD_PARTICIPANT_JOINED, {
            conversation_id: p.conversationId,
            agent_id: joined.agentId,
            invited_by: null,
          }),
        ),
      );
      participantJoinsDelivered += 1;
    }
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
  const persistedMentions = await filterEarlyAcked("mention", (id) => [id], allPersistedMentions);
  // Unpersisted mention rows still sitting in the ingest stream (same race
  // as messages above): append after the persisted ones, oldest-first.
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
  pendingMentions.push(...(await readPendingMentions(agentId, seenMentionIds)));
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

  return { messages: messagesDelivered, tasks: pendingTasks.length, mentions: pendingMentions.length, participantJoins: participantJoinsDelivered };
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
      }
      return;
    }
    await db.update(mentions).set({ ackedAt: new Date() }).where(and(eq(mentions.id, mentionId), eq(mentions.targetAgentId, agentId)));
    return;
  }
  if (!conversationId || !messageId) return;

  const message = await db.query.messages.findFirst({
    where: and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)),
  });
  if (!message) {
    // Same early-ACK race as mentions above: stash it for the backlog filter.
    if (UUID_RE.test(messageId)) {
      await redis.set(earlyAckKey("msg", [conversationId, agentId, messageId]), "1", "EX", EARLY_ACK_TTL_SECONDS);
    }
    return;
  }

  await db
    .update(conversationParticipants)
    .set({ lastDeliveredAt: message.createdAt })
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.agentId, agentId),
        lt(conversationParticipants.lastDeliveredAt, message.createdAt),
      ),
    );

  log("message_ack", {
    agentId,
    conversationId,
    messageId,
    ackLatencyMs: Date.now() - message.createdAt.getTime(),
  });
}

export function registerAgentWsRoute(app: {
  get: (path: string, ...handlers: unknown[]) => unknown;
}) {
  app.get(
    "/agents/ws",
    upgradeWebSocket((c) => {
      let agentId: string | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;

      return {
        onOpen: async (_event, ws) => {
          // Ticket-only auth: one-time short-TTL credential (POST
          // /auth/ws-ticket), redeemed via GETDEL so a leaked query string is
          // worthless after first use. The legacy ?token= path is retired —
          // a long-lived credential must never appear in a query string /
          // access log.
          const ticket = c.req.query("ticket");
          let agent;
          if (ticket) {
            const ticketAgentId = await redis.getdel(`wsticket:agent:${ticket}`);
            if (ticketAgentId) {
              agent = await db.query.agents.findFirst({ where: eq(agents.id, ticketAgentId) });
              if (agent) log("agent_auth", { agentId: agent.id, authMethod: "ws_ticket" });
            }
          }
          if (!agent) {
            ws.close(4001, "invalid ticket");
            return;
          }
          if (agent.status === "paused") {
            ws.close(4003, "agent paused");
            return;
          }
          if (!agent.ownerId) {
            ws.close(4005, "agent unclaimed");
            return;
          }
          // "GET" — connecting isn't an action to spend budget on, but an
          // agent whose visit already ended (deadline or cap, possibly not
          // yet swept) must not be able to open a fresh socket. Real actions
          // still go through agentAuth's own check on the HTTP call that
          // sends them; this only guards presence/delivery over the socket.
          const visit = await checkAndConsumeVisit(agent.id, "GET");
          if (!visit.allowed) {
            if (visit.ended) await announceVisitEnded(visit.ended);
            ws.close(VISIT_CLOSE_CODE, `visit ended`);
            return;
          }

          agentId = agent.id;
          const capabilities = (agent.agentCard as { capabilities?: string[] })
            .capabilities ?? [];

          // Same agent identity, second connection: never leave the old
          // socket as a silent zombie (it was previously just overwritten in
          // the Map, orphaned but still open). Explicitly replace: close the
          // old one, then register the new one. The old socket's own onClose
          // will still fire async — the `conn.ws.raw === ws.raw` identity
          // check there is what stops it from clobbering this (the new)
          // connection's state once it runs. Compare `.raw` (the underlying
          // Bun socket), not the WSContext wrapper itself — Hono's Bun
          // adapter constructs a brand-new WSContext on every single event
          // (open/message/close), so `conn.ws === ws` is false by
          // construction on every call, not just during a real replace race.
          const existing = connections.get(agent.id);
          if (existing) {
            existing.ws.close(4006, "replaced by a new connection for the same agent");
            connections.delete(agent.id);
          }

          await timed("postgres_write", { table: "agents", op: "set_online" }, () =>
            db.update(agents).set({ status: "online", lastSeenAt: new Date() }).where(eq(agents.id, agent.id)),
          );

          const conn: Connection = {
            agentId: agent.id,
            ownerId: agent.ownerId,
            name: agent.name,
            capabilities,
            ws,
            missedPings: 0,
          };
          connections.set(agent.id, conn);
          // Item 4: the TTL key is the live presence truth; the DB status
          // write above stays as the transition record / Redis-down fallback.
          await timed("redis_write", { key: "presence", op: "set" }, () => setPresence(agent.id));

          ws.send(JSON.stringify(envelope(WS_EVENTS.AGENT_CONNECTED, { agent_id: agent.id })));

          const backlogStart = performance.now();
          const backlog = await deliverBacklog(agent.id, ws);
          log("ws_connect", {
            agentId: agent.id,
            ownerId: agent.ownerId,
            backlogMessages: backlog.messages,
            backlogTasks: backlog.tasks,
            backlogMentions: backlog.mentions,
            backlogParticipantJoins: backlog.participantJoins,
            backlogMs: Math.round(performance.now() - backlogStart),
          });

          broadcast(
            envelope(WS_EVENTS.AGENT_JOINED, {
              agent_id: agent.id,
              name: agent.name,
              capabilities,
            }),
            agent.id,
          );

          broadcastToOwnerConsole(
            agent.ownerId,
            envelope(WS_EVENTS.AGENT_STATUS_CHANGED, { agent_id: agent.id, status: "online" }),
          );

          heartbeat = setInterval(() => {
            if (connections.get(agent.id) !== conn) return;
            if (conn.missedPings >= 2) {
              log("ws_heartbeat_timeout", {
                agentId: agent.id,
                ownerId: agent.ownerId,
                missedPings: conn.missedPings,
              });
              ws.close(4002, "heartbeat timeout");
              return;
            }
            conn.missedPings += 1;
            ws.send(JSON.stringify(envelope(WS_EVENTS.PING, {})));
            setPresence(agent.id).catch(() => {});
          }, 30_000);
        },
        onMessage: async (event, ws) => {
          if (!agentId) return;
          try {
            const msg = JSON.parse(String(event.data));
            if (msg.type === WS_EVENTS.PONG) {
              const conn = connections.get(agentId);
              // Same identity guard as onClose: a frame from a socket that's
              // already been replaced (see onOpen's close-and-replace logic)
              // must not touch the new connection's state.
              if (conn && conn.ws.raw === ws.raw) {
                conn.missedPings = 0;
                setPresence(agentId).catch(() => {});
              }
            }
            if (msg.type === WS_EVENTS.ACK) {
              await handleAck(agentId, msg.payload);
            }
          } catch {
            // ignore malformed frames in phase 1; real message handling lands phase 2
          }
        },
        onClose: async (_event, ws) => {
          if (heartbeat) clearInterval(heartbeat);
          if (!agentId) return;
          const conn = connections.get(agentId);
          // A newer connection for this same agent already replaced us
          // (see the `existing` replace-on-connect logic above) — this
          // socket's own cleanup is a no-op, the new one owns presence now.
          if (!conn || conn.ws.raw !== ws.raw) return;
          const closedOwnerId = conn.ownerId;
          connections.delete(agentId);
          await clearPresence(agentId);
          // Don't clobber a status the owner/system deliberately set (paused,
          // budget_exhausted) just because the socket that carried it closed —
          // only transient connection states (online/away) reset to offline.
          await db
            .update(agents)
            .set({ status: "offline", lastSeenAt: new Date() })
            .where(and(eq(agents.id, agentId), notInArray(agents.status, ["paused", "budget_exhausted"])));
          broadcast(envelope(WS_EVENTS.AGENT_LEFT, { agent_id: agentId }));
          log("ws_disconnect", { agentId, ownerId: closedOwnerId });
          if (closedOwnerId) {
            broadcastToOwnerConsole(
              closedOwnerId,
              envelope(WS_EVENTS.AGENT_STATUS_CHANGED, { agent_id: agentId, status: "offline" }),
            );
          }
        },
      };
    }),
  );
}

export function getConnectedAgentIds(): string[] {
  return [...connections.keys()];
}

// Call once at process boot, before serving traffic. A crash (not a clean
// shutdown) leaves DB rows stuck at status="online" with nobody connected —
// this Postgres-vs-Redis reconciliation is what makes that self-heal instead
// of staying wrong forever. Only demotes rows with no live Redis presence
// key, so a fast restart that lands inside the presence TTL leaves currently
//-reconnecting agents alone.
export async function reconcilePresenceOnBoot(): Promise<void> {
  const onlineAgents = await db.query.agents.findMany({
    where: eq(agents.status, "online"),
  });
  for (const agent of onlineAgents) {
    const stillPresent = await redis.exists(presenceKey(agent.id));
    if (!stillPresent) {
      await db.update(agents).set({ status: "offline" }).where(eq(agents.id, agent.id));
    }
  }
}

// Fire-and-forget: publishes for every gateway process to attempt delivery,
// so there's no synchronous "was it delivered" answer any more (there could
// be several processes, each with a different view of who's connected).
// Callers that logged the old boolean return should check isAgentConnected()
// instead if they want an informational (this-process-only) flag.
export function sendToAgent(agentId: string, event: ReturnType<typeof envelope>): void {
  publishFanout({ kind: "agent", agentId, event });
}

export function forceDisconnectAgent(agentId: string, code: number, reason: string): boolean {
  const conn = connections.get(agentId);
  if (!conn) return false;
  conn.ws.close(code, reason);
  connections.delete(agentId);
  return true;
}

export function isAgentConnected(agentId: string): boolean {
  return connections.has(agentId);
}

export function registerPublicWsRoute(app: {
  get: (path: string, ...handlers: unknown[]) => unknown;
}) {
  app.get(
    "/public/ws",
    upgradeWebSocket(() => ({
      onOpen: (_event, ws) => {
        publicConnections.add(ws);
      },
      onClose: (_event, ws) => {
        publicConnections.delete(ws);
      },
    })),
  );
}

export function registerConsoleWsRoute(app: {
  get: (path: string, ...handlers: unknown[]) => unknown;
}) {
  app.get(
    "/console/ws",
    upgradeWebSocket((c) => {
      const ticket = c.req.query("ticket");
      let ownerId: string | undefined;

      return {
        onOpen: async (_event, ws) => {
          // Ticket-only auth (POST /owners/ws-ticket) — the legacy ?token=
          // session-JWT path is retired along with the agent one.
          const ticketOwnerId = await redis.getdel(`wsticket:owner:${ticket ?? ""}`);
          if (!ticketOwnerId) {
            ws.close(4001, "invalid ticket");
            return;
          }
          ownerId = ticketOwnerId;
          const sockets = consoleConnections.get(ownerId) ?? new Set();
          sockets.add(ws);
          consoleConnections.set(ownerId, sockets);
        },
        onClose: (_event, ws) => {
          if (!ownerId) return;
          consoleConnections.get(ownerId)?.delete(ws);
        },
      };
    }),
  );
}
