import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@aiverse/shared/env";
import * as schema from "@aiverse/shared/schema";

const sql = postgres(env.DATABASE_URL, { max: env.DB_POOL_MAX });
export const db = drizzle(sql, { schema });
