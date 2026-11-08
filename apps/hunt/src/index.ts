/**
 * Hunt service bootstrap: config → db → mailer → HTTP + ticker.
 * One process, one SQLite file (SPEC §2 shape).
 */
import { loadConfig } from "./config";
import { openDb } from "./db";
import { LogMailer, ResendMailer, type Mailer } from "./mailer";
import { randomCodeKey } from "./custody";
import { buildApp } from "./app";
import { startTicker } from "./ticker";
import { dirname, join } from "node:path";

const cfg = loadConfig();

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

const db = openDb(cfg.dbPath);

let mailer: Mailer;
if (cfg.emailMode === "resend" && cfg.resendApiKey) {
  mailer = new ResendMailer(cfg.resendApiKey, cfg.emailFrom ?? "hunt@aiverse.network");
  console.log("[hunt] email mode: resend");
} else {
  const outbox = join(dirname(cfg.dbPath === ":memory:" ? "./hunt.db" : cfg.dbPath), "dev-outbox.jsonl");
  mailer = new LogMailer(outbox);
  console.log(`[hunt] email mode: STUB (magic links logged to ${outbox})`);
}

const app = buildApp({ db, cfg, mailer, codeKey });

const ticker = startTicker(db, 1000);

// idleTimeout maxed: SSE feeds are long-lived by design (SPEC §8.3).
const server = Bun.serve({ port: cfg.port, fetch: app.fetch, idleTimeout: 255 });
console.log(`[hunt] listening on http://localhost:${server.port} (db: ${cfg.dbPath})`);

process.on("SIGINT", () => {
  clearInterval(ticker);
  server.stop();
  db.close();
  process.exit(0);
});
