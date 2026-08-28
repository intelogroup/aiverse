// Primary outcome report for the Native Ambient Utility experiment.
// See experiments/native-ambient-utility/preregistration.md — the queries here
// ARE the frozen primary outcome query; this script is measurement, not
// product code, and must not change after Run 1 begins.
//
// Usage:
//   DATABASE_URL=... bun run scripts/native-experiment-report.ts           # all runs
//   DATABASE_URL=... bun run scripts/native-experiment-report.ts <runId>   # one run
//
// Prints, per native_run: native-attributed materialized outcomes, success
// events (source_run_id NOT NULL AND goal_accepted = true), awaiting-verdict
// counts, and the overall native traffic share (the D-curve).

import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
const runId = process.argv[2] ?? null;

try {
  // Frozen primary outcome query — success events
  const events = await sql`
    SELECT o.task_id, o.source_run_id, o.context_id, o.created_at, o.goal_accepted
    FROM task_outcomes o
    WHERE o.source_run_id IS NOT NULL AND o.goal_accepted = true
    ${runId ? sql`AND o.source_run_id = ${runId}` : sql``}
    ORDER BY o.created_at DESC
  `;

  // Per-run rollup
  const perRun = await sql`
    SELECT r.id, r.status, r.mode, r.model, r.started_at, r.ended_at,
           count(o.id) AS native_attributed_outcomes,
           count(o.id) FILTER (WHERE o.goal_accepted = true) AS success_events,
           count(o.id) FILTER (WHERE o.goal_accepted IS NULL) AS awaiting_verdict
    FROM native_runs r
    LEFT JOIN task_outcomes o ON o.source_run_id = r.id
    ${runId ? sql`WHERE r.id = ${runId}` : sql``}
    GROUP BY r.id
    ORDER BY r.started_at DESC
  `;

  // Native traffic share (D-curve): native share of ALL materialized outcomes.
  // Natives are any side (caller or target) — they're liquidity providers.
  const curve = await sql`
    SELECT count(*) AS total_outcomes,
           count(*) FILTER (WHERE caller_is_native OR target_is_native) AS native_involved,
           round(100.0 * count(*) FILTER (WHERE caller_is_native OR target_is_native) / GREATEST(count(*), 1), 1) AS native_share_pct
    FROM task_outcomes
  `;

  console.log("=== Native Ambient Utility — outcome report ===\n");
  if (runId) console.log(`(scoped to run ${runId})\n`);

  console.log("Success events (source_run_id NOT NULL AND goal_accepted = true):");
  if (events.length === 0) {
    console.log("  NONE — record this as a clean negative result, with the same care as a positive one.\n");
  }
  for (const e of events) {
    console.log(`  task=${e.task_id} run=${e.source_run_id} context=${e.context_id} at=${e.created_at.toISOString()}`);
  }

  console.log("\nPer-run rollup:");
  for (const r of perRun) {
    console.log(
      `  run=${r.id} status=${r.status} mode=${r.mode} model=${r.model ?? "n/a"} ` +
        `nativeAttributed=${r.native_attributed_outcomes} success=${r.success_events} ` +
        `awaitingVerdict=${r.awaiting_verdict} ` +
        `[${r.started_at?.toISOString() ?? "?"} → ${r.ended_at?.toISOString() ?? "running"}]`,
    );
  }

  console.log("\nNative traffic share (D-curve, all materialized outcomes):");
  for (const c of curve) {
    console.log(`  total=${c.total_outcomes} nativeInvolved=${c.native_involved} share=${c.native_share_pct}%`);
    if (Number(c.native_share_pct) >= 50 && Number(c.total_outcomes) > 50) {
      console.log("  ⚠ share ≥ 50% with real volume — natives ARE the economy; see prereg graduation targets.");
    }
  }
} finally {
  await sql.end();
}
