/**
 * Gateway telemetry — Sentry capture, env-gated and additive.
 *
 * With SENTRY_DSN unset (production until Jim sets it on Render), init
 * returns false and captureGatewayError is a no-op: the gateway behaves
 * exactly as before, including boot. With a DSN set, route errors and
 * process-level failures are captured with the release pinned to the
 * live commit (RENDER_GIT_COMMIT — the same SHA /version reports), a
 * stable error fingerprint, and the request id for log correlation.
 *
 * The structured stdout logs (util/log) remain the always-on baseline;
 * this module only adds the "back home" copy.
 */

import * as Sentry from "@sentry/bun";

let enabled = false;
let initAttempted = false;

/** The commit this process is running — Render injects it; the same
 *  value /version serves, so an issue and a log line name one build. */
export function gatewayRelease(): string {
  return process.env.RENDER_GIT_COMMIT ?? process.env.GIT_SHA ?? "unknown";
}

/**
 * Stable error fingerprint: FNV-1a over name | normalized message.
 * The same defect — same error class, same message shape — fingerprints
 * identically across processes, call sites, and deploys, so the value
 * can ride the structured log line next to the Sentry event and an
 * operator can grep one failure's every occurrence. Variable payload
 * in the message (uuids, ids, numbers) is normalized out first.
 * (Stack frames are NOT part of the material: Bun/JSC stacks attribute
 * an error to varying caller frames, which made site-based hashing
 * unstable across identical defects — verified in this module's tests.
 * Sentry does its own stack-based grouping server-side regardless.)
 */
export function fingerprintError(err: unknown): string {
  const e = err instanceof Error ? err : new Error(String(err));
  const message = e.message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "#")
    .replace(/\b[0-9a-f]{16,}\b/gi, "#")
    .replace(/\d+/g, "#");
  const material = `${e.name}|${message}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i++) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fp_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function initGatewaySentry(): boolean {
  if (initAttempted) return enabled;
  initAttempted = true;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;
  try {
    Sentry.init({
      dsn,
      release: gatewayRelease(),
      environment: process.env.NODE_ENV ?? "unknown",
      // Errors only in Phase 1 — no tracing, no profiling. (SDK v11
      // collects no default PII; the old sendDefaultPii flag is gone.)
      tracesSampleRate: 0,
    });
    enabled = true;
  } catch {
    // Telemetry must never block boot.
    enabled = false;
  }
  return enabled;
}

export function gatewaySentryEnabled(): boolean {
  return enabled;
}

export interface GatewayErrorContext {
  requestId?: string;
  route?: string;
  method?: string;
}

export function captureGatewayError(err: unknown, ctx: GatewayErrorContext = {}): boolean {
  if (!enabled) return false;
  try {
    Sentry.withScope((scope) => {
      scope.setTag("git_sha", gatewayRelease());
      if (ctx.requestId) scope.setTag("request_id", ctx.requestId);
      if (ctx.route) scope.setTag("route", ctx.route);
      if (ctx.method) scope.setTag("method", ctx.method);
      scope.setFingerprint(["aiverse-gateway", fingerprintError(err)]);
      Sentry.captureException(err);
    });
    return true;
  } catch {
    return false;
  }
}
