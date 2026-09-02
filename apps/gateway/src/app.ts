import { Hono } from "hono";
import { cors } from "hono/cors";
import { sql } from "drizzle-orm";
import { env } from "@aiverse/shared/env";
import { db } from "./db/client";
import { redis } from "./redis/client";
import { ownersRoute } from "./routes/owners";
import { roomsRoute } from "./routes/rooms";
import { conversationsRoute } from "./routes/conversations";
import { topicsRoute } from "./routes/topics";
import { publicRoute } from "./routes/public";
import { a2aRoute } from "./routes/a2a";
import { authRoute } from "./routes/auth";
import { searchRoute } from "./routes/search";
import { goalsRoute, ownerGoalsRoute } from "./routes/goals";
import { memoryRoute } from "./routes/memory";
import { manifestRoute } from "./routes/manifest";
import { adminRoute } from "./routes/admin";
import { registerAgentWsRoute, registerConsoleWsRoute, registerPublicWsRoute } from "./ws/gateway";
import { log, logError } from "./util/log";

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
    // A handler that throws is caught by app.onError below and turned into
    // a normal Response before it ever propagates back through this
    // next() — it does NOT throw here (verified: a try/catch around next()
    // never ran). So this stays a plain post-next log, and status:500 here
    // is exactly how a route exception shows up in this line; the actual
    // error detail is logged once, in onError, where the throw is real.
    await next();
    log("http_request", {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - start),
    });
  });

  // A static "ok" reads healthy during a DB/Redis outage — probe both so a
  // deploy target's liveness check actually catches a dead dependency.
  app.get("/health", async (c) => {
    const [dbResult, redisResult] = await Promise.allSettled([db.execute(sql`select 1`), redis.ping()]);
    const dbOk = dbResult.status === "fulfilled";
    const redisOk = redisResult.status === "fulfilled";
    const status = dbOk && redisOk ? "ok" : "degraded";
    return c.json({ status, db: dbOk ? "ok" : "down", redis: redisOk ? "ok" : "down" }, status === "ok" ? 200 : 503);
  });
  app.route("/owners", ownersRoute);
  app.route("/rooms", roomsRoute);
  app.route("/conversations", conversationsRoute);
  app.route("/topics", topicsRoute);
  app.route("/public", publicRoute);
  app.route("/", a2aRoute);
  app.route("/auth", authRoute);
  app.route("/", searchRoute);
  app.route("/", goalsRoute);
  app.route("/", memoryRoute);
  app.route("/", manifestRoute);
  app.route("/owners", ownerGoalsRoute);
  app.route("/admin", adminRoute);
  registerAgentWsRoute(app);
  registerConsoleWsRoute(app);
  registerPublicWsRoute(app);

  // This is the actual catch point for a route exception (verified: it
  // fires before the request-logging middleware's next() sees anything —
  // Hono turns the throw into a Response here, not a rethrow up the
  // middleware chain). Log it here, once, with real detail; the caller
  // only ever sees consistent JSON, never a leaked stack trace.
  app.onError((err, c) => {
    logError("unhandled_route_error", err, { requestId: c.get("requestId"), path: c.req.path, method: c.req.method });
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
