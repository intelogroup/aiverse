import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import { and, eq, notInArray } from "drizzle-orm";
import { agents, consoleEvents, conversationParticipants } from "@aiverse/shared/schema";
import { db } from "../db/client";
import { redis, redisSub } from "../redis/client";
import { clearPresence, setPresence } from "../presence";
import { log, timed } from "../util/log";
import { checkAndConsumeVisit } from "../policy/visits";
import { getWorldStream } from "../world/frames";
import { SUBSCRIBE_WORLD } from "@aiverse/world-sim/streamProtocol";
import { busMode, startBus } from "./bus";
import { WS_EVENTS, envelope } from "./events";
import { connections, consoleConnections, publicConnections, type Connection } from "./connections";
import { pokeBusReconcile, startBusSubscriptions } from "./busSubscriptions";
import {
  WS_FANOUT_CHANNEL,
  broadcastToOwnerConsole,
  deliverToAgentConn,
  fanoutSeenBefore,
  fanoutSeenBeforeSocket,
  forceDisconnectAgent,
  messageEnvelopeId,
  type FanoutMessage,
} from "./fanout";
import {
  addConnectionRoom,
  invalidateOversizeDetermination,
  recordPresenceJoined,
  recordPresenceLeft,
  scopePresenceDigest,
} from "./presence";
import { deliverBacklog, handleAck } from "./delivery";
import { RECONNECT_BUDGET_CLOSE_CODE, agentConnectAdmission, consumeReconnectBudget } from "./connectGuards";

// Public surface (cleanup L2): the implementations live in the sibling
// modules below; every symbol this module has ever exported is still
// exported from here, so no importer changes.
export { broadcastToOwnerConsole, broadcastToPublic, broadcastParticipantJoined, getConnectedAgentIds, isAgentConnected, sendToAgent, sendToConversation, forceDisconnectAgent } from "./fanout";
export { addConnectionRoom, removeConnectionRoom, PRESENCE_OVERSIZE_ROOM_ACTIVE_THRESHOLD, reconcilePresenceOnBoot } from "./presence";
export { BUS_UNSUBSCRIBE_GRACE_MS, computeDesiredBusSubjects, reconcileBusSubscriptions, startBusSubscriptions } from "./busSubscriptions";
export { deliverSubscriptionCatchUp, handleAck } from "./delivery";
export { RECONNECT_BUDGET_CLOSE_CODE } from "./connectGuards";
export { HEAP_STATS_INTERVAL_MS, formatHeapStatsLine, heapStatsLine, localRoomCount, scheduleHeapStats } from "./heapStats";

export const VISIT_CLOSE_CODE = 4008;

export const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

redisSub.subscribe(WS_FANOUT_CHANNEL).catch((err) => {
  console.error("[ws-fanout] subscribe failed", err);
});

redisSub.on("message", (_channel: string, raw: string) => {
  handleFanoutMessage(raw);
});

