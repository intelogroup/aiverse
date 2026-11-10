/**
 * Hunt embed glue (apps/hunt/GATEWAY-INTEGRATION.md §b/§d).
 *
 * The hunt module ships inside this process as a mounted sub-app,
 * enabled only when AIVERSE_HUNT_MODE=1 — the bazaar idiom (routes/bazaar
 * in app.ts): mode unset = hunt routes absent entirely. The runtime is
 * built lazily through hunt's own factory with two host injections:
 *
 *   - verifyGatewayToken: a closure over this service's session verifier
 *     (auth/session.ts). The gateway JWT (sub = owners.id) is the hunt's
 *     primary identity path; hunt resolves/adopts its user row by
 *     gateway_owner_id. Hunt code never imports gateway code.
 *   - the mailer, chosen by HUNT_EMAIL_MODE: `resend` builds hunt's
 *     ResendMailer — FROM is HUNT_EMAIL_FROM, defaulting to this
 *     service's already-verified sender identity
 *     `AIVerse <noreply@damhall.com>` (Jim's pick, 2026-11-10: "whoever
 *     works fine"); the API key is HUNT_RESEND_API_KEY, falling back to
 *     this service's RESEND_API_KEY. Any other mode keeps the file
 *     mailer: the stub/outbox posture (SPEC §11.5), writing magic links
 *     and prize codes beside the hunt DB instead of sending real mail
 *     or logging live tokens. The stub stays the default.
 *
 * Fail-closed mount, fail-open host: if the runtime cannot be built
 * (e.g. mode flipped on before the HUNT_* secrets exist), the error is
 * logged and the gateway serves without the hunt — the live service's
 * health outranks the hunt (rollback = unset the mode + redeploy).
 */
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { owners } from "@aiverse/shared/schema";
import { createHuntRuntime, type HuntRuntime } from "@aiverse/hunt/runtime";
import { ResendMailer, type Mailer } from "@aiverse/hunt/mailer";
import { verifyOwnerSession } from "./auth/session";
import { db } from "./db/client";
import { log, logError } from "./util/log";

export function huntEnabled(): boolean {
  return process.env.AIVERSE_HUNT_MODE === "1";
}

let runtime: HuntRuntime | null = null;
let runtimeFailed = false;

export function getHuntRuntime(): HuntRuntime | null {
  if (runtime || runtimeFailed) return runtime;
  try {
    const outboxPath = join(
      dirname(process.env.HUNT_DB_PATH ?? "/data/hunt.db"),
      "dev-outbox.jsonl",
    );
    // HUNT_EMAIL_MODE=resend → real mail through the verified damhall
    // identity; without a key the stub stays (in production loadConfig
    // refuses resend-without-key before this matters). Otherwise the
    // file stub — byte-identical posture to before for magic links,
    // with prize codes appended in the same observable shape.
    const resendApiKey = process.env.HUNT_RESEND_API_KEY ?? process.env.RESEND_API_KEY;
    const mailer: Mailer =
      process.env.HUNT_EMAIL_MODE === "resend" && resendApiKey
        ? new ResendMailer(
            resendApiKey,
            process.env.HUNT_EMAIL_FROM ?? "AIVerse <noreply@damhall.com>",
          )
        : {
            async sendMagicLink(email: string, link: string): Promise<void> {
              appendFileSync(outboxPath, JSON.stringify({ email, link, at: Date.now() }) + "\n");
            },
            async sendClaimCode(
              email: string,
              prize: { code: string; label: string; kind: string },
            ): Promise<void> {
              appendFileSync(
                outboxPath,
                JSON.stringify({
                  email,
                  code: prize.code,
                  label: prize.label,
                  kind: prize.kind,
                  at: Date.now(),
                }) + "\n",
              );
            },
          };
    runtime = createHuntRuntime(process.env, {
      cors: false,
      mailer,
      verifyGatewayToken: async (token: string) => {
        let ownerId: string;
        try {
          ownerId = await verifyOwnerSession(token);
        } catch {
          return null;
        }
        const owner = await db.query.owners.findFirst({
          where: eq(owners.id, ownerId),
          columns: { email: true, displayName: true },
        });
        if (!owner) return null;
        return { ownerId, email: owner.email, displayName: owner.displayName ?? "" };
      },
    });
    log("hunt_runtime_ready", { dbPath: runtime.cfg.dbPath, emailMode: runtime.cfg.emailMode });
  } catch (err) {
    runtimeFailed = true;
    logError("hunt_runtime_failed", err);
  }
  return runtime;
}

/**
 * Leader-only singleton job (called from index.ts's leader section, like
 * the bazaar expiry sweep): start the hunt ticker — event transitions,
 * hint ladder, pruning. Two processes must never tick the same hunt.
 */
export function scheduleHuntTicker(): void {
  const rt = getHuntRuntime();
  if (!rt) return;
  rt.startTicker();
  log("hunt_ticker_started", {});
}

/** Test hygiene only: drop the cached runtime so a suite can re-create
 *  it under a different env (mode/DB path) and other files see mode off. */
export function resetHuntRuntimeForTests(): void {
  try {
    runtime?.stop();
  } catch {
    // already closed — nothing to clean
  }
  runtime = null;
  runtimeFailed = false;
}
