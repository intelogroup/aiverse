import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { env } from "@aiverse/shared/env";

// Migrations run on the DIRECT (unpooled) connection, never the pooler:
// drizzle wraps each migration file in BEGIN/COMMIT and DDL through a
// transaction-mode PgBouncer can be routed mid-transaction. Neon's own
// guidance is migrations-via-direct; DATABASE_URL_DIRECT falls back to
// DATABASE_URL until a pooled URL is in use.
const sql = postgres(env.DATABASE_URL_DIRECT, { max: 1 });
const db = drizzle(sql);

await migrate(db, { migrationsFolder: "./drizzle" });
await sql.end();

console.log("migrations applied");
