// Presence v2: connection room sets, presence digests, and oversize
// determinations (extracted from ws/gateway.ts, cleanup L2; behavior
// unchanged).
import { count, eq } from "drizzle-orm";
import { agents, conversationParticipants } from "@aiverse/shared/schema";
import { db } from "../db/client";
import { getOnlineAgentIds, presenceKey } from "../presence";
import { redis } from "../redis/client";
import { log } from "../util/log";
import { pokeBusReconcile } from "./busSubscriptions";
import { connections, type Connection } from "./connections";
import { WS_EVENTS, envelope } from "./events";
import { broadcast } from "./fanout";

// ── Presence v2 room sets (PHASE1_SPEC WI-3) ──────────────────────────
// Writers of Connection.rooms besides the live-transition population:
// these two helpers (routes + the fanout subscriber's own maintenance
// above) — all process-local and best-effort by design, since Postgres
// participant rows remain the truth and the set is rebuilt from them on
// every connect.
export function addConnectionRoom(agentId: string, conversationId: string): void {
  const conn = connections.get(agentId);
  if (conn && !conn.rooms.has(conversationId)) {
    conn.rooms.add(conversationId);
    pokeBusReconcile();
  }
}

export function removeConnectionRoom(agentId: string, conversationId: string): void {
  const conn = connections.get(agentId);
  if (conn && conn.rooms.delete(conversationId)) pokeBusReconcile();
  // The leave route is this helper's only caller: the room's
  // participant rows just changed, so a cached oversize determination
  // for it (below) is stale.
  invalidateOversizeDetermination(conversationId);
}

// ── Presence digests (FANOUT_FIX_SPEC + PHASE1_SPEC WI-3) ───────────
// This gateway's own join/left events collect into a pending buffer with
// last-write-wins netting per agent, and flush as ONE presence_digest
// broadcast — replacing the per-event agent_joined/agent_left blasts,
// whose O(n²) socket writes drowned message delivery in the 5k soak.
// Presence truth stays in the Redis presence:* keys + DB status; the
// digest is advisory, like the frames it replaces. The Go edge ships the
// identical protocol (apps/go-edge/FANOUT_FIX_SPEC.md); this is its port.
//
// WI-3 (presence v2) scopes the digest to room co-members: every entry
// carries a snapshot of the subject's room set (its connection's
// delivery-routing cache) taken at collect time, and delivery keeps an
// entry for a socket only when the socket's agent shares ≥1 room with
// the subject. The fleet-wide "who is online" perception the digest
// used to give every agent narrows to room co-members by design
// (owner-accepted, spec Q3); GET /agents/discover remains the ambient
// who-exists surface. The `rooms` attribution rides the internal fanout
// envelope only — scopePresenceDigest strips it before any socket
// write, so the client wire shape for sub-threshold traffic is
// unchanged. A room whose active (connected-and-joined) membership
// exceeds PRESENCE_OVERSIZE_ROOM_ACTIVE_THRESHOLD stops enumerating:
// its attributable entries collapse into a per-room presence_summary of
// counts, delivered to that room's members in place of the entries.
const PRESENCE_DIGEST_WINDOW_MS = 1000;

const PRESENCE_DIGEST_MAX_PENDING = 250;

export const PRESENCE_OVERSIZE_ROOM_ACTIVE_THRESHOLD = 1000;

interface PresenceDigestJoined {
  agent_id: string;
  name: string;
  capabilities: string[];
  // Internal fanout-only attribution (WI-3): the subject's room-set
  // snapshot at collect time. Stripped before socket delivery.
  rooms: string[];
}

interface PresenceDigestLeft {
  agent_id: string;
  // Internal fanout-only attribution (WI-3) — see PresenceDigestJoined.
  rooms: string[];
}

// Wire-additive payload member, present only when a flush contains
// entries attributable to an oversize room (WI-3 change 3).
interface PresenceSummary {
  room_conversation_id: string;
  joined_count: number;
  left_count: number;
  active_count: number;
}

