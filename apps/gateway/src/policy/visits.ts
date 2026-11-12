import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db/client";
import { agentVisits } from "@aiverse/shared/schema";
import { redis } from "../redis/client";

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
  // Set when THIS call consumed one action (a non-GET/HEAD call admitted
  // against the active visit). agentAuth refunds it via refundVisitAction
  // when the handler then refuses the request (any >= 400 response), so a
  // refused request nets zero — the no-charge-on-refusal discipline the
  // budget and agent-calls counters already follow.
  consumed?: boolean;
  visitId?: string;
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
// Reading the RESULT of the action that reached the cap is not a new action: an agent whose last action was a minutes-long `see` (or a
// long walk) must still be able to collect it. A pending-result read (GET /world/act/:id, /world/see/:id) is let through for this long
// after the cap was first hit; every other call after the cap ends the visit exactly as before. The window is opened once per visit
// (SET NX), so polling cannot extend it, and the deadline still applies.
export const CAP_GRACE_SECONDS = 600;

export interface VisitCheckOptions {
  /** True for a read that only collects the result of an action already taken (act/see status polls). */
  resultRead?: boolean;
}

export async function checkAndConsumeVisit(agentId: string, method: string, opts: VisitCheckOptions = {}): Promise<VisitCheckResult> {
  const visit = await db.query.agentVisits.findFirst({
    where: eq(agentVisits.agentId, agentId),
    orderBy: (v, { desc }) => [desc(v.startedAt)],
  });
  if (!visit) return { allowed: true };
  if (visit.endedAt) return { allowed: false, reason: (visit.endedReason as VisitEndReason) ?? undefined };

  if (visit.actionsUsed >= visit.maxActions) {
    const isRead = method === "GET" || method === "HEAD";
    if (isRead && opts.resultRead && visit.endsAt.getTime() > Date.now()) {
      const opened = await redis.set(`visit:cap-grace:${visit.id}`, "1", "EX", CAP_GRACE_SECONDS, "NX").catch(() => null);
      const open = opened === "OK" || (opened === null && (await redis.exists(`visit:cap-grace:${visit.id}`).catch(() => 0)) === 1);
      if (open) return { allowed: true };
    }
    const ended = await endVisitRecord(visit.id, "action_cap");
    return { allowed: false, ended: ended ?? undefined, reason: "action_cap" };
  }
  if (visit.endsAt.getTime() <= Date.now()) {
    const ended = await endVisitRecord(visit.id, "time_expired");
    return { allowed: false, ended: ended ?? undefined, reason: "time_expired" };
  }

  if (method === "GET" || method === "HEAD") return { allowed: true };

  // Consume atomically: the cap predicate lives IN the increment, so a
  // concurrent burst cannot overshoot maxActions — the old read-compare-
  // then-increment admitted every writer that read actionsUsed before the
  // first increment landed (a cap-3 visit admitted 12). The pre-checks
  // above stay as the fast path (they also serve GET/HEAD, which never
  // consume); this UPDATE is the authority under concurrency.
  const [consumed] = await db
    .update(agentVisits)
    .set({ actionsUsed: sql`${agentVisits.actionsUsed} + 1` })
    .where(
      and(
        eq(agentVisits.id, visit.id),
        isNull(agentVisits.endedAt),
        lt(agentVisits.actionsUsed, visit.maxActions),
      ),
    )
    .returning({ id: agentVisits.id });
  if (consumed) return { allowed: true, consumed: true, visitId: visit.id };

  // Zero rows: either the visit ended concurrently (sweep, owner stop) or
  // a concurrent burst filled the cap after our read. Re-read to report
  // the true state; the cap case ends the visit here — endVisitRecord is
  // guarded on ended_at IS NULL, so exactly one caller announces it.
  const current = await db.query.agentVisits.findFirst({ where: eq(agentVisits.id, visit.id) });
  if (current?.endedAt) {
    return { allowed: false, reason: (current.endedReason as VisitEndReason) ?? undefined };
  }
  const ended = await endVisitRecord(visit.id, "action_cap");
  return { allowed: false, ended: ended ?? undefined, reason: "action_cap" };
}

// Compensating action for the consume in checkAndConsumeVisit: agentAuth
// runs the consume BEFORE the route handler (the cap/deadline refusal
// must precede any handler work), so a request the handler then refuses
// has spent an action on nothing. agentAuth calls this on any >= 400
// response to give the action back — floored at zero, and a no-op for a
// visit whose counter has already been settled by other traffic.
export async function refundVisitAction(visitId: string): Promise<void> {
  await db
    .update(agentVisits)
    .set({ actionsUsed: sql`${agentVisits.actionsUsed} - 1` })
    .where(and(eq(agentVisits.id, visitId), gt(agentVisits.actionsUsed, 0)));
}

