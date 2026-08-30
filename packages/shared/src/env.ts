function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

// The ONLY database tests are allowed to touch: the isolated test DB wired in
// apps/gateway/.env.test. Fail-closed allow-list, not a deny-list: a leaked or
// overridden DATABASE_URL (e.g. an exported env var that shadows the .env.test
// file) must be refused even if it points at a DIFFERENT prod/shared endpoint
// than the one we already know about. bun test sets NODE_ENV=test and loads
// .env.test over .env, but a pre-set process env var overrides both — so under
// test we only trust an explicit test host.
const TEST_ALLOWED_DB_HOSTS = ["ep-withered-bird-avcl85fh"];
function requiredDatabaseUrl(): string {
  const value = required("DATABASE_URL");
  if (
    process.env.NODE_ENV === "test" &&
    !TEST_ALLOWED_DB_HOSTS.some((host) => value.includes(host))
  ) {
    throw new Error(
      `Refusing to run tests against an unapproved database (${hostOf(value)}). ` +
        "Only the isolated test DB is allowed. Set DATABASE_URL in apps/gateway/.env.test " +
        "and make sure no DATABASE_URL is exported in the shell while running tests.",
    );
  }
  return value;
}
function hostOf(url: string): string {
  return (url.match(/@([^/]+)/) ?? [])[1] ?? url.slice(0, 40);
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
  // Native-agent LLM calls. Optional — a missing key just means native agents
  // stay silent (tick logs and skips) instead of crashing boot.
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  // OpenAI direct API (used for native/agent LLM calls when available)
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_REAL_API_KEY: process.env.OPENAI_REAL_API_KEY,
  BUDDY_OPENAI_API_KEY: process.env.BUDDY_OPENAI_API_KEY,
  // auto (default): OpenRouter if key present, else mock. mock: force mock even
  // with a key set (behavioral testing without burning tokens). openrouter:
  // force real calls, fail loud if key missing.
  NATIVE_LLM_MODE: (process.env.NATIVE_LLM_MODE ?? "auto") as "auto" | "mock" | "openrouter",
};
