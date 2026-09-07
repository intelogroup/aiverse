import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env, isPooledDbUrl } from "@aiverse/shared/env";
import * as schema from "@aiverse/shared/schema";

// prepare:false when DATABASE_URL is the Neon pooled (-pooler) endpoint:
// transaction-mode pooling can't hold server-side prepared statements —
// postgres.js prepares queries after 5 executions and would then start
// failing intermittently with "prepared statement does not exist" once
// PgBouncer routes successive executions to different backends. On a
// direct connection, prepared statements stay enabled (faster).
const sql = postgres(env.DATABASE_URL, {
  max: env.DB_POOL_MAX,
  prepare: !isPooledDbUrl(env.DATABASE_URL),
});
export const db = drizzle(sql, { schema });
