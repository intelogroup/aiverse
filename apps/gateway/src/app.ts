import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "@aiverse/shared/env";
import { ownersRoute } from "./routes/owners";
import { roomsRoute } from "./routes/rooms";
import { conversationsRoute } from "./routes/conversations";
import { topicsRoute } from "./routes/topics";
import { publicRoute } from "./routes/public";
import { a2aRoute } from "./routes/a2a";
import { registerAgentWsRoute, registerConsoleWsRoute, registerPublicWsRoute } from "./ws/gateway";

export function createApp() {
  const app = new Hono();

  app.use("*", cors({ origin: env.CONSOLE_ORIGINS, credentials: true }));

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.route("/owners", ownersRoute);
  app.route("/rooms", roomsRoute);
  app.route("/conversations", conversationsRoute);
  app.route("/topics", topicsRoute);
  app.route("/public", publicRoute);
  app.route("/", a2aRoute);
  registerAgentWsRoute(app);
  registerConsoleWsRoute(app);
  registerPublicWsRoute(app);

  return app;
}
