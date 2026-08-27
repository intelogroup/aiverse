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
