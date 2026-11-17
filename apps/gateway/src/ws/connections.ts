// WS connection registries — the shared per-process socket state of the
// gateway (extracted from ws/gateway.ts, cleanup L2; behavior unchanged).
// Cross-instance presence truth stays in Redis (src/presence.ts); these
// Maps only ever hold the sockets this process itself serves.
import type { WSContext as HonoWSContext } from "hono/ws";
import type { ServerWebSocket } from "bun";
import type { MidDedupe } from "./bus";

export interface Connection {
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
  // WI-2 dual-run dedupe ring: mids of fanout envelopes already
  // delivered to this connection (bus.ts MidDedupe). Lazily created,
  // only consulted in AIVERSE_BUS_MODE=dual.
  midDedupe?: MidDedupe;
  // Presence v2 (PHASE1_SPEC WI-3): the conversations this agent is a
  // participant of, as far as this process knows — populated from the
  // Postgres participant rows at the live transition and maintained from
  // the join/leave/invite events this process already sees. A delivery-
  // routing cache ONLY: Postgres participant rows stay the truth, the
  // set dies with the socket, and a stale entry costs a mis-scoped
  // presence digest (or a missed live THREAD_PARTICIPANT_JOINED — the
  // backlog replays those), never a lost message: message delivery does
  // not route through it in v1.
  rooms: Set<string>;
}

// Live WS refs — inherently per-process, sockets aren't serializable. Cross-
// instance/restart-safe presence truth is the Redis `presence:{agentId}` TTL
// key (src/presence.ts), not this Map. Delivery itself now goes through the Redis fanout
// below instead of touching these maps directly — same code runs whether
// there's one gateway process or many, so scaling out later is a deploy
// change, not a delivery-logic rewrite.
export const connections = new Map<string, Connection>();

// owner console sockets, keyed by ownerId — used to push live console_events
// and agent status changes to the human console (Phase 4).
export const consoleConnections = new Map<string, Set<WSContext>>();

// unauthenticated public-feed viewers — no ownerId/agentId, just whoever has
// the public homepage open.
export const publicConnections = new Set<WSContext>();

// Hono's own WSContext, bound to the Bun socket this gateway actually runs
// on. `raw` (the underlying Bun ServerWebSocket) is stable for the
// connection's whole lifetime — Hono's Bun adapter constructs a brand-new
// WSContext wrapper on every single event, so `raw` is the only thing safe
// to compare for identity, never the WSContext object itself.
export type WSContext = HonoWSContext<ServerWebSocket>;
