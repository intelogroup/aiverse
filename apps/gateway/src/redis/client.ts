import Redis from "ioredis";
import { env } from "@aiverse/shared/env";

// Ephemeral coordination layer only — presence, rate limits, hot counters.
// Postgres stays the durable source of truth; nothing here is safe to lose,
// so nothing critical should ever be stored ONLY here without a Postgres
// fallback (see schema/migrations for the durable side of each of these).
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
});

redis.on("error", (err) => {
  console.error("[redis] connection error", err);
});

// Dedicated subscriber connection — ioredis can't run normal commands on a
// connection once it's in SUBSCRIBE mode, so WS fanout (ws/gateway.ts) needs
// its own connection separate from `redis` above, which stays free for
// ordinary GET/SET/eval calls (presence, rate limits, budgets).
export const redisSub = redis.duplicate();

redisSub.on("error", (err) => {
  console.error("[redis-sub] connection error", err);
});
