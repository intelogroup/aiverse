// Redis/bus fanout publish + local delivery primitives (extracted from
// ws/gateway.ts, cleanup L2; behavior unchanged). The fanout message
// dispatcher itself (handleFanoutMessage) stays in ws/gateway.ts, which
// composes these primitives with the presence scoping in ws/presence.ts.
import { redis } from "../redis/client";
import { log } from "../util/log";
import { notifyAgentGone } from "../world/hooks";
import { MidDedupe, busMode, newMid, publishBus, subjectForFanout } from "./bus";
import { pokeBusReconcile } from "./busSubscriptions";
import { connections, type Connection, type WSContext } from "./connections";
import { WS_EVENTS, type envelope } from "./events";

// ── Redis fanout ────────────────────────────────────────────────────────
// Every delivery path (agent DM, room broadcast, console push, public feed)
// publishes here instead of writing to the local Maps above directly. This
// process's own subscriber below is what actually walks the Maps and calls
// ws.send — publish-then-deliver-to-self, same as any other subscriber
// would. That makes "how many gateway processes are running" purely a
// deploy question: every instance sees every event and only delivers to the
// sockets it actually holds.
export const WS_FANOUT_CHANNEL = "ws:fanout";

export type FanoutMessage = (
  | { kind: "agent"; agentId: string; event: ReturnType<typeof envelope> }
  // `roomConversationId` (WI-3) marks a room-scoped broadcast: delivery
  // is restricted to sockets whose connection room set contains the
  // conversation (see the subscriber below).
  | { kind: "broadcast"; event: ReturnType<typeof envelope>; exceptAgentId?: string; roomConversationId?: string }
  | { kind: "console"; ownerId: string; event: ReturnType<typeof envelope> }
  | { kind: "public"; event: ReturnType<typeof envelope> }
) & {
  // WI-2 (Phase 2 bus migration, additive): `mid` is the uuidv7 stamped
  // by publishFanout — the dual-run dedupe key (bus.ts). `skipAgentIds`
  // is the room publish's exclusion list (sender + passive participants,
  // computed once by the send path) so gateway-side fanout from the
  // room subject reproduces the legacy per-recipient loop's exact
  // delivery set. Both are internal bus metadata, stripped with the
  // envelope before any socket write.
  mid?: string;
  skipAgentIds?: string[];
};

// Publish routing follows AIVERSE_BUS_MODE (bus.ts): legacy publishes
// to the Redis channel only (today's behavior), dual publishes to both
// transports with the SAME stamped mid, nats publishes to the scoped
// NATS subject only. The Redis leg is extracted so sendToConversation
// can run its dual-mode split (per-recipient legacy copies + one room
// publish) without the room frame ever landing on the legacy channel —
// a legacy subscriber must see exactly today's per-recipient stream.
function publishLegacyFanout(stamped: FanoutMessage) {
  redis.publish(WS_FANOUT_CHANNEL, JSON.stringify(stamped)).catch((err) => {
    log("ws_fanout_publish_error", { kind: stamped.kind, error: String(err) });
  });
}