// digestOrder holds agent ids in first-seen order; each id sits in
// exactly one of digestJoined / digestLeft (last-write-wins netting).
const digestJoined = new Map<string, PresenceDigestJoined>();

const digestLeft = new Map<string, PresenceDigestLeft>();

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
  setInterval(() => {
    void flushPresenceDigest();
  }, PRESENCE_DIGEST_WINDOW_MS);
}

// Nets a join into the pending digest: any pending left for the agent is
// superseded. `rooms` is the subject's room-set snapshot at collect time
// (WI-3 attribution — last-write-wins, like the entry itself). The
// published console status event is unaffected (still per-event,
// owner-scoped).
export function recordPresenceJoined(agentId: string, name: string, capabilities: string[], rooms: ReadonlySet<string>) {
  ensureDigestFlusher();
  // Active membership moved in every room the subject belongs to —
  // cached oversize determinations for those rooms are stale.
  for (const roomId of rooms) invalidateOversizeDetermination(roomId);
  if (digestLeft.has(agentId)) {
    digestLeft.delete(agentId);
  } else if (!digestJoined.has(agentId)) {
    digestOrder.push(agentId);
  }
  digestJoined.set(agentId, { agent_id: agentId, name, capabilities, rooms: [...rooms] });
  if (digestOrder.length >= PRESENCE_DIGEST_MAX_PENDING) void flushPresenceDigest();
}

// Nets a departure into the pending digest: any pending join for the
// agent is superseded.
export function recordPresenceLeft(agentId: string, rooms: ReadonlySet<string>) {
  ensureDigestFlusher();
  // Active membership moved in every room the subject belongs to —
  // cached oversize determinations for those rooms are stale.
  for (const roomId of rooms) invalidateOversizeDetermination(roomId);
  if (digestJoined.has(agentId)) {
    digestJoined.delete(agentId);
  } else if (!digestLeft.has(agentId)) {
    digestOrder.push(agentId);
  }
  digestLeft.set(agentId, { agent_id: agentId, rooms: [...rooms] });
  if (digestOrder.length >= PRESENCE_DIGEST_MAX_PENDING) void flushPresenceDigest();
}

// ── Oversize determinations (WI-3 change 3, cost-bounded) ─────────────
// A room is oversize when its active membership — participant rows
// whose agent currently holds a live presence key — exceeds
// PRESENCE_OVERSIZE_ROOM_ACTIVE_THRESHOLD. The determination itself is
// exact (Postgres rows ∩ the Redis presence set, computed by
// computeOversizeDetermination), but it is NOT recomputed on every
// flush: determinations are cached per room, so a flush whose rooms'
// membership has not changed issues no PG or Redis queries at all —
// exactly what the pre-WI-3 flush cost. A cached determination is
// dropped as soon as this process observes an event that can change
// it:
//   - a digest entry attributable to the room is collected (a member's
//     presence joined/left — the only way active membership moves), or
//   - a THREAD_PARTICIPANT_JOINED broadcast for the room is seen, or
//     the local leave path runs (participant rows changed), or
//   - the TTL expires — a backstop for changes no local event reveals
//     (e.g. a leave served by another gateway process).
// Participant counts change slowly, so the bounded staleness that
// remains (a room crossing the threshold is picked up at its next
// membership event or at TTL expiry) is the accepted price of keeping
// the 1 s flush off the database.
const PRESENCE_OVERSIZE_CACHE_TTL_MS = 60_000;

const PRESENCE_OVERSIZE_CACHE_MAX_ENTRIES = 4096;

interface OversizeDetermination {
  oversize: boolean;
  // Exact on the oversize path (participant rows ∩ live presence
  // keys). On the gated sub-threshold path it holds the participant
  // count — an upper bound on active membership, never read: summaries
  // are built only from oversize determinations.
  activeCount: number;
  computedAtMs: number;
}

const oversizeDeterminations = new Map<string, OversizeDetermination>();

export function invalidateOversizeDetermination(conversationId: string): void {
  oversizeDeterminations.delete(conversationId);
}

