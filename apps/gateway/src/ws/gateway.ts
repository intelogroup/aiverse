import { createBunWebSocket } from "hono/bun";
import type { WSContext as HonoWSContext } from "hono/ws";
import type { ServerWebSocket } from "bun";
import { and, eq, notInArray, gt, lt, ne, isNull, isNotNull } from "drizzle-orm";
import { db } from "../db/client";
import { agents, conversationParticipants, messages, a2aTasks, mentions, consoleEvents } from "@aiverse/shared/schema";
import { redis, redisSub } from "../redis/client";
import { recentCacheKey, INGEST_STREAM } from "../jobs/ingestConsumer";
import { presenceKey, setPresence, clearPresence } from "../presence";
import { envelope, WS_EVENTS } from "./events";
import { ackCursorMode, ackCursorsEnabled, advanceAckCursor, addMentionAck, getAckCursorsMs } from "./ackCursors";
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
  // Register-first (PHASE0_SPEC §1): the socket enters the fanout registry
  // in this state immediately after the ticket GETDEL yields the agentId,
  // BEFORE the reconnect budget, the agent-row fetch, the gates and the
  // backlog run. While "setting_up", fanout frames addressed to this
  // socket append to `pending` instead of being written; the buffer
  // flushes after the backlog, and only then does the connection go
  // "live". Mirrors the Go edge's conn.settingUp/pending
  // (apps/go-edge/internal/edge/edge.go).
  state: "setting_up" | "live";
  pending: string[];
  droppedPending: number;
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

// Bounded pending buffer for a setting-up connection (PHASE0_SPEC §1,
// mirroring the Go edge's maxPendingBuffer): fanout frames arriving
// during connect setup append to the buffer; on overflow the frame is
// dropped and counted — never queued unboundedly, never written early.
const MAX_PENDING_BUFFER = 1024;

// The one delivery path for agent sockets: buffered while the connection
// is setting up, straight to the socket once live. Acks keep their
// meaning throughout — delivery (and any client ack it can trigger) only
// ever follows an actual socket write, here or in the post-backlog flush.
function deliverToAgentConn(conn: Connection, payload: string): void {
  if (conn.state === "setting_up") {
    if (conn.pending.length < MAX_PENDING_BUFFER) {
      conn.pending.push(payload);
    } else {
      conn.droppedPending += 1;
    }
    return;
  }
  conn.ws.send(payload);
}