function handleFanoutMessage(raw: string) {
  let msg: FanoutMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  switch (msg.kind) {
    case "agent": {
      const conn = connections.get(msg.agentId);
      if (conn) {
        // Presence v2 (WI-3) room-set maintenance: a CONVERSATION_STARTED
        // delivery means the recipient just became a participant of that
        // conversation — record it so presence scoping and room-scoped
        // broadcasts see the membership without waiting for a reconnect.
        if (msg.event.type === WS_EVENTS.CONVERSATION_STARTED) {
          const conversationId = (msg.event.payload as { conversation_id?: unknown })?.conversation_id;
          if (typeof conversationId === "string" && !conn.rooms.has(conversationId)) {
            conn.rooms.add(conversationId);
            pokeBusReconcile();
          }
        }
        if (fanoutSeenBefore(conn, msg.mid)) break;
        deliverToAgentConn(conn, JSON.stringify(msg.event));
      }
      break;
    }
    case "broadcast": {
      const payload = JSON.stringify(msg.event);
      const isDigest = msg.event.type === WS_EVENTS.PRESENCE_DIGEST;
      // Presence v2 (WI-3) room-set maintenance: a room-scoped
      // THREAD_PARTICIPANT_JOINED broadcast tells every process the
      // subject joined the conversation — heal the subject's local room
      // set BEFORE the scope filter runs, so an invitee whose socket
      // lives on this process (while the invite route ran on another)
      // passes the filter for their own join frame.
      if (msg.roomConversationId && msg.event.type === WS_EVENTS.THREAD_PARTICIPANT_JOINED) {
        const subjectId = (msg.event.payload as { agent_id?: unknown })?.agent_id;
        if (typeof subjectId === "string") addConnectionRoom(subjectId, msg.roomConversationId);
        // The room's participant rows changed on whichever process
        // served the join/invite: drop any cached oversize
        // determination for it (see the cache notes below).
        invalidateOversizeDetermination(msg.roomConversationId);
      }
      for (const [agentId, conn] of connections) {
        if (agentId === msg.exceptAgentId) continue;
        // WI-2 room publish exclusion: the send path's skip list
        // (sender + passive participants) rides the room frame so this
        // fanout reproduces the legacy per-recipient loop exactly.
        if (msg.skipAgentIds && msg.skipAgentIds.includes(agentId)) continue;
        // Room-scope filter: sockets outside the conversation never see
        // the frame. A filtered live frame is not a correctness loss —
        // the reconnect backlog replays missed joins from the
        // participant rows (deliverConversationBacklog).
        if (msg.roomConversationId && !conn.rooms.has(msg.roomConversationId)) continue;
        if (fanoutSeenBefore(conn, msg.mid)) continue;
        if (isDigest) {
          // Presence digests are scoped to room co-members and stripped
          // of the receiving socket's own agent_id per receiver (and
          // skipped entirely when nothing remains for that socket) —
          // see scopePresenceDigest below.
          const scoped = scopePresenceDigest(msg.event, payload, conn);
          if (scoped === null) continue;
          deliverToAgentConn(conn, scoped);
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
      for (const ws of sockets) {
        if (fanoutSeenBeforeSocket(ws, msg.mid)) continue;
        ws.send(payload);
      }
      break;
    }
    case "public": {
      if (publicConnections.size === 0) break;
      const payload = JSON.stringify(msg.event);
      for (const ws of publicConnections) {
        if (fanoutSeenBeforeSocket(ws, msg.mid)) continue;
        ws.send(payload);
      }
      break;
    }
  }
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
            rooms: new Set(),
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
                // Hono types `raw` as possibly undefined (cross-runtime
                // WSContext); on Bun it is always set. Only a socket
                // proven OPEN is restored — anything unconfirmable falls
                // to the departed-incumbent branch below.
                if (displaced.ws.raw?.readyState === 1) {
                  connections.set(conn.agentId, displaced);
                } else {
                  // The incumbent died inside the setup window; its
                  // onClose identity-failed against this registration, so
                  // its departure was never announced. Announce the leave
                  // and drop its presence key here; the DB status write is
                  // left to the boot reconciler (bounded, self-healing).
                  recordPresenceLeft(conn.agentId, displaced.rooms);
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

          // Presence v2 (WI-3): populate the connection's room set from
          // the participant rows — the anchor every later maintenance
          // event only has to keep current. This MUST stay ahead of the
          // backlog + pending-flush sequence below: the flush loop and
          // the `state = "live"` assignment after it are deliberately
          // separated by no await (a fanout frame delivered to this
          // connection in such a gap would land in the pending buffer
          // after its only flush and never reach the socket), so every
          // awaited setup step belongs before that sequence. Populated
          // here, the set is still complete before the live transition,
          // so the digest join collected below snapshots a complete set
          // and room-scoped delivery applies from the first live frame.
          const roomRows = await db.query.conversationParticipants.findMany({
            where: eq(conversationParticipants.agentId, agent.id),
            columns: { conversationId: true },
          });
          conn.rooms = new Set(roomRows.map((r) => r.conversationId));
          // WI-2: this socket's rooms are now known — warm the bus
          // subscriptions for them before the first live frame.
          pokeBusReconcile();

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
          // digest, same as the Go edge. The room set populated above is
          // the entry's WI-3 attribution snapshot.
          recordPresenceJoined(agent.id, agent.name, capabilities, conn.rooms);

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
          // WI-2: the socket's rooms leave the desired subscription
          // set with it (the 30 s grace in the reconciler absorbs a
          // reconnect flap before anything actually unsubscribes).
          pokeBusReconcile();
          await clearPresence(agentId);
          // Don't clobber a status the owner/system deliberately set (paused,
          // budget_exhausted) just because the socket that carried it closed —
          // only transient connection states (online/away) reset to offline.
          await db
            .update(agents)
            .set({ status: "offline", lastSeenAt: new Date() })
            .where(and(eq(agents.id, agentId), notInArray(agents.status, ["paused", "budget_exhausted"])));
          if (wasLive) recordPresenceLeft(agentId, conn.rooms);
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

export function registerPublicWsRoute(app: {
  get: (path: string, ...handlers: unknown[]) => unknown;
}) {
  app.get(
    "/public/ws",
    upgradeWebSocket(() => ({
      onOpen: (_event, ws) => {
        publicConnections.add(ws);
        pokeBusReconcile();
      },
      // The only thing a spectator may say: ask for the world's pose stream. Anything else (or anything large) is ignored.
      onMessage: (event, ws) => {
        const stream = getWorldStream();
        if (!stream || typeof event.data !== "string" || event.data.length > 128) return;
        let type: unknown;
        try { type = (JSON.parse(event.data) as { type?: unknown }).type; } catch { return; }
        if (type !== SUBSCRIBE_WORLD) return;
        const raw = ws.raw as { getBufferedAmount?: () => number } | undefined;
        stream.subscribe(ws.raw ?? ws, { send: (d) => ws.send(d), getBufferedAmount: () => raw?.getBufferedAmount?.() ?? 0 });
      },
      onClose: (_event, ws) => {
        publicConnections.delete(ws);
        getWorldStream()?.unsubscribe(ws.raw ?? ws);
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
          pokeBusReconcile();
        },
        onClose: (_event, ws) => {
          if (!ownerId) return;
          consoleConnections.get(ownerId)?.delete(ws);
        },
      };
    }),
  );
}

// WI-2: the NATS bus feeds the same delivery path (handleFanoutMessage
// above). In legacy mode the bus never starts and this process is
// exactly the pre-WI-2 gateway; in dual/nats the reconciler keeps this
// process's subject subscriptions matched to the sockets it actually
// holds. This block sits at the END of the module on purpose: it runs
// during module evaluation, and the reconciler's state (busAbsentSince,
// busReconcilerStarted) is declared mid-file — starting any earlier
// would hit the TDZ on those bindings.
if (busMode() !== "legacy") {
  startBus((raw) => handleFanoutMessage(raw));
  startBusSubscriptions();
}