async function computeOversizeDetermination(
  roomId: string,
  sharedOnlineIds: () => Promise<Set<string>>,
): Promise<OversizeDetermination> {
  // Active membership can never exceed the participant count, so only
  // a room with more participants than the threshold can be oversize:
  // a cheap index-only COUNT gates the Redis presence scan, which the
  // caller shares across every room one flush actually computes.
  const [{ n: participantCount }] = await db
    .select({ n: count() })
    .from(conversationParticipants)
    .where(eq(conversationParticipants.conversationId, roomId));
  if (participantCount <= PRESENCE_OVERSIZE_ROOM_ACTIVE_THRESHOLD) {
    return { oversize: false, activeCount: participantCount, computedAtMs: Date.now() };
  }
  const onlineIds = await sharedOnlineIds();
  const parts = await db
    .select({ agentId: conversationParticipants.agentId })
    .from(conversationParticipants)
    .where(eq(conversationParticipants.conversationId, roomId));
  let activeCount = 0;
  for (const p of parts) if (onlineIds.has(p.agentId)) activeCount += 1;
  return {
    oversize: activeCount > PRESENCE_OVERSIZE_ROOM_ACTIVE_THRESHOLD,
    activeCount,
    computedAtMs: Date.now(),
  };
}

async function determineOversize(
  roomId: string,
  sharedOnlineIds: () => Promise<Set<string>>,
): Promise<OversizeDetermination> {
  const cached = oversizeDeterminations.get(roomId);
  if (cached && Date.now() - cached.computedAtMs < PRESENCE_OVERSIZE_CACHE_TTL_MS) {
    return cached;
  }
  const determination = await computeOversizeDetermination(roomId, sharedOnlineIds);
  oversizeDeterminations.set(roomId, determination);
  if (oversizeDeterminations.size > PRESENCE_OVERSIZE_CACHE_MAX_ENTRIES) {
    // Opportunistic bound: expired entries go first; if the map is
    // still over the cap, clear it — a lost entry costs one lazy
    // recomputation, never correctness.
    const now = Date.now();
    for (const [id, entry] of oversizeDeterminations) {
      if (now - entry.computedAtMs >= PRESENCE_OVERSIZE_CACHE_TTL_MS) {
        oversizeDeterminations.delete(id);
      }
    }
    if (oversizeDeterminations.size > PRESENCE_OVERSIZE_CACHE_MAX_ENTRIES) {
      oversizeDeterminations.clear();
    }
  }
  return determination;
}

// Publishes the pending set as one presence_digest broadcast, entries in
// first-seen order. Empty buffer → no publish. The pending set is
// snapshotted and cleared synchronously; oversize determinations are
// resolved (from the per-room cache, computed on a miss) before the
// publish, so entries collected during the await land in the next
// window — netting and ordering semantics are unchanged.
async function flushPresenceDigest() {
  if (digestOrder.length === 0) return;
  const joined: PresenceDigestJoined[] = [];
  const left: PresenceDigestLeft[] = [];
  for (const agentId of digestOrder) {
    const j = digestJoined.get(agentId);
    if (j) joined.push(j);
    else {
      const l = digestLeft.get(agentId);
      if (l) left.push(l);
    }
  }
  digestJoined.clear();
  digestLeft.clear();
  digestOrder.length = 0;

  // Oversize rooms (WI-3 change 3): a room whose active membership
  // exceeds the threshold stops enumerating. Entries attributable to
  // it collapse into one presence_summary per room; delivery
  // suppresses the individual entries for that room's members and
  // delivers the summary instead (scopePresenceDigest). Sub-threshold
  // rooms in the same flush still enumerate, bounded per room by the
  // same 250-entry window cap: entries are per-agent, so a room's
  // attributable entries in one flush can never exceed the pending
  // cap. Determinations come from the per-room cache above — computed
  // by the production path on a miss, never per flush in steady state.
  const summaries: PresenceSummary[] = [];
  const oversizeRooms: string[] = [];
  const attributedRooms = new Set<string>();
  for (const e of joined) for (const roomId of e.rooms) attributedRooms.add(roomId);
  for (const e of left) for (const roomId of e.rooms) attributedRooms.add(roomId);
  if (attributedRooms.size > 0) {
    try {
      let onlineIds: Set<string> | null = null;
      const sharedOnlineIds = async () => (onlineIds ??= await getOnlineAgentIds());
      for (const roomId of attributedRooms) {
        const determination = await determineOversize(roomId, sharedOnlineIds);
        if (!determination.oversize) continue;
        oversizeRooms.push(roomId);
        summaries.push({
          room_conversation_id: roomId,
          joined_count: joined.filter((e) => e.rooms.includes(roomId)).length,
          left_count: left.filter((e) => e.rooms.includes(roomId)).length,
          active_count: determination.activeCount,
        });
      }
    } catch (err) {
      // Advisory path: a failed oversize computation must not lose the
      // digest — flush fully enumerated (the pre-WI-3 behavior) and log.
      log("presence_digest_oversize_check_failed", { error: String(err) });
      summaries.length = 0;
      oversizeRooms.length = 0;
    }
  }

  broadcast(
    envelope(WS_EVENTS.PRESENCE_DIGEST, {
      joined,
      left,
      ...(summaries.length > 0 ? { summaries, oversize_rooms: oversizeRooms } : {}),
    }),
  );
}

