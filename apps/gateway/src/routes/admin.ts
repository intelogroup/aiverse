import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { agents, owners, reports } from "@aiverse/shared/schema";
import { adminAuth } from "../middleware/adminAuth";
import { forceDisconnectAgent } from "../ws/gateway";
import { audit } from "../util/audit";
import { deleteAgentCascade, deleteOwnerCascade } from "../util/deleteAgent";

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

// Admin-side hard delete — same cascade as ownersRoute's DELETE /agents/:id
// (util/deleteAgent.ts), callable against any agent regardless of who owns
// it. Doesn't require the owner's own session, unlike the owner-scoped route.
adminRoute.delete("/agents/:id", adminAuth, async (c) => {
  const adminOwnerId = c.get("ownerId");
  const agentId = c.req.param("id");

  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) return c.json({ error: "not found" }, 404);

  forceDisconnectAgent(agentId, 4006, "agent deleted by admin");
  await audit({
    event: "admin.agent_deleted",
    agentId,
    ownerId: adminOwnerId,
    actorType: "owner",
    actorId: adminOwnerId,
    targetAgentId: agentId,
    metadata: { name: agent.name, previousOwnerId: agent.ownerId },
  });
  await db.transaction((tx) => deleteAgentCascade(tx, agentId));

  return c.json({ ok: true });
});

// Admin-side hard delete of an owner and everything they own. Same use
// case as the owner self-delete route, but callable by an admin without
// the target owner's session (e.g. cleaning up throwaway/test accounts).
adminRoute.delete("/owners/:id", adminAuth, async (c) => {
  const adminOwnerId = c.get("ownerId");
  const ownerId = c.req.param("id");

  const owner = await db.query.owners.findFirst({ where: eq(owners.id, ownerId) });
  if (!owner) return c.json({ error: "not found" }, 404);

  const ownedAgents = await db.query.agents.findMany({ where: eq(agents.ownerId, ownerId) });
  for (const a of ownedAgents) forceDisconnectAgent(a.id, 4006, "owner account deleted by admin");

  await audit({
    event: "admin.owner_deleted",
    ownerId: adminOwnerId,
    actorType: "owner",
    actorId: adminOwnerId,
    metadata: { deletedOwnerId: ownerId, email: owner.email, agentCount: ownedAgents.length },
  });
  await db.transaction((tx) => deleteOwnerCascade(tx, ownerId));

  return c.json({ ok: true });
});

// Abuse-report review queue. Defaults to open reports; ?status= filters
// to reviewed/dismissed for a history view.
adminRoute.get("/reports", adminAuth, async (c) => {
  const status = c.req.query("status") as "open" | "reviewed" | "dismissed" | undefined;

  const list = await db.query.reports.findMany({
    where: status ? eq(reports.status, status) : eq(reports.status, "open"),
    orderBy: desc(reports.createdAt),
    limit: 100,
  });
  return c.json({ reports: list });
});

adminRoute.post("/reports/:id/resolve", adminAuth, async (c) => {
  const adminOwnerId = c.get("ownerId");
  const reportId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const status = body.status as "reviewed" | "dismissed" | undefined;
  if (status !== "reviewed" && status !== "dismissed") return c.json({ error: "status must be reviewed or dismissed" }, 400);

  const report = await db.query.reports.findFirst({ where: eq(reports.id, reportId) });
  if (!report) return c.json({ error: "not found" }, 404);

  const [updated] = await db
    .update(reports)
    .set({ status, reviewedByOwnerId: adminOwnerId, reviewedAt: new Date() })
    .where(eq(reports.id, reportId))
    .returning();

  await audit({
    event: "admin.report_resolved",
    ownerId: adminOwnerId,
    actorType: "owner",
    actorId: adminOwnerId,
    targetAgentId: report.targetAgentId,
    metadata: { reportId, status },
  });

  return c.json({ report: updated });
});
