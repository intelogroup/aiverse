import { createBunWebSocket } from "hono/bun";
import type { WSContext as HonoWSContext } from "hono/ws";
import type { ServerWebSocket } from "bun";
import { and, eq, notInArray, gt, lt, ne, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { agents, conversationParticipants, messages, a2aTasks, mentions } from "@aiverse/shared/schema";
import { redis } from "../redis/client";
import { envelope, WS_EVENTS } from "./events";
import { log, timed } from "../util/log";

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
// key below, not this Map. This means "is agent X online" is correct even
// across restarts/multiple gateways, but message delivery (sendToAgent) is
// still only-this-process — a real gap for a multi-instance deployment,
// deferred until more than one gateway process is actually run.
const connections = new Map<string, Connection>();

const PRESENCE_TTL_SECONDS = 90; // > 2x the 30s heartbeat interval below

function presenceKey(agentId: string): string {
  return `presence:${agentId}`;
}

// owner console sockets, keyed by ownerId — used to push live console_events
// and agent status changes to the human console (Phase 4).
const consoleConnections = new Map<string, Set<WSContext>>();

export function broadcastToOwnerConsole(ownerId: string, event: ReturnType<typeof envelope>): void {
  const sockets = consoleConnections.get(ownerId);
  if (!sockets) return;
  const payload = JSON.stringify(event);
  for (const ws of sockets) ws.send(payload);
}

// unauthenticated public-feed viewers — no ownerId/agentId, just whoever has
// the public homepage open.
const publicConnections = new Set<WSContext>();

export function broadcastToPublic(event: ReturnType<typeof envelope>): void {
  if (publicConnections.size === 0) return;
  const payload = JSON.stringify(event);
  for (const ws of publicConnections) ws.send(payload);
}

// Hono's own WSContext, bound to the Bun socket this gateway actually runs
// on. `raw` (the underlying Bun ServerWebSocket) is stable for the
// connection's whole lifetime — Hono's Bun adapter constructs a brand-new
// WSContext wrapper on every single event, so `raw` is the only thing safe
// to compare for identity, never the WSContext object itself.
type WSContext = HonoWSContext<ServerWebSocket>;

function broadcast(event: ReturnType<typeof envelope>, exceptAgentId?: string) {
  const payload = JSON.stringify(event);
  for (const [agentId, conn] of connections) {
    if (agentId === exceptAgentId) continue;
    conn.ws.send(payload);
  }
}

// Bounded per source so a long-absent agent reconnecting doesn't get flooded
// — this is at-least-once catch-up, not a full history replay.
const BACKLOG_MESSAGES_PER_CONVERSATION = 50;
const BACKLOG_A2A_TASKS = 50;
const BACKLOG_MENTIONS = 20;

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
    const backlog = await db.query.messages.findMany({
      where: and(
        eq(messages.conversationId, p.conversationId),
        gt(messages.createdAt, p.lastDeliveredAt),
        ne(messages.senderAgentId, agentId),
      ),
      orderBy: (m, { asc }) => [asc(m.createdAt)],
      limit: BACKLOG_MESSAGES_PER_CONVERSATION,
    });
    for (const m of backlog) {
      ws.send(
        JSON.stringify(
          envelope(WS_EVENTS.MESSAGE, {
            conversation_id: m.conversationId,
            message_id: m.id,
            sender_id: m.senderAgentId,
            content: m.content,
            reply_to_id: m.replyToId,
            ts: m.createdAt.getTime(),
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
  const pendingMentions = await db.query.mentions.findMany({
    where: and(eq(mentions.targetAgentId, agentId), isNull(mentions.ackedAt)),
    orderBy: (m, { asc }) => [asc(m.createdAt)],
    limit: BACKLOG_MENTIONS,
  });
  for (const m of pendingMentions) {
    ws.send(
      JSON.stringify(
        envelope(WS_EVENTS.MENTIONED, {
          mention_id: m.id,
          conversation_id: m.conversationId,
          is_public: m.isPublic,
          room_slug: m.roomSlug,
          message_id: m.messageId,
          by: m.byAgentId,
          by_name: m.byName,
          content: m.content,
          ts: m.createdAt.getTime(),
        }),
      ),
    );
  }

  return { messages: messagesDelivered, tasks: pendingTasks.length, mentions: pendingMentions.length, participantJoins: participantJoinsDelivered };
}

// Advances the delivery cursor for one conversation, gated on the message's
// real createdAt looked up server-side — never trust a client-supplied
// timestamp, and never move the cursor backward on an out-of-order ack.
async function handleAck(agentId: string, payload: unknown): Promise<void> {
  const { conversationId, messageId, mentionId } = (payload ?? {}) as {
    conversationId?: string;
    messageId?: string;
    mentionId?: string;
  };
  // A mention ack is keyed on the mentions row id (not conversationId +
  // messageId): the target may not be a conversation participant, so
  // conversationParticipants.lastDeliveredAt has no row to advance for them.
  if (mentionId) {
    await db.update(mentions).set({ ackedAt: new Date() }).where(and(eq(mentions.id, mentionId), eq(mentions.targetAgentId, agentId)));
    return;
  }
  if (!conversationId || !messageId) return;

  const message = await db.query.messages.findFirst({
    where: and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)),
  });
  if (!message) return;

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
          await timed("redis_write", { key: "presence", op: "set" }, () =>
            redis.set(presenceKey(agent.id), "1", "EX", PRESENCE_TTL_SECONDS),
          );

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
              ws.close(4002, "heartbeat timeout");
              return;
            }
            conn.missedPings += 1;
            ws.send(JSON.stringify(envelope(WS_EVENTS.PING, {})));
            redis.set(presenceKey(agent.id), "1", "EX", PRESENCE_TTL_SECONDS).catch(() => {});
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
                redis.set(presenceKey(agentId), "1", "EX", PRESENCE_TTL_SECONDS).catch(() => {});
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
          await redis.del(presenceKey(agentId));
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

export function sendToAgent(agentId: string, event: ReturnType<typeof envelope>): boolean {
  const conn = connections.get(agentId);
  if (!conn) return false;
  conn.ws.send(JSON.stringify(event));
  return true;
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
