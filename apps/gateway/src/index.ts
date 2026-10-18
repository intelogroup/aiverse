import { env } from "@aiverse/shared/env";
import { createApp } from "./app";
import { websocket, reconcilePresenceOnBoot } from "./ws/gateway";
import { ensureRoomsSeeded } from "./db/seed";
import { tryBecomeGatewayLeader, checkGatewayLeadership } from "./db/singleGatewayLock";
import { log, logError } from "./util/log";

// Without these, a crash outside the request-handling path (a background
// job's rejected promise, a bug in a timer callback) produces nothing but
// Bun's default stderr dump — not the structured JSON everything else logs,
// so it can't be grepped or alerted on the same way. uncaughtException still
// exits: the process is in an undefined state per Node's own docs, and
// staying up risks worse damage than a restart. unhandledRejection only
// logs — native-agent ticks and background jobs reject often enough on
// transient DB/Redis blips that exiting on every one would be its own
// availability problem; the process supervisor (Render, systemd, etc.) is
// the actual restart mechanism for the exit-on-exception case below.
process.on("uncaughtException", (err) => {
  logError("uncaught_exception", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logError("unhandled_rejection", reason);
});

const app = createApp();

// Every process serves HTTP/WS traffic (Redis pub/sub fanout in ws/gateway.ts
// makes that correct across any number of instances). Only the elected
// leader also runs the singleton background jobs below — two processes both
// ticking the same native would double-act it and double-spend its wallet,
// which Redis fanout does nothing to prevent (see singleGatewayLock.ts).
//
// WI-5 (serving-first follower boot): the leader election no longer blocks
// the export at the bottom of this module — Bun only starts serving once
// module evaluation finishes, and tryBecomeGatewayLeader retries for up to
// 30 s by default (the Render deploy-overlap window), so awaiting it here
// used to leave a follower dark for that whole window even though serving
// never depended on the outcome. The election now runs concurrently (see
// the bottom of this file); only the singleton jobs wait for the lock,
// gated additionally on bootPrep so they still start strictly after
// seeding/reconciliation, exactly as the old sequential boot ordered them.
// What still gates serving is bootPrep alone — the same two steps, with
// the same fail-loud semantics (a rejection here fails module evaluation
// before anything is served, as the bare awaits did before).
const bootPrep = (async () => {
  await ensureRoomsSeeded();
  await reconcilePresenceOnBoot();
})();

// Live failover (soak test 2026-09-22): with election only at boot, a dead
// leader left the survivors serving traffic with no one persisting messages
// (Postgres frozen while sends kept 201-ing) until some process restarted.
// Followers now retry the lock; the leader re-checks that it still holds it.
// Env-tunable (2026-10-17, Neon compute bridge): on the Free plan every DB
// touch costs a ~5-min scale-to-zero tail, so while the verse is idle the
// check stretches to let the compute sleep between heartbeats. The default
// is the production value; failover latency scales with whatever is set.
const LEADER_CHECK_MS = (() => {
  const v = Number(process.env.AIVERSE_LEADER_CHECK_MS);
  return Number.isFinite(v) && v > 0 ? v : 15_000;
})();
let singletonJobsStarted = false;

async function startSingletonJobs() {
  if (singletonJobsStarted) return;
  singletonJobsStarted = true;
  const { scheduleGc } = await import("./jobs/gc");
  scheduleGc();
  const { scheduleOutcomeLedger } = await import("./jobs/outcomeLedger");
  scheduleOutcomeLedger();
  const { scheduleNativeAgents } = await import("./jobs/nativeAgents");
  scheduleNativeAgents();
  // Ingest buffer consumer (perf/redis-hot-path item 1): batch-persists the
  // verse:ingest stream to Postgres. Leader-only like the other singleton
  // jobs — two consumers would still be safe (consumer groups + idempotent
  // persist) but pointless.
  const { scheduleIngestConsumer } = await import("./jobs/ingestConsumer");
  scheduleIngestConsumer();
  // Cursor acks v1 (PHASE1_SPEC WI-4): leader-only checkpoint writer —
  // flushes Redis ack cursors + mention ack sets to Postgres every
  // AIVERSE_ACK_CHECKPOINT_MS (default 30s). Followers still advance
  // Redis cursors on the ack path; only the flush is singleton work.
  const { scheduleAckCheckpoint } = await import("./ws/ackCursors");
  scheduleAckCheckpoint();
  // Bazaar (experiment/bazaar): escrow-expiry sweep. Only scheduled when the
  // routes themselves are mounted (see app.ts) — no bazaar_* tables, nothing
  // to sweep.
  if (process.env.AIVERSE_BAZAAR_MODE === "1") {
    const { scheduleBazaarExpiry } = await import("./routes/bazaar");
    scheduleBazaarExpiry();
  }
  const { scheduleVisitsSweep } = await import("./jobs/visits");
  scheduleVisitsSweep();
  startLeaderWatchdog();
}

// A leader whose lock session died (network drop, DB-side kill) would keep
// running the singleton jobs while a follower takes the lock — two leaders.
// The scheduled jobs have no stop hooks, so stepping down means exiting and
// letting the supervisor restart this process as a follower. DB errors are
// tolerated for a few checks (a transient blip shouldn't bounce the leader).
function startLeaderWatchdog() {
  let consecutiveErrors = 0;
  setInterval(async () => {
    try {
      const status = await checkGatewayLeadership();
      consecutiveErrors = 0;
      if (status === "reacquired") log("gateway_leader_reacquired", {});
      if (status === "lost") {
        logError("gateway_leader_lost", new Error("another process holds the leader lock; exiting to stop singleton jobs"));
        process.exit(1);
      }
    } catch (err) {
      consecutiveErrors++;
      logError("gateway_leader_check_error", err, { consecutiveErrors });
      if (consecutiveErrors >= 3) process.exit(1);
    }
  }, LEADER_CHECK_MS);
}

// Singleton jobs start only once leadership is held AND boot prep has
// finished — the pre-WI-5 boot sequenced seed/reconcile strictly before
// startSingletonJobs, and that ordering is preserved on every path that
// reaches the jobs (boot win below, or a later failover win).
async function startSingletonJobsAfterPrep() {
  await bootPrep;
  await startSingletonJobs();
}

// Live failover, unchanged from the pre-WI-5 boot: followers retry the lock
// every LEADER_CHECK_MS (single attempt each) and start the singleton jobs
// when they win it.
function startFollowerRetry() {
  let attempting = false;
  const retry = setInterval(async () => {
    if (attempting) return;
    attempting = true;
    try {
      if (await tryBecomeGatewayLeader({ timeoutMs: 0 })) {
        clearInterval(retry);
        log("gateway_leader_failover", {});
        await startSingletonJobsAfterPrep();
      }
    } catch (err) {
      logError("gateway_leader_retry_error", err);
    } finally {
      attempting = false;
    }
  }, LEADER_CHECK_MS);
}

// Boot election, started but NOT awaited (WI-5): this module's export below
// is what makes Bun serve, so evaluation must reach it without waiting out
// the election's deploy-overlap retry window. tryBecomeGatewayLeader is
// invoked synchronously inside this IIFE, so the first attempt starts
// during module evaluation, concurrently with boot prep — leadership
// simply resolves whenever it resolves: an uncontended win lands the
// singleton jobs at
// boot, a loss (or a thrown attempt — logged, then treated as a loss)
// lands this process in the follower retry above. A failure starting the
// singleton jobs after a boot win exits the process: before WI-5 that
// throw surfaced as a failed top-level await and the boot crashed the
// same way, leaving the restart to the supervisor.
const leadership = (async () => {
  let isLeader = false;
  try {
    isLeader = await tryBecomeGatewayLeader();
  } catch (err) {
    logError("gateway_leader_boot_error", err);
  }
  log("gateway_role", { leader: isLeader });
  if (isLeader) {
    await startSingletonJobsAfterPrep();
  } else {
    startFollowerRetry();
  }
})();
leadership.catch((err) => {
  logError("gateway_boot_error", err);
  process.exit(1);
});

// Serving still waits for boot prep (seed + presence reconcile) — it is
// only the election that moved off the critical path.
await bootPrep;

export default {
  port: env.PORT,
  fetch: app.fetch,
  websocket,
};
