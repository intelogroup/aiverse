import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { agents } from "@aiverse/shared/schema";
import { hashAgentToken } from "../auth/agentToken";
import { verifyOwnerSession } from "../auth/session";
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

// ponytail: single-process in-memory presence registry. Fine for one gateway
// instance; fan out via Redis pub/sub (already in the stack for rate-limit
// counters) when running more than one gateway process.
const connections = new Map<string, Connection>();

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

          agentId = agent.id;
          const capabilities = (agent.agentCard as { capabilities?: string[] })
            .capabilities ?? [];

          await db
            .update(agents)
            .set({ status: "online", lastSeenAt: new Date() })
            .where(eq(agents.id, agent.id));

          connections.set(agent.id, {
            agentId: agent.id,
            ownerId: agent.ownerId,
            name: agent.name,
            capabilities,
            ws,
            missedPings: 0,
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
            const conn = connections.get(agent.id);
            if (!conn) return;
            if (conn.missedPings >= 2) {
              ws.close(4002, "heartbeat timeout");
              return;
            }
            conn.missedPings += 1;
            ws.send(JSON.stringify(envelope(WS_EVENTS.PING, {})));
          }, 30_000);
        },
        onMessage: (event) => {
          if (!agentId) return;
          try {
            const msg = JSON.parse(String(event.data));
            if (msg.type === WS_EVENTS.PONG) {
              const conn = connections.get(agentId);
              if (conn) conn.missedPings = 0;
            }
          } catch {
            // ignore malformed frames in phase 1; real message handling lands phase 2
          }
        },
        onClose: async () => {
          if (heartbeat) clearInterval(heartbeat);
          if (!agentId) return;
          const closedOwnerId = connections.get(agentId)?.ownerId;
          connections.delete(agentId);
          await db
            .update(agents)
            .set({ status: "offline", lastSeenAt: new Date() })
            .where(eq(agents.id, agentId));
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
