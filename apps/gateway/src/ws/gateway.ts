import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import { and, eq, notInArray, gt, lt, ne } from "drizzle-orm";
import { db } from "../db/client";
import { agents, conversationParticipants, messages, a2aTasks } from "@aiverse/shared/schema";
import { hashAgentToken } from "../auth/agentToken";
import { verifyOwnerSession } from "../auth/session";
import { redis } from "../redis/client";
import { envelope, WS_EVENTS } from "./events";

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

type WSContext = {
  send: (data: string) => void;
  close: () => void;
};

function broadcast(event: ReturnType<typeof envelope>, exceptAgentId?: string) {
  const payload = JSON.stringify(event);
  for (const [agentId, conn] of connections) {
    if (agentId === exceptAgentId) continue;
    conn.ws.send(payload);
  }
}

async function authenticate(token: string | undefined) {
  if (!token) return undefined;
  const hash = hashAgentToken(token);
  return db.query.agents.findFirst({ where: eq(agents.apiKeyHash, hash) });
}

// Bounded per source so a long-absent agent reconnecting doesn't get flooded
// — this is at-least-once catch-up, not a full history replay.
const BACKLOG_MESSAGES_PER_CONVERSATION = 50;
const BACKLOG_A2A_TASKS = 50;

// Offline delivery: replays anything this agent missed while disconnected.
// Messages replay from each conversation's lastDeliveredAt cursor (only
// advanced by an explicit client ack, see onMessage below); A2A tasks replay
// every still-'submitted' task addressed to this agent, since 'submitted'
// already means "not yet acted on" — no separate delivered/acked column
// needed there, the state machine itself gates redelivery.
async function deliverBacklog(agentId: string, ws: WSContext): Promise<void> {
  const participantRows = await db.query.conversationParticipants.findMany({
    where: eq(conversationParticipants.agentId, agentId),
  });

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
}

// Advances the delivery cursor for one conversation, gated on the message's
// real createdAt looked up server-side — never trust a client-supplied
// timestamp, and never move the cursor backward on an out-of-order ack.
async function handleAck(agentId: string, payload: unknown): Promise<void> {
  const { conversationId, messageId } = (payload ?? {}) as {
    conversationId?: string;
    messageId?: string;
  };
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
}

export function registerAgentWsRoute(app: {
  get: (path: string, ...handlers: unknown[]) => unknown;
}) {
  app.get(
    "/agents/ws",
    upgradeWebSocket((c) => {
      const token = c.req.query("token");
      let agentId: string | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;

      return {
        onOpen: async (_event, ws) => {
          const agent = await authenticate(token);
          if (!agent) {
            ws.close(4001, "invalid token");
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
          // will still fire async — the `connections.get(agentId) === conn`
          // identity check there is what stops it from clobbering this
          // (the new) connection's state once it runs.
          const existing = connections.get(agent.id);
          if (existing) {
            existing.ws.close(4006, "replaced by a new connection for the same agent");
            connections.delete(agent.id);
          }

          await db
            .update(agents)
            .set({ status: "online", lastSeenAt: new Date() })
            .where(eq(agents.id, agent.id));

          const conn: Connection = {
            agentId: agent.id,
            ownerId: agent.ownerId,
            name: agent.name,
            capabilities,
            ws,
            missedPings: 0,
          };
          connections.set(agent.id, conn);
          await redis.set(presenceKey(agent.id), "1", "EX", PRESENCE_TTL_SECONDS);

          ws.send(JSON.stringify(envelope(WS_EVENTS.AGENT_CONNECTED, { agent_id: agent.id })));

          await deliverBacklog(agent.id, ws);

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
              if (conn && conn.ws === ws) {
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
          if (!conn || conn.ws !== ws) return;
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

export function registerConsoleWsRoute(app: {
  get: (path: string, ...handlers: unknown[]) => unknown;
}) {
  app.get(
    "/console/ws",
    upgradeWebSocket((c) => {
      const token = c.req.query("token");
      let ownerId: string | undefined;

      return {
        onOpen: async (_event, ws) => {
          try {
            ownerId = await verifyOwnerSession(token ?? "");
          } catch {
            ws.close(4001, "invalid token");
            return;
          }
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
