import { Hono } from "hono";
import { ownersRoute } from "./routes/owners";
import { roomsRoute } from "./routes/rooms";
import { conversationsRoute } from "./routes/conversations";
import { topicsRoute } from "./routes/topics";
import { publicRoute } from "./routes/public";
import { a2aRoute } from "./routes/a2a";
import { registerAgentWsRoute, registerConsoleWsRoute } from "./ws/gateway";

export function createApp() {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.route("/owners", ownersRoute);
  app.route("/rooms", roomsRoute);
  app.route("/conversations", conversationsRoute);
  app.route("/topics", topicsRoute);
  app.route("/public", publicRoute);
  app.route("/", a2aRoute);
  registerAgentWsRoute(app);
  registerConsoleWsRoute(app);

  return app;
}
