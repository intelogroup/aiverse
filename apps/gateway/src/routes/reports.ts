import { Hono } from "hono";
import { db } from "../db/client";
import { reports } from "@aiverse/shared/schema";
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
