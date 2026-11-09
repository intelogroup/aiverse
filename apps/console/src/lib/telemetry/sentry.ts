/**
 * Console Sentry glue — deliberately thin and fully env-gated.
 *
 * With VITE_SENTRY_DSN unset (the default, and production until Jim sets
 * it in Vercel), this module never even loads the SDK: init returns false
 * and every capture call is a no-op, so runtime behavior is unchanged.
 * With a DSN set, errors are captured with the release pinned to the
 * console build SHA and the black-box tail attached, so an issue arrives
 * with its own world-state recording.
 */

import { blackbox, lastErrorKind } from "./blackbox";
import { currentDistrict } from "./context";

type SentryModule = typeof import("@sentry/react");

let sentry: SentryModule | null = null;
let enabled = false;

export function sentryDsn(): string | undefined {
  const env = import.meta.env as Record<string, string | undefined>;
  return env.VITE_SENTRY_DSN || undefined;
}

export async function initConsoleSentry(buildSha: string): Promise<boolean> {
  const dsn = sentryDsn();
  if (!dsn || enabled) return enabled;
  try {
    const S = await import("@sentry/react");
    S.init({
      dsn,
      release: buildSha,
      environment: (import.meta.env as Record<string, string | undefined>).VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
      // Errors only in Phase 1 — no performance tracing, no session
      // replay, nothing that samples user behavior by default. (SDK v11
      // collects no default PII; the old sendDefaultPii flag is gone.)
      tracesSampleRate: 0,
      // Single enrichment point. The SDK's own global handlers capture
      // window errors/rejections; our listeners (index.ts) only record
      // them in the black box and note the kind. Every error event —
      // however captured — passes through beforeSend, so enrichment
      // lives here and cannot race a second capture of the same error
      // (the Phase 1 proof watched a scope-enriched duplicate lose to
      // the SDK's bare capture; this design has exactly one of each).
      beforeSend(event, hint) {
        if (event.exception) {
          const kind = lastErrorKind();
          event.tags = { ...event.tags, district: currentDistrict(), telemetry_kind: kind };
          event.extra = { ...event.extra, blackbox_tail: JSON.stringify(blackbox.tail(50)) };
          if (!event.fingerprint) {
            const original = hint?.originalException;
            event.fingerprint = ["aiverse-console", kind, original instanceof Error ? original.name : "unknown"];
          }
          // Best effort: the full black-box slice rides as an
          // attachment (the tail extra above is the guaranteed copy).
          if (hint) {
            hint.attachments = [
              ...(hint.attachments ?? []),
              {
                filename: "blackbox.jsonl",
                data: blackbox.toJSONL(blackbox.tail(300)),
                contentType: "application/x-ndjson",
              },
            ];
          }
        }
        return event;
      },
    });
    S.setTag("build_sha", buildSha);
    sentry = S;
    enabled = true;
    return true;
  } catch {
    // A telemetry failure must never take the app down with it.
    return false;
  }
}

export function sentryEnabled(): boolean {
  return enabled;
}

function withBlackboxScope(S: SentryModule, err: unknown, kind: string): void {
  S.withScope((scope) => {
    scope.setTag("district", currentDistrict());
    scope.setTag("telemetry_kind", kind);
    scope.setExtra("blackbox_tail", JSON.stringify(blackbox.tail(30)));
    scope.addAttachment({
      filename: "blackbox.jsonl",
      data: blackbox.toJSONL(blackbox.tail(300)),
      contentType: "application/x-ndjson",
    });
    scope.setFingerprint(["aiverse-console", kind, err instanceof Error ? err.name : "unknown"]);
    S.captureException(err);
  });
}

export function captureConsoleError(err: unknown, kind = "error"): void {
  if (!enabled || !sentry) return;
  try {
    withBlackboxScope(sentry, err, kind);
  } catch {
    /* telemetry never throws into the app */
  }
}

export function captureConsoleMessage(message: string, kind: string, extra?: Record<string, unknown>): void {
  if (!enabled || !sentry) return;
  try {
    const S = sentry;
    S.withScope((scope) => {
      scope.setTag("district", currentDistrict());
      scope.setTag("telemetry_kind", kind);
      scope.setLevel("error");
      if (extra) scope.setExtra("detail", JSON.stringify(extra));
      scope.setExtra("blackbox_tail", JSON.stringify(blackbox.tail(30)));
      scope.setFingerprint(["aiverse-console", kind, message.slice(0, 80)]);
      S.captureMessage(message);
    });
  } catch {
    /* telemetry never throws into the app */
  }
}
