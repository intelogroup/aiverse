/**
 * Hunt service config — env validation (SPEC slice 1).
 * Only HUNT_* variables are read; nothing is inherited from the gateway's
 * environment. Secrets never get defaults in production.
 */
export interface HuntConfig {
  dbPath: string;
  port: number;
  adminToken: string;
  /** 32-byte AES key, or null in dev (ephemeral key generated, loud warning). */
  codeKey: Buffer | null;
  emailMode: "log" | "resend";
  resendApiKey: string | null;
  emailFrom: string | null;
  /** Public base URL of THIS service, used inside magic links. */
  publicBase: string;
  /** Console origin the consume endpoint redirects to (token in fragment). */
  consoleUrl: string;
  corsOrigins: string[];
  isProd: boolean;
}

export const GLOBAL_SPEED_CEILING_MPS = 8;
/** Hunt v0 delta 2: measured arrival scatter 0.43–0.76 m → default radius 1.5 m. */
export const DEFAULT_CLAIM_RADIUS_M = 1.5;
export const SPEED_TOLERANCE = 1.25;

export function loadConfig(env: Record<string, string | undefined> = process.env): HuntConfig {
  const isProd = env.NODE_ENV === "production";
  const port = Number(env.HUNT_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`HUNT_PORT invalid: ${env.HUNT_PORT}`);
  }

  let codeKey: Buffer | null = null;
  if (env.HUNT_CODE_KEY) {
    codeKey = Buffer.from(env.HUNT_CODE_KEY, "base64");
    if (codeKey.length !== 32) {
      throw new Error("HUNT_CODE_KEY must be base64 of exactly 32 bytes");
    }
  } else if (isProd) {
    throw new Error("HUNT_CODE_KEY is required in production");
  }

  const adminToken = env.HUNT_ADMIN_TOKEN ?? "";
  if (isProd && adminToken.length < 16) {
    throw new Error("HUNT_ADMIN_TOKEN is required in production (≥16 chars)");
  }
  if (!adminToken) {
    // Dev-only default so local runs work out of the box; never used in prod.
    return finish(env, { port, codeKey, adminToken: "dev-admin-token", isProd });
  }
  return finish(env, { port, codeKey, adminToken, isProd });
}

function finish(
  env: Record<string, string | undefined>,
  core: { port: number; codeKey: Buffer | null; adminToken: string; isProd: boolean },
): HuntConfig {
  const emailMode = (env.HUNT_EMAIL_MODE ?? "log") as "log" | "resend";
  if (emailMode !== "log" && emailMode !== "resend") {
    throw new Error(`HUNT_EMAIL_MODE invalid: ${env.HUNT_EMAIL_MODE}`);
  }
  if (emailMode === "resend" && core.isProd && !env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY required when HUNT_EMAIL_MODE=resend in production");
  }
  const origins = (env.HUNT_CORS_ORIGINS ??
    "https://aiverse.network,https://www.aiverse.network,http://localhost:5173,http://localhost:4173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    dbPath: env.HUNT_DB_PATH ?? "./data/hunt.db",
    port: core.port,
    adminToken: core.adminToken,
    codeKey: core.codeKey,
    emailMode,
    resendApiKey: env.RESEND_API_KEY ?? null,
    emailFrom: env.HUNT_EMAIL_FROM ?? "hunt@aiverse.network",
    publicBase: env.HUNT_PUBLIC_BASE ?? `http://localhost:${core.port}`,
    consoleUrl: env.HUNT_CONSOLE_URL ?? "http://localhost:5173",
    corsOrigins: origins,
    isProd: core.isProd,
  };
}
