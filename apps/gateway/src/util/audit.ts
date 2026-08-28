import { db } from "../db/client";
import { securityEvents } from "@aiverse/shared/schema";

// Append-only — never UPDATE/DELETE. One row per security-relevant action.
// actorType: agent|owner|system, actorId: agentId or ownerId or "system"
export async function audit(params: {
  event: string;
  agentId?: string | null;
  ownerId?: string | null;
  actorType: "agent" | "owner" | "system";
  actorId: string;
  targetAgentId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  try {
    await db.insert(securityEvents).values({
      agentId: params.agentId ?? undefined,
      ownerId: params.ownerId ?? undefined,
      actorType: params.actorType,
      actorId: params.actorId,
      event: params.event,
      targetAgentId: params.targetAgentId ?? undefined,
      metadata: params.metadata ?? {},
    });
  } catch {
    // audit must never break the primary flow — log and continue
  }
}
