import { connect, type NatsConnection, type Subscription } from "nats";
import { uuidv7 } from "@aiverse/shared/uuidv7";
import { log } from "../util/log";

// ── Bus migration (PHASE2_SPEC WI-2) ────────────────────────────────────
// The fanout bus moves from one global Redis pub/sub channel (ws:fanout,
// every process receives everything, per-recipient publishes) to NATS
// core subjects scoped by interest: a publish reaches only the gateway
// processes that hold sockets it concerns. The subject design is
// transport-agnostic (spec WI-2 step 1):
//
//   room.{conversationId}  room traffic (one publish per room send)
//   agent.{agentId}         direct traffic for one agent
//   fleet.control           membership/heartbeat/subscription reports
//   fleet.broadcast         the genuinely-global events (digests, public)
//   console.{ownerId}       owner console pushes
//
// Rollout is env-gated exactly like the WI-4 cursor migration:
//   legacy (DEFAULT) — today's behavior exactly: Redis ws:fanout only.
//   dual   — publish to BOTH transports; subscribers consume both and
//            dedupe by the envelope's `mid` (uuidv7, additive), so every
//            message is delivered exactly once per socket.
//   nats   — publish + subscribe NATS only. The legacy receive path
//            stays in the binary, so rollback is an env flip back to
//            dual/legacy, never a deploy (spec WI-2 step 2).
// The ingest stream, cursors, and presence keys are untouched — this
// moves the bus, not state. Core NATS is at-most-once, which is safe
// here: the ingest stream + reconnect backlog are the durable truth
// (plan rule 6); the bus is a hint layer.

export type BusMode = "legacy" | "dual" | "nats";

export function busMode(): BusMode {
  const v = process.env.AIVERSE_BUS_MODE;
  return v === "dual" || v === "nats" ? v : "legacy";
}

export const FLEET_CONTROL_SUBJECT = "fleet.control";
export const FLEET_BROADCAST_SUBJECT = "fleet.broadcast";
export const AGENT_WILDCARD_SUBJECT = "agent.*";

// The structural slice of the fanout envelope subject routing needs —
// declared here so this module never imports ws/gateway.ts (the import
// runs the other way).
export interface FanoutSubjectShape {
  kind: "agent" | "broadcast" | "console" | "public";
  agentId?: string;
  ownerId?: string;
  roomConversationId?: string;
}

export function subjectForFanout(msg: FanoutSubjectShape): string {
  switch (msg.kind) {
    case "agent":
      return `agent.${msg.agentId}`;
    case "console":
      return `console.${msg.ownerId}`;
    case "broadcast":
      return msg.roomConversationId ? `room.${msg.roomConversationId}` : FLEET_BROADCAST_SUBJECT;
    case "public":
      return FLEET_BROADCAST_SUBJECT;
  }
}

export function newMid(): string {
  return uuidv7();
}

// Bounded per-target dedupe ring for dual mode: a fanout envelope's two
// transport copies arrive within milliseconds of each other, so a small
// ring of recent mids per delivery target is enough to suppress the
// second copy. check() returns true when the mid was already recorded
// (a duplicate to drop); first sight records it and returns false. An
// empty mid never dedupes (legacy envelopes from pre-WI-2 publishers
// carry none and must deliver as before).
const MID_RING_CAPACITY = 256;

export class MidDedupe {
  private ring: (string | undefined)[] = new Array(MID_RING_CAPACITY);
  private seen = new Set<string>();
  private cursor = 0;

  check(mid: string): boolean {
    if (!mid) return false;
    if (this.seen.has(mid)) return true;
    const evicted = this.ring[this.cursor];
    if (evicted !== undefined) this.seen.delete(evicted);
    this.ring[this.cursor] = mid;
    this.seen.add(mid);
    this.cursor = (this.cursor + 1) % MID_RING_CAPACITY;
    return false;
  }
}

// ── NATS transport (single connection per process) ──────────────────────

let nc: NatsConnection | null = null;
let busHandler: ((raw: string) => void) | null = null;
const busSubs = new Map<string, Subscription>();

export function busNodeName(): string {
  return process.env.AIVERSE_BUS_NODE_NAME ?? `ts-gateway-${process.pid}`;
}

function natsUrl(): string {
  return process.env.NATS_URL ?? "nats://127.0.0.1:4222";
}

// Connect (idempotent) and subscribe the always-on fleet.control
// subject. Fire-and-forget by design: the gateway must boot and serve
// legacy traffic even while NATS is down — nats.js reconnects forever
// in the background and restores subscriptions on reconnect. In dual
// mode a down bus costs nothing (legacy carries); in nats mode it is a
// routing pause, never a loss (backlog is the truth).
export function startBus(onMessage: (raw: string) => void): void {
  if (busHandler) return;
  busHandler = onMessage;
  void (async () => {
    try {
      nc = await connect({
        servers: natsUrl(),
        name: busNodeName(),
        reconnect: true,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 1_000,
      });
      log("bus_connected", { url: natsUrl(), name: busNodeName() });
      subscribeBusSubject(FLEET_CONTROL_SUBJECT);
      // Re-apply any subscriptions the reconciler requested while the
      // connection was still coming up.
      for (const subject of [...desiredSubjects]) subscribeBusSubject(subject);
      void (async () => {
        if (!nc) return;
        await nc.closed();
        nc = null;
        log("bus_connection_closed", {});
        // Restart the connect loop unless the process is going away;
        // subscriptions are re-applied by the same path.
        setTimeout(() => {
          const handler = busHandler;
          busHandler = null;
          if (handler) startBus(handler);
        }, 1_000).unref?.();
      })();
    } catch (err) {
      log("bus_connect_error", { error: String(err) });
      setTimeout(() => {
        const handler = busHandler;
        busHandler = null;
        if (handler) startBus(handler);
      }, 2_000).unref?.();
    }
  })();
}

export function publishBus(subject: string, payload: string): void {
  if (!nc) {
    // Dual mode: the legacy copy already went out, so this is noise —
    // but in nats mode it is the only copy, so say so loudly.
    if (busMode() === "nats") log("bus_publish_no_connection", { subject });
    return;
  }
  try {
    nc.publish(subject, payload);
  } catch (err) {
    log("bus_publish_error", { subject, error: String(err) });
  }
}

// What the reconciler currently wants subscribed (besides the always-on
// fleet.control). subscribe/unsubscribe are reconciler-facing and safe
// to call at any time: subscribe records intent and applies it when a
// connection exists; both are no-ops when already in the target state.
const desiredSubjects = new Set<string>();

export function subscribeBusSubject(subject: string): void {
  desiredSubjects.add(subject);
  if (!nc || busSubs.has(subject)) return;
  const sub = nc.subscribe(subject, {
    callback: (_err, msg) => {
      if (busHandler) busHandler(new TextDecoder().decode(msg.data));
    },
  });
  busSubs.set(subject, sub);
}

export function unsubscribeBusSubject(subject: string): void {
  desiredSubjects.delete(subject);
  const sub = busSubs.get(subject);
  if (!sub) return;
  busSubs.delete(subject);
  try {
    sub.unsubscribe();
  } catch {
    // Connection already gone — the subscription dies with it.
  }
}

export function activeBusSubjects(): string[] {
  return [...busSubs.keys()];
}

export function desiredBusSubjects(): string[] {
  return [...desiredSubjects];
}
