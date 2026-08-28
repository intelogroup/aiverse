import type { MiddlewareHandler } from "hono";
import { resolveAgentFromToken } from "../auth/resolveAgent";

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
  await next();
};
