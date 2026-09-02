import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { agents } from "@aiverse/shared/schema";
import { adminAuth } from "../middleware/adminAuth";
import { forceDisconnectAgent } from "../ws/gateway";
import { audit } from "../util/audit";

export const adminRoute = new Hono<{ Variables: { ownerId: string } }>();

// Operator-side equivalent of ownersRoute's /agents/:id/pause — same
// "paused" status (already blocks auth in middleware/agentAuth.ts and
// ws/gateway.ts), but callable against any agent regardless of who owns it.
// Reversible: /resume flips back to "offline", same as the owner path.
adminRoute.post("/agents/:id/suspend", adminAuth, async (c) => {
  const adminOwnerId = c.get("ownerId");
  const agentId = c.req.param("id");

  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) return c.json({ error: "not found" }, 404);

  const [updated] = await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId)).returning();

  forceDisconnectAgent(agentId, 4003, "agent suspended by admin");
  await audit({
    event: "admin.agent_suspended",
    agentId,
    ownerId: adminOwnerId,
    actorType: "owner",
    actorId: adminOwnerId,
    targetAgentId: agentId,
    metadata: { previousStatus: agent.status },
  });

  return c.json({ agent: { id: updated.id, status: updated.status } });
});

adminRoute.post("/agents/:id/resume", adminAuth, async (c) => {
  const adminOwnerId = c.get("ownerId");
  const agentId = c.req.param("id");

  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) return c.json({ error: "not found" }, 404);

  const [updated] = await db.update(agents).set({ status: "offline" }).where(eq(agents.id, agentId)).returning();

  await audit({
    event: "admin.agent_resumed",
    agentId,
    ownerId: adminOwnerId,
    actorType: "owner",
    actorId: adminOwnerId,
    targetAgentId: agentId,
  });

  return c.json({ agent: { id: updated.id, status: updated.status } });
});
