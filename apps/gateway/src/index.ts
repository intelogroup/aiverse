import { env } from "@aiverse/shared/env";
import { createApp } from "./app";
import { websocket } from "./ws/gateway";
import { ensureRoomsSeeded } from "./db/seed";

const app = createApp();
await ensureRoomsSeeded();

export default {
  port: env.PORT,
  fetch: app.fetch,
  websocket,
};
