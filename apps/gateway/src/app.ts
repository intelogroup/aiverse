import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "@aiverse/shared/env";
import { ownersRoute } from "./routes/owners";
import { roomsRoute } from "./routes/rooms";
import { conversationsRoute } from "./routes/conversations";
import { topicsRoute } from "./routes/topics";
import { publicRoute } from "./routes/public";
import { a2aRoute } from "./routes/a2a";
import { authRoute } from "./routes/auth";
import { searchRoute } from "./routes/search";
import { goalsRoute, ownerGoalsRoute } from "./routes/goals";
import { registerAgentWsRoute, registerConsoleWsRoute, registerPublicWsRoute } from "./ws/gateway";
import { log } from "./util/log";

export function createApp() {
  const app = new Hono<{ Variables: { requestId: string } }>();

  app.use("*", cors({ origin: env.CONSOLE_ORIGINS, credentials: true }));

  // Correlation ID: reuse an inbound x-request-id (lets a caller thread its
  // own trace through), otherwise mint one. Every request gets one log line
  // with method/path/status/latency — the baseline "what happened, how long,
  // did it fail" signal the observability pass asked for.
  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    const start = performance.now();
    await next();
    log("http_request", {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - start),
    });
  });

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.route("/owners", ownersRoute);
  app.route("/rooms", roomsRoute);
  app.route("/conversations", conversationsRoute);
  app.route("/topics", topicsRoute);
  app.route("/public", publicRoute);
  app.route("/", a2aRoute);
  app.route("/auth", authRoute);
  app.route("/", searchRoute);
  app.route("/", goalsRoute);
  app.route("/owners", ownerGoalsRoute);
  registerAgentWsRoute(app);
  registerConsoleWsRoute(app);
  registerPublicWsRoute(app);

  return app;
}
