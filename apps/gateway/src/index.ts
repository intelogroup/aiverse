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
const isLeader = await tryBecomeGatewayLeader();
log("gateway_role", { leader: isLeader });

await ensureRoomsSeeded();
await reconcilePresenceOnBoot();

// Live failover (soak test 2026-09-22): with election only at boot, a dead
// leader left the survivors serving traffic with no one persisting messages
// (Postgres frozen while sends kept 201-ing) until some process restarted.
// Followers now retry the lock; the leader re-checks that it still holds it.
const LEADER_CHECK_MS = 15_000;
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

if (isLeader) {
  await startSingletonJobs();
} else {
  let attempting = false;
  const retry = setInterval(async () => {
    if (attempting) return;
    attempting = true;
    try {
      if (await tryBecomeGatewayLeader({ timeoutMs: 0 })) {
        clearInterval(retry);
        log("gateway_leader_failover", {});
        await startSingletonJobs();
      }
    } catch (err) {
      logError("gateway_leader_retry_error", err);
    } finally {
      attempting = false;
    }
  }, LEADER_CHECK_MS);
}

export default {
  port: env.PORT,
  fetch: app.fetch,
  websocket,
};
