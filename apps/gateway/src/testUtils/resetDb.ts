// Test preload (apps/gateway/bunfig.toml): empty every table once per `bun test` run, so a local run starts from the
// same state as CI's fresh Postgres container. Without it, fixed test names left by earlier runs ("DefaultModeAgent")
// make /owners/agents return 409 and ~150 tests fail locally while CI is green. No migration seeds rows, so a
// truncate leaves exactly what `db:migrate` gives CI. Refuses any database not named aiverse_test.
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (url) {
  const name = new URL(url).pathname.slice(1);
  if (name !== "aiverse_test") throw new Error(`resetDb: refusing to truncate database "${name}" (only aiverse_test)`);
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const tables = await sql<{ t: string }[]>`select quote_ident(tablename) as t from pg_tables where schemaname = 'public'`;
  if (tables.length) await sql.unsafe(`truncate ${tables.map((r) => r.t).join(", ")} restart identity cascade`);
  await sql.end();
}