function publishFanout(msg: FanoutMessage) {
  const mode = busMode();
  const stamped: FanoutMessage = msg.mid ? msg : { ...msg, mid: newMid() };
  if (mode !== "nats") publishLegacyFanout(stamped);
  if (mode !== "legacy") publishBus(subjectForFanout(stamped), JSON.stringify(stamped));
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
export function deliverToAgentConn(conn: Connection, payload: string): void {
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
export function messageEnvelopeId(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { type?: string; payload?: { message_id?: unknown } };
    if (parsed.type !== WS_EVENTS.MESSAGE) return null;
    const id = parsed.payload?.message_id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

// WI-2 dual-run dedupe: in dual mode every fanout envelope arrives on
// both transports with the same mid; the per-target ring drops the
// second copy. Only dual dedupes — legacy and nats each have exactly
// one live transport. Room-set maintenance above a delivery still runs
// for both copies (it is idempotent); only the socket write is gated.
export function fanoutSeenBefore(owner: { midDedupe?: MidDedupe }, mid: string | undefined): boolean {
  if (busMode() !== "dual" || !mid) return false;
  owner.midDedupe ??= new MidDedupe();
  return owner.midDedupe.check(mid);
}

// Console/public sockets are bare WSContexts (no Connection record);
// their dedupe rings key on the stable underlying socket (`raw`),
// never the per-event wrapper (see the WSContext note at the top).
const socketMidDedupe = new WeakMap<object, MidDedupe>();

export function fanoutSeenBeforeSocket(ws: WSContext, mid: string | undefined): boolean {
  if (busMode() !== "dual" || !mid) return false;
  const key = (ws as { raw?: object }).raw ?? (ws as object);
  let ring = socketMidDedupe.get(key);
  if (!ring) {
    ring = new MidDedupe();
    socketMidDedupe.set(key, ring);
  }
  return ring.check(mid);
}

export function broadcastToOwnerConsole(ownerId: string, event: ReturnType<typeof envelope>): void {
  publishFanout({ kind: "console", ownerId, event });
}

export function broadcastToPublic(event: ReturnType<typeof envelope>): void {
  publishFanout({ kind: "public", event });
}

export function broadcast(event: ReturnType<typeof envelope>, exceptAgentId?: string) {
  publishFanout({ kind: "broadcast", event, exceptAgentId });
}

// The join fanout diet (WI-3 change 4): THREAD_PARTICIPANT_JOINED used
// to cost one fanout publish PER existing participant from the join /
// invite routes — the same O(N) publish shape the digest fixed for
// connect/close. It is now ONE broadcast publish, restricted at
// delivery to sockets whose room set contains the conversation.
// `exceptAgentId` preserves the room-join semantics (the joiner is not
// notified of their own join); invites pass no exception — the invitee
// IS notified, exactly as the old per-participant loop + explicit
// target send delivered it.
export function broadcastParticipantJoined(
  conversationId: string,
  event: ReturnType<typeof envelope>,
  exceptAgentId?: string,
): void {
  publishFanout({ kind: "broadcast", event, exceptAgentId, roomConversationId: conversationId });
}

// ── WI-2 publish shape (PHASE2_SPEC WI-2 step 3) ─────────────────────
// A room message send used to cost one fanout publish PER RECIPIENT
// (the send path's loop over active participants). On the bus it costs
// exactly ONE publish to the room subject, and each gateway fans out to
// its local sockets in the room. The legacy leg keeps the old shape
// verbatim: in legacy mode — and as dual mode's Redis leg — this
// expands to the same per-recipient `agent` publishes the loop made,
// so a legacy subscriber sees exactly today's stream. In dual mode all
// copies (per-recipient legacy + the one room publish) share one mid,
// so a dual subscriber delivers exactly once per socket; in nats mode
// only the room publish happens. `skipAgentIds` (sender + passive
// participants, from the send path's participant rows) rides the room
// frame, reproducing the loop's exclusions at fanout time; mentions and
// control frames keep their direct per-agent publishes and still reach
// passive participants, exactly as before.
export function sendToConversation(params: {
  conversationId: string;
  event: ReturnType<typeof envelope>;
  recipientAgentIds: string[];
  skipAgentIds: string[];
}): void {
  const mode = busMode();
  if (mode === "nats") {
    publishFanout({
      kind: "broadcast",
      event: params.event,
      roomConversationId: params.conversationId,
      skipAgentIds: params.skipAgentIds,
    });
    return;
  }
  const mid = mode === "dual" ? newMid() : undefined;
  for (const agentId of params.recipientAgentIds) {
    if (mode === "dual") {
      publishLegacyFanout({ kind: "agent", agentId, event: params.event, mid });
    } else {
      publishFanout({ kind: "agent", agentId, event: params.event });
    }
  }
  if (mode === "dual") {
    publishBus(
      `room.${params.conversationId}`,
      JSON.stringify({
        kind: "broadcast",
        event: params.event,
        roomConversationId: params.conversationId,
        skipAgentIds: params.skipAgentIds,
        mid,
      } satisfies FanoutMessage),
    );
  }
}

export function getConnectedAgentIds(): string[] {
  return [...connections.keys()];
}

// ---------------------------------------------------------------------------
// Heap budget stats (PHASE2_SPEC WI-6). A 60 s live-heap line on stdout —
// the same log path as everything else in this process — in the Go edge's
// key=value shape (`heap inuse_mb= alloc_mb= sys_mb= gc_count=
// last_gc_pause_ms= conns=`, cmd/edge/main.go formatHeapStats) so soak
// tooling parses one format across both stacks. The TS keys name what Bun
// actually measures (process.memoryUsage): rss_mb / heap_used_mb /
// heap_total_mb, then this process's registry counts. MB values are whole
// numbers (floor — the Go line's >>20 integer style). Plain console.log,
// not the JSON log(): the line's shape is the contract, same as Go's.
// rooms_local aggregates the WI-3 per-connection room sets — computed
// only on this 60 s tick, never on a message path.
// ---------------------------------------------------------------------------

// Fire-and-forget: publishes for every gateway process to attempt delivery,
// so there's no synchronous "was it delivered" answer any more (there could
// be several processes, each with a different view of who's connected).
// Callers that logged the old boolean return should check isAgentConnected()
// instead if they want an informational (this-process-only) flag.
export function sendToAgent(agentId: string, event: ReturnType<typeof envelope>): void {
  publishFanout({ kind: "agent", agentId, event });
}

export function forceDisconnectAgent(agentId: string, code: number, reason: string): boolean {
  notifyAgentGone(agentId, reason); // its world body (if any) goes too, whether or not a socket was open
  const conn = connections.get(agentId);
  if (!conn) return false;
  conn.ws.close(code, reason);
  connections.delete(agentId);
  pokeBusReconcile();
  return true;
}

export function isAgentConnected(agentId: string): boolean {
  return connections.has(agentId);
}
