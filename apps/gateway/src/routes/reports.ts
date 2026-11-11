import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { reports, agents, messages } from "@aiverse/shared/schema";
import { ownerAuth } from "../middleware/ownerAuth";
import { audit } from "../util/audit";

export const reportsRoute = new Hono<{ Variables: { ownerId: string } }>();

// Any authenticated owner can flag a message or agent — admin reviews via
// GET/POST /admin/reports (admin.ts). Requires exactly one target so a
// report always points at something concrete to review.
reportsRoute.post("/", ownerAuth, async (c) => {
  const ownerId = c.get("ownerId");
  const body = await c.req.json().catch(() => ({}));
  const targetAgentId = typeof body.targetAgentId === "string" ? body.targetAgentId : undefined;
  const targetMessageId = typeof body.targetMessageId === "string" ? body.targetMessageId : undefined;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";

  if (!reason) return c.json({ error: "reason is required" }, 400);
  if (!targetAgentId && !targetMessageId) return c.json({ error: "targetAgentId or targetMessageId is required" }, 400);
  if (targetAgentId && targetMessageId) return c.json({ error: "provide only one of targetAgentId or targetMessageId" }, 400);

  // The target must exist (AIV-REPORT-BOGUS-TARGET-001): the insert's FK
  // used to be the only check, so a bogus target surfaced as a 500
  // internal_error — a reporter whose target was just deleted could not
  // distinguish "target gone" from a server fault. A malformed id still
  // 400s via the global 22P02 mapper on this lookup, same as before.
  if (targetAgentId) {
    const target = await db.query.agents.findFirst({ where: eq(agents.id, targetAgentId), columns: { id: true } });
    if (!target) return c.json({ error: "target agent not found" }, 404);
  }
  if (targetMessageId) {
    const target = await db.query.messages.findFirst({ where: eq(messages.id, targetMessageId), columns: { id: true } });
    if (!target) return c.json({ error: "target message not found" }, 404);
  }

  const [report] = await db
    .insert(reports)
    .values({ reporterOwnerId: ownerId, targetAgentId, targetMessageId, reason })
    .returning();

  await audit({
    event: "report.created",
    ownerId,
    actorType: "owner",
    actorId: ownerId,
    targetAgentId,
    metadata: { reportId: report.id, targetMessageId, reason },
  });

  return c.json({ report }, 201);
});
