/**
 * Runtime factory (GATEWAY-INTEGRATION §b): builds the hunt app plus its
 * ticker control from an env map. Used by the standalone entry
 * (src/index.ts) and by the gateway embed — the gateway constructs the
 * runtime through this factory and injects its session verifier; the
 * hunt app never imports gateway code (design §d decoupling).
 */
import type { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { loadConfig, type HuntConfig } from "./config";
import { createDbSlot, openDb } from "./db";
import { LogMailer, ResendMailer, type Mailer } from "./mailer";
import { randomCodeKey } from "./custody";
import { buildApp, type VerifyGatewayToken } from "./app";
import { startTicker } from "./ticker";

export interface HuntRuntimeOptions {
  /** Host-injected gateway session verifier (design §d). */
  verifyGatewayToken?: VerifyGatewayToken;
  /** Embedded mounts run under the host's CORS layer (design §b.6). */
  cors?: boolean;
  /** Host-provided mailer; default mirrors the standalone entry. */
  mailer?: Mailer;
}

export interface HuntRuntime {
  app: ReturnType<typeof buildApp>;
  cfg: HuntConfig;
  db: Database;
  /** Start the 1 s ticker (event transitions, hints, pruning). */
  startTicker: () => void;
  stop: () => void;
}

export function createHuntRuntime(
  env: Record<string, string | undefined> = process.env,
  opts: HuntRuntimeOptions = {},
): HuntRuntime {
  // Embedded posture: when the hunt-specific vars are unset, magic links
  // point at the host's public base / console origin (the gateway env
  // carries PUBLIC_BASE_URL + CONSOLE_ORIGINS).
  const effectiveEnv = { ...env };
  if (!effectiveEnv.HUNT_PUBLIC_BASE && effectiveEnv.PUBLIC_BASE_URL) {
    effectiveEnv.HUNT_PUBLIC_BASE = effectiveEnv.PUBLIC_BASE_URL;
  }
  if (!effectiveEnv.HUNT_CONSOLE_URL && effectiveEnv.CONSOLE_ORIGINS) {
    const first = effectiveEnv.CONSOLE_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean)[0];
    if (first) effectiveEnv.HUNT_CONSOLE_URL = first;
  }
  const cfg = loadConfig(effectiveEnv);

  let codeKey = cfg.codeKey;
  if (!codeKey) {
    codeKey = randomCodeKey();
    console.warn(
      "[hunt] WARNING: HUNT_CODE_KEY unset — using an EPHEMERAL key. Seeded codes become unrecoverable on restart. Dev only.",
    );
  }
  if (!cfg.isProd && cfg.adminToken === "dev-admin-token") {
    console.warn("[hunt] WARNING: HUNT_ADMIN_TOKEN unset — using the dev default. Dev only.");
  }

  // The slot's proxy is the only handle anyone keeps: a backup/restore
  // swap points it at the restored connection and every consumer (app,
  // ticker, this runtime's `db`) follows at once.
  const slot = createDbSlot(openDb(cfg.dbPath));
  const db = slot.db;

  let mailer: Mailer;
  if (opts.mailer) {
    mailer = opts.mailer;
  } else if (cfg.emailMode === "resend" && cfg.resendApiKey) {
    mailer = new ResendMailer(cfg.resendApiKey, cfg.emailFrom ?? "hunt@aiverse.network");
    console.log("[hunt] email mode: resend");
  } else {
    const outbox = join(dirname(cfg.dbPath === ":memory:" ? "./hunt.db" : cfg.dbPath), "dev-outbox.jsonl");
    mailer = new LogMailer(outbox);
    console.log(`[hunt] email mode: STUB (magic links logged to ${outbox})`);
  }

  const app = buildApp({
    db,
    dbSlot: slot,
    cfg,
    mailer,
    codeKey,
    verifyGatewayToken: opts.verifyGatewayToken,
    cors: opts.cors,
  });

  let ticker: Timer | null = null;
  return {
    app,
    cfg,
    db,
    startTicker: () => {
      if (!ticker) ticker = startTicker(db, 1000);
    },
    stop: () => {
      if (ticker) clearInterval(ticker);
      ticker = null;
      slot.current().close();
    },
  };
}