// Counts one action on the agent's active visit, for routes that authenticate
// with agentAuthUncounted and count only once the call really acted.
export async function consumeVisitAction(agentId: string): Promise<void> {
  await db
    .update(agentVisits)
    .set({ actionsUsed: sql`${agentVisits.actionsUsed} + 1` })
    .where(and(eq(agentVisits.agentId, agentId), isNull(agentVisits.endedAt)));
}

// Owner-triggered end (POST .../visits/:id/stop) — same terminal row state
// as an automatic end, distinguished only by reason. Scoped to the owner by
// the caller's own ownership check before this is called, same as every
// other owner-scoped mutation in owners.ts.
export async function stopVisitRecord(visitId: string): Promise<EndedVisit | null> {
  return endVisitRecord(visitId, "owner_stopped");
}

// The claim-time starter visit (2026-11-10): signup ends at presence, so a
// freshly claimed agent starts its first visit immediately and can take a
// body (POST /world/body refuses visit-less agents) with zero further
// owner calls. Sized to let an agent settle in and do real work, well
// inside the bounds above; the owner can stop it, extend it, or start a
// bigger one from the console at any time.
//
// Length (2026-11-11): 30 -> 120 minutes. The 50-agent loadtest ran a
// fleet on starter visits and every slot needed a mid-run extension (a
// stop -> start -> re-attach dance at the time) — a real settling-in
// session with an LLM-paced agent runs past half an hour as a matter of
// course. Two hours is still far inside the one-week maximum, and the
// action cap (unchanged) is what prices the visit's activity.
export const STARTER_VISIT_MINUTES = 120;
export const STARTER_VISIT_ACTIONS = 200;

// Owner extension of an ACTIVE visit in place (2026-11-11): moves the
// deadline out by addMinutes without ending the visit — the agent keeps
// its body, its action count, and its session, where the old path was
// stop -> start -> re-attach. Guarded like endVisitRecord: the UPDATE
// only lands while the visit is still active AND still carries the
// deadline the caller read, so a racing end (sweep, owner stop) or a
// racing extension makes the loser a no-op (returns null) instead of
// resurrecting or double-extending a visit.
export async function extendVisitRecord(
  visit: { id: string; endsAt: Date },
  addMinutes: number,
): Promise<typeof agentVisits.$inferSelect | null> {
  const endsAt = new Date(visit.endsAt.getTime() + addMinutes * 60_000);
  const [updated] = await db
    .update(agentVisits)
    .set({ endsAt })
    .where(and(eq(agentVisits.id, visit.id), isNull(agentVisits.endedAt), eq(agentVisits.endsAt, visit.endsAt)))
    .returning();
  return updated ?? null;
}

// Starts a visit unless the agent already has an active one (endedAt IS
// NULL — the same "active" test the start route and agentAuth use), in
// which case it returns the existing row with created:false instead of
// double-starting. The claim route's auto-start uses this; the owner
// start route keeps its own check-then-insert so its 409 precedence
// (active-visit before body validation) is unchanged.
export async function startVisitIfNoneActive(
  agentId: string,
  ownerId: string,
  minutes: number,
  maxActions: number,
): Promise<{ visit: typeof agentVisits.$inferSelect; created: boolean }> {
  const active = await db.query.agentVisits.findFirst({
    where: and(eq(agentVisits.agentId, agentId), isNull(agentVisits.endedAt)),
  });
  if (active) return { visit: active, created: false };
  try {
    const [visit] = await db
      .insert(agentVisits)
      .values({ agentId, ownerId, endsAt: new Date(Date.now() + minutes * 60_000), maxActions })
      .returning();
    return { visit, created: true };
  } catch (err: any) {
    // A concurrent start (owner route or another claim) won the race
    // between the check above and this insert: the partial unique index
    // on active visits (migration 0043) rejects ours with 23505. That is
    // exactly this function's "already has one" case — return the
    // winner's row instead of surfacing a 500. Same drizzle-wrapping
    // trap as elsewhere: the PG code lives on cause, not the wrapper.
    const pgCode = err?.code ?? err?.cause?.code;
    const detail = String(err?.cause?.message ?? err?.message ?? err);
    if (pgCode === "23505" || detail.includes("agent_visits_one_active")) {
      const winner = await db.query.agentVisits.findFirst({
        where: and(eq(agentVisits.agentId, agentId), isNull(agentVisits.endedAt)),
      });
      if (winner) return { visit: winner, created: false };
    }
    throw err;
  }
}
