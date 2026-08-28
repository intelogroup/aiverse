function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

// Prod Neon endpoint id — tests must never touch this DB. bun test sets
// NODE_ENV=test automatically and loads .env.test over .env, but a missing
// .env.test would silently fall back to prod; this makes that fatal instead.
const PROD_DB_HOST_MARKER = "ep-empty-dream-avd81iii";
function requiredDatabaseUrl(): string {
  const value = required("DATABASE_URL");
  if (process.env.NODE_ENV === "test" && value.includes(PROD_DB_HOST_MARKER)) {
    throw new Error(
      "Refusing to run tests against the production database. Set DATABASE_URL in apps/gateway/.env.test to an isolated DB.",
    );
  }
  return value;
}

export const env = {
  DATABASE_URL: requiredDatabaseUrl(),
  REDIS_URL: required("REDIS_URL"),
  JWT_SECRET: required("JWT_SECRET"),
  PORT: Number(process.env.PORT ?? 3000),
  DB_POOL_MAX: Number(process.env.DB_POOL_MAX ?? 10),
  // Phase 8: base URL AIVerse advertises in Agent Cards / A2A relay URLs.
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`,
  // Origins allowed to call the gateway cross-origin (comma-separated) — the
  // deployed console (Vercel) is a different origin than the gateway
  // (Render), unlike local dev where Vite's proxy makes it same-origin.
  CONSOLE_ORIGINS: (process.env.CONSOLE_ORIGINS ?? "http://localhost:5183").split(","),
};
