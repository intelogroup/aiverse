function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
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
