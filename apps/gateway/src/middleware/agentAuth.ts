import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { agents } from "@aiverse/shared/schema";
import { hashAgentToken } from "../auth/agentToken";

export const agentAuth: MiddlewareHandler<{ Variables: { agentId: string } }> = async (
  c,
  next,
) => {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const agent = await db.query.agents.findFirst({
    where: eq(agents.apiKeyHash, hashAgentToken(token)),
  });
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
