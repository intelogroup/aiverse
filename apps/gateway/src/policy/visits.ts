import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import { agentVisits } from "@aiverse/shared/schema";

// Pure DB logic — no ws/gateway import here, on purpose: ws/gateway.ts's own
// WS-connect handler needs to call checkAndConsumeVisit too, and it already
// owns the disconnect/notify side effect (announceVisitEnded, defined
// there), so this file importing back from it would be a cycle. Every
// caller that gets back an `ended` result is responsible for calling
// announceVisitEnded itself.

export const MIN_VISIT_MINUTES = 5;
export const MAX_VISIT_MINUTES = 7 * 24 * 60; // one week
export const MIN_VISIT_ACTIONS = 1;
export const MAX_VISIT_ACTIONS = 100_000;

export type VisitEndReason = "time_expired" | "action_cap" | "presence_expired" | "owner_stopped";

export interface EndedVisit {
  id: string;
  agentId: string;
  ownerId: string;
  reason: VisitEndReason;
}

// Guarded on ended_at IS NULL so a race between two callers (the request
// path and the sweep job, say) ends a visit exactly once — the loser's
// UPDATE affects zero rows and this returns null for it.
export async function endVisitRecord(visitId: string, reason: VisitEndReason): Promise<EndedVisit | null> {
  const [ended] = await db
    .update(agentVisits)
    .set({ endedAt: new Date(), endedReason: reason })
    .where(and(eq(agentVisits.id, visitId), isNull(agentVisits.endedAt)))
    .returning({ id: agentVisits.id, agentId: agentVisits.agentId, ownerId: agentVisits.ownerId });
  return ended ? { ...ended, reason } : null;
}

export interface VisitCheckResult {
  allowed: boolean;
  // Set when THIS call is the one that ended the visit — the caller uses it
  // to announce (disconnect + notify) exactly once.
  ended?: EndedVisit;
  // The reason to report to the caller either way: from `ended` when this
  // call just ended it, or from the row's own endedReason when it was
  // already ended by an earlier call or the sweep (the sticky-refusal case).
  reason?: VisitEndReason;
}

// Called from agentAuth (every authenticated HTTP request) and ws/gateway's
// WS connect handler.
//
// Visits are opt-in but, once adopted, sticky: an agent that has never had
// one is unrestricted (no regression for every agent that predates this
// feature). An agent whose most recent visit has ENDED is refused — not
// reverted to unrestricted — until its owner starts a new one. Without this,
// "step down after N minutes" would be meaningless: the agent would simply
// keep acting normally the moment its visit lapsed. So this looks at the
// MOST RECENT visit regardless of end state, not just an active one.
//
// An active visit past its deadline or cap is ended here and refuses the
// call; otherwise a non-GET/HEAD call (a real action, not a read) counts
// against it. Passing method "GET" checks without ever consuming — what WS
// connect uses, since connecting isn't itself an action.
export async function checkAndConsumeVisit(agentId: string, method: string): Promise<VisitCheckResult> {
  const visit = await db.query.agentVisits.findFirst({
    where: eq(agentVisits.agentId, agentId),
    orderBy: (v, { desc }) => [desc(v.startedAt)],
  });
  if (!visit) return { allowed: true };
  if (visit.endedAt) return { allowed: false, reason: (visit.endedReason as VisitEndReason) ?? undefined };

  if (visit.actionsUsed >= visit.maxActions) {
    const ended = await endVisitRecord(visit.id, "action_cap");
    return { allowed: false, ended: ended ?? undefined, reason: "action_cap" };
  }
  if (visit.endsAt.getTime() <= Date.now()) {
    const ended = await endVisitRecord(visit.id, "time_expired");
    return { allowed: false, ended: ended ?? undefined, reason: "time_expired" };
  }

  if (method !== "GET" && method !== "HEAD") {
    await db
      .update(agentVisits)
      .set({ actionsUsed: sql`${agentVisits.actionsUsed} + 1` })
      .where(eq(agentVisits.id, visit.id));
  }
  return { allowed: true };
}

// Owner-triggered end (POST .../visits/:id/stop) — same terminal row state
// as an automatic end, distinguished only by reason. Scoped to the owner by
// the caller's own ownership check before this is called, same as every
// other owner-scoped mutation in owners.ts.
export async function stopVisitRecord(visitId: string): Promise<EndedVisit | null> {
  return endVisitRecord(visitId, "owner_stopped");
}
