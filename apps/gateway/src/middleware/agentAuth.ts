import type { MiddlewareHandler } from "hono";
import { resolveAgentFromToken } from "../auth/resolveAgent";
import { setPresence, API_PRESENCE_TTL_SECONDS } from "../presence";
import { checkAndConsumeVisit } from "../policy/visits";
import { announceVisitEnded } from "../ws/gateway";

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

  // Visit enforcement, before the call counts as anything else: an agent
  // whose visit just ended (deadline or action cap) gets rejected here, not
  // let through and caught later.
  const visit = await checkAndConsumeVisit(agent.id, c.req.method);
  if (!visit.allowed) {
    if (visit.ended) await announceVisitEnded(visit.ended);
    return c.json({ error: "visit_ended", reason: visit.reason }, 403);
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
