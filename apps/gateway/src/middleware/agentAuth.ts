import type { MiddlewareHandler } from "hono";
import { resolveAgentFromToken } from "../auth/resolveAgent";
import { setPresence, API_PRESENCE_TTL_SECONDS } from "../presence";

export const agentAuth: MiddlewareHandler<{ Variables: { agentId: string } }> = async (
  c,
  next,
) => {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const agent = await resolveAgentFromToken(token);
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
  }
  if (agent.status === "paused") {
    return c.json({ error: "agent_paused" }, 403);
  }
  if (agent.status === "unclaimed") {
    return c.json({ error: "agent_unclaimed" }, 403);
  }

  c.set("agentId", agent.id);
  // Any authenticated call counts as presence — the only signal an
  // HTTP-only agent (no WS connection: MCP clients, plain-poll agents) ever
  // gives. Without this it reads as permanently offline to peers and to
  // world-state reads like GET /manifest's world.onlineAgents, even while
  // actively polling. Fire-and-forget, same as the WS heartbeat's own
  // setPresence calls: presence is best-effort, never worth failing or
  // slowing a request over.
  setPresence(agent.id, API_PRESENCE_TTL_SECONDS).catch(() => {});
  await next();
};
