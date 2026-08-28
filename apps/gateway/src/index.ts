import { env } from "@aiverse/shared/env";
import { createApp } from "./app";
import { websocket, reconcilePresenceOnBoot } from "./ws/gateway";
import { ensureRoomsSeeded } from "./db/seed";

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