// Scopes one digest envelope for one receiving socket (WI-3): an entry
// survives iff the subject shares ≥1 room with the receiver and at
// least one shared room is sub-threshold (oversize rooms are covered by
// their presence_summary instead of entries); the receiver's own entry
// is stripped, as the original digest always did; a summary survives
// iff the receiver is in the summarized room. The internal `rooms`
// attribution and `oversize_rooms` list never reach the wire. Returns
// null when nothing remains for this socket — the write is skipped.
// When nothing was filtered or stripped, the original serialized
// payload passes through untouched.
export function scopePresenceDigest(
  event: ReturnType<typeof envelope>,
  rawPayload: string,
  conn: Connection,
): string | null {
  try {
    const payload = event.payload as {
      joined?: PresenceDigestJoined[];
      left?: PresenceDigestLeft[];
      summaries?: PresenceSummary[];
      oversize_rooms?: string[];
    };
    const joinedIn = payload.joined ?? [];
    const leftIn = payload.left ?? [];
    const summariesIn = payload.summaries ?? [];
    const oversize = new Set(payload.oversize_rooms ?? []);
    const inScope = (e: { agent_id: string; rooms?: string[] }): boolean => {
      if (e.agent_id === conn.agentId) return false;
      // No attribution — a digest shape this build never emits (e.g. a
      // mixed-version fleet mate): deliver as before rather than drop.
      if (!e.rooms) return true;
      for (const roomId of e.rooms) {
        if (conn.rooms.has(roomId) && !oversize.has(roomId)) return true;
      }
      return false;
    };
    const joined = joinedIn
      .filter(inScope)
      .map((e) => ({ agent_id: e.agent_id, name: e.name, capabilities: e.capabilities }));
    const left = leftIn.filter(inScope).map((e) => ({ agent_id: e.agent_id }));
    const summaries = summariesIn.filter((s) => conn.rooms.has(s.room_conversation_id));
    if (joined.length === 0 && left.length === 0 && summaries.length === 0) return null;
    const untouched =
      joined.length === joinedIn.length &&
      left.length === leftIn.length &&
      summaries.length === summariesIn.length &&
      oversize.size === 0 &&
      joinedIn.every((e) => !e.rooms) &&
      leftIn.every((e) => !e.rooms);
    if (untouched) return rawPayload;
    return JSON.stringify({
      ...event,
      payload: {
        joined,
        left,
        ...(summaries.length > 0 ? { summaries } : {}),
      },
    });
  } catch {
    // Unreadable digest shape — deliver as-is rather than drop it.
    return rawPayload;
  }
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
