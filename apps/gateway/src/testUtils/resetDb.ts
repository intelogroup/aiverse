// Test preload (apps/gateway/bunfig.toml): empty every table once per `bun test` run, so a local run starts from the
// same state as CI's fresh Postgres container. Without it, fixed test names left by earlier runs ("DefaultModeAgent")
// make /owners/agents return 409 and ~150 tests fail locally while CI is green. No migration seeds rows, so a
// truncate leaves exactly what `db:migrate` gives CI. Only a loopback aiverse_test database is safe to reset.
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (url) {
  const target = new URL(url);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname);
  const protocol = target.protocol === "postgres:" || target.protocol === "postgresql:";
  // Query parameters can override the connection target in postgres.js.
  if (!protocol || !loopback || target.pathname !== "/aiverse_test" || target.search || target.hash) {
    throw new Error("resetDb: refusing to truncate anything except a loopback aiverse_test database without URL options");
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const tables = await sql<{ t: string }[]>`select quote_ident(tablename) as t from pg_tables where schemaname = 'public'`;
    if (tables.length) await sql.unsafe(`truncate ${tables.map((r) => r.t).join(", ")} restart identity cascade`);
  } finally {
    await sql.end();
  }
}