// Extracts payload.message_id from a serialized "message" envelope — the
// dedupe key between the reconnect backlog and the register-first pending
// buffer (same rule as the Go edge's messageEnvelopeID: message envelopes
// only, everything else always flushes).
function messageEnvelopeId(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { type?: string; payload?: { message_id?: unknown } };
    if (parsed.type !== WS_EVENTS.MESSAGE) return null;
    const id = parsed.payload?.message_id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
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
      if (conn) deliverToAgentConn(conn, JSON.stringify(msg.event));
      break;
    }
    case "broadcast": {
      const payload = JSON.stringify(msg.event);
      const isDigest = msg.event.type === WS_EVENTS.PRESENCE_DIGEST;
      for (const [agentId, conn] of connections) {
        if (agentId === msg.exceptAgentId) continue;
        if (isDigest) {
          // Presence digests strip the receiving socket's own agent_id
          // per receiver (and are skipped entirely when nothing remains
          // for that socket) — see stripPresenceDigest below.
          const stripped = stripPresenceDigest(msg.event, payload, agentId);
          if (stripped === null) continue;
          deliverToAgentConn(conn, stripped);
        } else {
          deliverToAgentConn(conn, payload);
        }
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

// ── Presence digests (FANOUT_FIX_SPEC) ────────────────────────────────
// This gateway's own join/left events collect into a pending buffer with
// last-write-wins netting per agent, and flush as ONE presence_digest
// broadcast — replacing the per-event agent_joined/agent_left blasts,
// whose O(n²) socket writes drowned message delivery in the 5k soak.
// Presence truth stays in the Redis presence:* keys + DB status; the
// digest is advisory, like the frames it replaces. The Go edge ships the
// identical protocol (apps/go-edge/FANOUT_FIX_SPEC.md); this is its port.
const PRESENCE_DIGEST_WINDOW_MS = 1000;
const PRESENCE_DIGEST_MAX_PENDING = 250;

interface PresenceDigestJoined {
  agent_id: string;
  name: string;
  capabilities: string[];
}

// digestOrder holds agent ids in first-seen order; each id sits in
// exactly one of digestJoined / digestLeft (last-write-wins netting).
const digestJoined = new Map<string, PresenceDigestJoined>();
const digestLeft = new Set<string>();
const digestOrder: string[] = [];
let digestFlusherStarted = false;

// Started lazily on first collect: importing this module (tests, tooling)
// never spins a timer before there's anything to flush, and the
// module-singleton state means repeated createApp() calls can't
// double-start it. Once running it ticks for the process's lifetime,
// flushing whatever window has accumulated (empty → no publish).
function ensureDigestFlusher() {
  if (digestFlusherStarted) return;
  digestFlusherStarted = true;
  setInterval(flushPresenceDigest, PRESENCE_DIGEST_WINDOW_MS);
}

// Nets a join into the pending digest: any pending left for the agent is
// superseded. The published console status event is unaffected (still
// per-event, owner-scoped).
function recordPresenceJoined(agentId: string, name: string, capabilities: string[]) {
  ensureDigestFlusher();
  if (digestLeft.has(agentId)) {
    digestLeft.delete(agentId);
  } else if (!digestJoined.has(agentId)) {
    digestOrder.push(agentId);
  }
  digestJoined.set(agentId, { agent_id: agentId, name, capabilities });
  if (digestOrder.length >= PRESENCE_DIGEST_MAX_PENDING) flushPresenceDigest();
}

// Nets a departure into the pending digest: any pending join for the
// agent is superseded.
function recordPresenceLeft(agentId: string) {
  ensureDigestFlusher();
  if (digestJoined.has(agentId)) {
    digestJoined.delete(agentId);
  } else if (!digestLeft.has(agentId)) {
    digestOrder.push(agentId);
  }
  digestLeft.add(agentId);
  if (digestOrder.length >= PRESENCE_DIGEST_MAX_PENDING) flushPresenceDigest();
}

// Publishes the pending set as one presence_digest broadcast, entries in
// first-seen order. Empty buffer → no publish.
function flushPresenceDigest() {
  if (digestOrder.length === 0) return;
  const joined: PresenceDigestJoined[] = [];
  const left: { agent_id: string }[] = [];
  for (const agentId of digestOrder) {
    const j = digestJoined.get(agentId);
    if (j) joined.push(j);
    else left.push({ agent_id: agentId });
  }
  digestJoined.clear();
  digestLeft.clear();
  digestOrder.length = 0;
  broadcast(envelope(WS_EVENTS.PRESENCE_DIGEST, { joined, left }));
}

// Removes selfAgentId from a digest envelope's joined and left lists for
// one receiving socket. Returns null when nothing remains for this
// socket — the write is skipped. When nothing is stripped, the original
// serialized payload passes through untouched.
function stripPresenceDigest(
  event: ReturnType<typeof envelope>,
  rawPayload: string,
  selfAgentId: string,
): string | null {
  try {
    const payload = event.payload as {
      joined?: PresenceDigestJoined[];
      left?: { agent_id: string }[];
    };
    const joinedIn = payload.joined ?? [];
    const leftIn = payload.left ?? [];
    const joined = joinedIn.filter((j) => j.agent_id !== selfAgentId);
    const left = leftIn.filter((l) => l.agent_id !== selfAgentId);
    if (joined.length === 0 && left.length === 0) return null;
    if (joined.length === joinedIn.length && left.length === leftIn.length) return rawPayload;
    return JSON.stringify({ ...event, payload: { joined, left } });
  } catch {
    // Unreadable digest shape — deliver as-is rather than drop it.
    return rawPayload;
  }
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

// Offline delivery: replays anything this agent missed while disconnected.
// Messages replay from each conversation's lastDeliveredAt cursor (only
// advanced by an explicit client ack, see onMessage below); A2A tasks replay
// every still-'submitted' task addressed to this agent, since 'submitted'
// already means "not yet acted on" — no separate delivered/acked column
// needed there, the state machine itself gates redelivery.
async function deliverBacklog(agentId: string, ws: WSContext): Promise<{ messages: number; tasks: number; mentions: number; participantJoins: number; messageIds: Set<string> }> {
  const participantRows = await db.query.conversationParticipants.findMany({
    where: eq(conversationParticipants.agentId, agentId),
  });

  // Cursor acks v1 (PHASE1_SPEC WI-4 / discrepancy D4): the effective
  // cursor is max(PG lastDeliveredAt, Redis hot cursor). Inside the
  // checkpoint window the PG column alone lags by up to one interval;
  // reading it directly would replay already-acked messages on every
  // reconnect. Legacy mode never touches Redis here — PG only, as before.
  const redisCursors = ackCursorsEnabled()
    ? await getAckCursorsMs(agentId, participantRows.map((p) => p.conversationId))
    : new Map<string, number>();
  const effectiveCursor = (p: (typeof participantRows)[number]): Date => {
    const redisMs = redisCursors.get(p.conversationId);
    return redisMs !== undefined && redisMs > p.lastDeliveredAt.getTime()
      ? new Date(redisMs)
      : p.lastDeliveredAt;
  };

  let messagesDelivered = 0;
  let participantJoinsDelivered = 0;
  // Ids of every message envelope written here — the register-first
  // flush dedupes the setting-up buffer against this set (a frame that
  // fanned out live during setup AND made the backlog is delivered
  // once, from the backlog).
  const deliveredMessageIds = new Set<string>();
  for (const p of participantRows) {
    const lastDeliveredAt = effectiveCursor(p);
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
      deliveredMessageIds.add(m.id);
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

// Reconnect budget: per-agent fixed-window counter in Redis. On exceed,
// the connect is shed with close 4009 and a retry_after_ms hint (ms until
// the window resets) in the close reason — the server-driven retry hint
// that, with client-side jittered backoff, keeps a shed fleet from
// re-synchronizing into a second storm.
export const RECONNECT_BUDGET_CLOSE_CODE = 4009;
const RECONNECT_BUDGET_LIMIT = 30;
const RECONNECT_BUDGET_WINDOW_SECONDS = 300;

// Returns 0 when this connect is within budget, else the ms until the
// current window resets.
async function consumeReconnectBudget(agentId: string): Promise<number> {
  const key = `ws:reconnect:${agentId}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, RECONNECT_BUDGET_WINDOW_SECONDS);
  if (count <= RECONNECT_BUDGET_LIMIT) return 0;
  const pttl = await redis.pttl(key);
  return pttl > 0 ? pttl : RECONNECT_BUDGET_WINDOW_SECONDS * 1000;
}

// Connect admission: a per-process token bucket guarding the TLS+auth
// CPU a connect storm burns before any ticket is even redeemed. 200/s
// sustained, 400 burst by default; env-tunable with the production values
// as defaults, same pattern as the singleton-job intervals. The bucket
// re-clamps to the current cap on every check, so an env change takes
// effect on the next connect without a restart.
function connectRatePerSec(): number {
  const v = Number(process.env.AIVERSE_WS_CONNECT_RATE_PER_SEC);
  return Number.isFinite(v) && v >= 0 ? v : 200;
}
function connectBurstAllowance(): number {
  const v = Number(process.env.AIVERSE_WS_CONNECT_BURST);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 400;
}
let connectBucketTokens: number | undefined;
let connectBucketLastMs = Date.now();

function tryAdmitAgentConnect(): boolean {
  const cap = connectBurstAllowance();
  const now = Date.now();
  if (connectBucketTokens === undefined) connectBucketTokens = cap;
  connectBucketTokens = Math.min(
    cap,
    connectBucketTokens + ((now - connectBucketLastMs) / 1000) * connectRatePerSec(),
  );
  connectBucketLastMs = now;
  if (connectBucketTokens >= 1) {
    connectBucketTokens -= 1;
    return true;
  }
  return false;
}

// Hono handler placed ahead of upgradeWebSocket on /agents/ws: returning
// a response here ends the chain, so a shed connect costs one token check
// — no upgrade, no ticket redemption, no DB work. Existing connections
// are never touched by shedding; they are the expensive-to-rebuild asset.
function agentConnectAdmission(
  c: { text: (body: string, status: number, headers?: Record<string, string>) => Response },
  next: () => Promise<unknown>,
): Promise<unknown> | Response {
  if (!tryAdmitAgentConnect()) {
    return c.text("too many connection attempts", 503, { "Retry-After": "1" });
  }
  return next();
}

export function registerAgentWsRoute(app: {
  get: (path: string, ...handlers: unknown[]) => unknown;
}) {
  app.get(
    "/agents/ws",
    agentConnectAdmission,
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
          let ticketAgentId: string | null = null;
          if (ticket) {
            ticketAgentId = await redis.getdel(`wsticket:agent:${ticket}`);
          }
          if (!ticketAgentId) {
            ws.close(4001, "invalid ticket");
            return;
          }

          agentId = ticketAgentId;

          // Register-first (PHASE0_SPEC §1): this socket joins the fanout
          // registry NOW, in setting_up state — the GETDEL above is the
          // only await in front of registration. The first reorder still
          // left the reconnect-budget check and the agent-row fetch ahead
          // of this point, and the burst re-soak showed why that is too
          // late: under a connect storm the PG SELECT queues behind
          // thousands of concurrent connect-path queries, so most sockets
          // had not reached registration when the burst fired (connecting
          // cohort 44,434/250,000 with zero pending-buffer overflows —
          // the frames were never buffered because the sockets were not
          // registered yet). The record needs only the ticket's agentId
          // here; the row's owner/name/capabilities are filled in on it
          // once the fetch lands (nothing reads them while setting_up —
          // fanout delivery only buffers raw frames). Fanout frames that
          // arrive during setup buffer on the connection record (bounded:
          // MAX_PENDING_BUFFER) and flush after the backlog instead of
          // being lost to registration lag, which is exactly the window
          // the original burst soak measured at 0/250,000 for the
          // connecting cohort. An incumbent connection for the same agent
          // is displaced from the registry by this registration — it
          // stops receiving fanout immediately — but it is only *closed*
          // (4006) at the replace step after the gates pass: a refusal
          // restores it untouched, matching the Go edge's observable
          // gate-failure behavior.
          const conn: Connection = {
            agentId: ticketAgentId,
            ownerId: "",
            name: "",
            capabilities: [],
            ws,
            missedPings: 0,
            state: "setting_up",
            pending: [],
            droppedPending: 0,
          };
          const displaced = connections.get(ticketAgentId);
          connections.set(ticketAgentId, conn);

          // Refusal during setup (reconnect budget, missing agent row,
          // or any gate below): unregister (the pending buffer is
          // discarded unsent), then close with the refusal's code.
          // Nothing was delivered, no presence key was written, no
          // digest join is collected — no residue. The displaced
          // incumbent is restored for refusals that say nothing about
          // the incumbent (budget, missing row, and the 4003/4005
          // agent-state gates: it is the same agent in the same state,
          // and pre-register-first it was never touched). For a
          // visit-ended refusal (4008) there is no restore: the visit is
          // over for the incumbent too, and it only escaped the
          // announce's force-disconnect because this registration had
          // already displaced it — so it is closed with the same code.
          const failSetup = (code: number, reason: string, restoreDisplaced: boolean) => {
            if (connections.get(conn.agentId) === conn) {
              connections.delete(conn.agentId);
              if (displaced && restoreDisplaced) {
                if (displaced.ws.raw.readyState === 1) {
                  connections.set(conn.agentId, displaced);
                } else {
                  // The incumbent died inside the setup window; its
                  // onClose identity-failed against this registration, so
                  // its departure was never announced. Announce the leave
                  // and drop its presence key here; the DB status write is
                  // left to the boot reconciler (bounded, self-healing).
                  recordPresenceLeft(conn.agentId);
                  clearPresence(conn.agentId).catch(() => {});
                }
              }
            }
            if (displaced && !restoreDisplaced) {
              displaced.ws.close(code, reason);
            }
            conn.pending = [];
            ws.close(code, reason);
          };

          // Burst defense (PHASE0_SPEC §2): the per-agent reconnect
          // budget is spent before any DB work — a storming agent costs
          // one Redis INCR per attempt from here on. The socket is
          // already registered at this point, so a budget refusal flows
          // through the same unregister + restore path as a gate
          // failure; the close code and reason are unchanged.
          const retryAfterMs = await consumeReconnectBudget(ticketAgentId);
          if (retryAfterMs > 0) {
            log("ws_reconnect_budget_exceeded", { agentId: ticketAgentId, retryAfterMs });
            failSetup(RECONNECT_BUDGET_CLOSE_CODE, JSON.stringify({ retry_after_ms: retryAfterMs }), true);
            return;
          }

          const agent = await db.query.agents.findFirst({ where: eq(agents.id, ticketAgentId) });
          if (!agent) {
            failSetup(4001, "invalid ticket", true);
            return;
          }
          log("agent_auth", { agentId: agent.id, authMethod: "ws_ticket" });

          // Complete the registry record with the row's identity fields
          // now that the fetch has landed.
          const capabilities = (agent.agentCard as { capabilities?: string[] })
            .capabilities ?? [];
          conn.ownerId = agent.ownerId ?? "";
          conn.name = agent.name;
          conn.capabilities = capabilities;

          if (agent.status === "paused") {
            failSetup(4003, "agent paused", true);
            return;
          }
          if (!agent.ownerId) {
            failSetup(4005, "agent unclaimed", true);
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
            failSetup(VISIT_CLOSE_CODE, `visit ended`, false);
            return;
          }

          // A force-disconnect (the visit sweep kicking this agent) may
          // have unregistered this socket while the gates ran — its close
          // is already handled there; don't resurrect it.
          if (connections.get(agent.id) !== conn) return;

          // Replace semantics (4006): same agent identity, second
          // connection — never leave the old socket as a silent zombie.
          // The old socket's own onClose will still fire async — the
          // `conn.ws.raw === ws.raw` identity check there is what stops it
          // from clobbering this (the new) connection's state once it
          // runs. Compare `.raw` (the underlying Bun socket), not the
          // WSContext wrapper itself — Hono's Bun adapter constructs a
          // brand-new WSContext on every single event (open/message/
          // close), so `conn.ws === ws` is false by construction on every
          // call, not just during a real replace race.
          if (displaced) {
            displaced.ws.close(4006, "replaced by a new connection for the same agent");
          }

          await timed("postgres_write", { table: "agents", op: "set_online" }, () =>
            db.update(agents).set({ status: "online", lastSeenAt: new Date() }).where(eq(agents.id, agent.id)),
          );

          // Item 4: the TTL key is the live presence truth; the DB status
          // write above stays as the transition record / Redis-down fallback.
          await timed("redis_write", { key: "presence", op: "set" }, () => setPresence(agent.id));

          ws.send(JSON.stringify(envelope(WS_EVENTS.AGENT_CONNECTED, { agent_id: agent.id })));

          // Test hook (mirrors the Go edge's backlogDelay field, zero in
          // production): stretches the setting-up window so the
          // register-first test can fan a frame out mid-setup
          // deterministically instead of racing the backlog.
          const backlogDelayMs = Number(process.env.AIVERSE_WS_BACKLOG_DELAY_MS);
          if (Number.isFinite(backlogDelayMs) && backlogDelayMs > 0) {
            await new Promise((r) => setTimeout(r, backlogDelayMs));
          }

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

          // Flush the setting-up buffer (PHASE0_SPEC §1 step 5): backlog
          // first (delivered above), then buffered frames in arrival
          // order, skipping message envelopes the backlog already
          // delivered — the same dedupe rule as the Go edge's
          // flushPending. The loop is synchronous, so no fanout delivery
          // can interleave between buffer and socket; the connection is
          // live from the assignment after it.
          const buffered = conn.pending;
          conn.pending = [];
          for (const raw of buffered) {
            const mid = messageEnvelopeId(raw);
            if (mid && backlog.messageIds.has(mid)) continue;
            ws.send(raw);
          }
          if (conn.droppedPending > 0) {
            log("ws_pending_overflow", { agentId: agent.id, dropped: conn.droppedPending });
          }
          conn.state = "live";

          // The socket may have closed mid-setup — onClose already ran
          // its cleanup and unregistered it. Don't announce a join (or
          // start a heartbeat) for a connection that no longer exists.
          if (connections.get(agent.id) !== conn) return;

          // Presence digest collection point (PHASE0_SPEC §1 step 7):
          // the join collects only now that the connection is live — a
          // gate-failed or never-completed setup never appears in a
          // digest, same as the Go edge.
          recordPresenceJoined(agent.id, agent.name, capabilities);

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
          // (see the displaced replace-on-connect logic above) — this
          // socket's own cleanup is a no-op, the new one owns presence now.
          if (!conn || conn.ws.raw !== ws.raw) return;
          const closedOwnerId = conn.ownerId;
          // A connection that never went live never announced a join
          // (register-first: the digest join collects at the live
          // transition), so it must not announce a leave or an offline
          // status either. Registry/presence/status cleanup still runs —
          // setup may have written the online transition already.
          const wasLive = conn.state === "live";
          connections.delete(agentId);
          await clearPresence(agentId);
          // Don't clobber a status the owner/system deliberately set (paused,
          // budget_exhausted) just because the socket that carried it closed —
          // only transient connection states (online/away) reset to offline.
          await db
            .update(agents)
            .set({ status: "offline", lastSeenAt: new Date() })
            .where(and(eq(agents.id, agentId), notInArray(agents.status, ["paused", "budget_exhausted"])));
          if (wasLive) recordPresenceLeft(agentId);
          log("ws_disconnect", { agentId, ownerId: closedOwnerId });
          if (wasLive && closedOwnerId) {
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
