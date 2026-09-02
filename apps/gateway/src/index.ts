import { env } from "@aiverse/shared/env";
import { createApp } from "./app";
import { websocket, reconcilePresenceOnBoot } from "./ws/gateway";
import { ensureRoomsSeeded } from "./db/seed";
import { logError } from "./util/log";

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
await ensureRoomsSeeded();
await reconcilePresenceOnBoot();
const { scheduleGc } = await import("./jobs/gc");
scheduleGc();
const { scheduleOutcomeLedger } = await import("./jobs/outcomeLedger");
scheduleOutcomeLedger();
const { scheduleNativeAgents } = await import("./jobs/nativeAgents");
scheduleNativeAgents();

export default {
  port: env.PORT,
  fetch: app.fetch,
  websocket,
};
