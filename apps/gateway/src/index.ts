import { env } from "@aiverse/shared/env";
import { createApp } from "./app";
import { websocket, reconcilePresenceOnBoot } from "./ws/gateway";
import { ensureRoomsSeeded } from "./db/seed";

const app = createApp();
await ensureRoomsSeeded();
await reconcilePresenceOnBoot();

export default {
  port: env.PORT,
  fetch: app.fetch,
  websocket,
};
