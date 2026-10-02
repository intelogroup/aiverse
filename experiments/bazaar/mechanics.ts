// The Bazaar — Phase 5 shared market mechanics.
//
// Pure functions, no I/O, no imports. This is the CANONICAL definition of the
// Phase 5 incentive parameters. Both the gateway verify route
// (apps/gateway/src/routes/bazaar.ts) and the live-run harness
// (experiments/bazaar/live-run.ts) import from here so the fee schedule,
// claim TTL, and sweep SQL can never drift apart.
//
// Phase 5 diagnosis (from 4 paid runs): the market died after the opening
// claim scramble — 6 bounties claimed in 6 ticks, then 46 ticks of passing.
// Three mechanisms failed: (1) no supply regeneration, (2) no cost to idle
// holding, (3) critics never verified (the 2cr fee lacked salience and the
// pass action was always safe). Phase 5 answers each:
//   1. House drip feed: the steward re-lists bounties while the board is thin.
//   2. Claim TTL: uncompleted claims auto-release back to open.
//   3. Escalating critic fee: stale verifications pay more, so clearing the
//      queue is the most profitable critic move.

export const CLAIM_TTL_MINUTES = 25;
export const VERIFY_FEE_BASE = 2;
export const VERIFY_FEE_STEP = 2;
export const VERIFY_SLA_MINUTES = 30;
export const VERIFY_FEE_CAP = 10;

// Critic fee for a verdict on work that has waited `waitingMinutes` since
// completion. Grows one step per full SLA window, capped. Immediate
// verification still pays exactly VERIFY_FEE_BASE (backwards compatible).
export function verifyFeeFor(waitingMinutes: number): number {
  const steps = Math.max(0, Math.floor(waitingMinutes / VERIFY_SLA_MINUTES));
  return Math.min(VERIFY_FEE_BASE + steps * VERIFY_FEE_STEP, VERIFY_FEE_CAP);
}

// Minutes until a claim on a task claimed at `claimedAt` expires.
// Negative = already expired (the sweep will release it).
export function claimExpiresInMinutes(claimedAt: Date | string | null, ttlMinutes: number = CLAIM_TTL_MINUTES): number {
  if (!claimedAt) return Infinity;
  const elapsed = (Date.now() - new Date(claimedAt).getTime()) / 60000;
  return ttlMinutes - elapsed;
}

// Periodic sweep: release claims whose TTL elapsed back to the open board.
// Single statement (atomic): selects expired claims under lock, flips them to
// open, and writes one claim_expired event per task with the pre-update
// claimant preserved. Races safely with claim/complete: both sides use
// guarded status flips, so exactly one of sweep-vs-complete wins per task.
export function claimExpirySweepSQL(ttlMinutes: number = CLAIM_TTL_MINUTES): string {
  return `
WITH expired AS (
  SELECT id, claimed_by, bounty FROM bazaar_tasks
  WHERE status = 'claimed' AND claimed_at < now() - (${ttlMinutes} || ' minutes')::interval
  FOR UPDATE
),
upd AS (
  UPDATE bazaar_tasks t SET status = 'open', claimed_by = NULL, claimed_at = NULL
  FROM expired e WHERE t.id = e.id
)
INSERT INTO bazaar_events (kind, task_id, actor_id, amount, detail)
SELECT 'claim_expired', e.id, e.claimed_by, e.bounty,
  jsonb_build_object('reason', 'claim TTL elapsed', 'ttl_minutes', ${ttlMinutes})
FROM expired e
RETURNING task_id;`.trim();
}
