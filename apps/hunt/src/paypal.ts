/**
 * PayPal REST client — Payouts + webhook verification (money amendment §3).
 *
 * Deliberately thin: OAuth2 client-credentials, POST/GET
 * /v1/payments/payouts, POST /v1/notifications/verify-webhook-signature.
 * All money semantics (idempotency, status mapping, storage) live in
 * payouts.ts; this file only speaks HTTP.
 *
 * Credential hygiene: the client secret and access tokens exist only in
 * this module's memory. Tokens are minted per operation, cached until
 * shortly before expiry, never persisted, never logged. Errors are built
 * exclusively from PayPal's RESPONSE fields — request headers/bodies are
 * never interpolated into an error, so a thrown error can never carry the
 * Basic-auth secret or a bearer token.
 */
import type { PaypalConfig } from "./config";

export interface PaypalHttpResponse {
  status: number;
  json: any;
}

/** Injectable transport — tests substitute a fake; no test touches the network. */
export type PaypalFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<PaypalHttpResponse>;

export class PaypalError extends Error {
  status: number;
  paypalName: string | null;
  /** The response's `details` array, when PayPal sent one (response data only). */
  details: any[] | null;
  constructor(status: number, paypalName: string | null, message: string, details: any[] | null = null) {
    super(message);
    this.name = "PaypalError";
    this.status = status;
    this.paypalName = paypalName;
    this.details = details;
  }
}

/**
 * Recognize PayPal's duplicate-batch refusal and recover the original
 * batch id from it. Observed live (sandbox suite E1, 2026-11-08): a
 * resubmit with an already-used sender_batch_id gets HTTP 400
 * USER_BUSINESS_ERROR with details[0].field = "SENDER_BATCH_ID" and a
 * `link` to the original batch — an idempotency refusal, NOT the
 * original response replayed. Returns null for any other error.
 */
export function duplicateBatchId(err: unknown): string | null {
  if (!(err instanceof PaypalError)) return null;
  if (err.status !== 400 || err.paypalName !== "USER_BUSINESS_ERROR") return null;
  for (const d of err.details ?? []) {
    if (d?.field !== "SENDER_BATCH_ID") continue;
    const links = Array.isArray(d.link) ? d.link : [];
    for (const l of links) {
      const href = typeof l?.href === "string" ? l.href : "";
      const m = href.match(/\/v1\/payments\/payouts\/([^/?#]+)/);
      if (m) return decodeURIComponent(m[1]);
    }
  }
  return null;
}

const defaultFetch: PaypalFetch = async (url, init) => {
  const res = await fetch(url, init);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json };
};

/** Refresh this long before the stated expiry — a payout must never ride a dying token. */
const TOKEN_REFRESH_SKEW_MS = 60_000;

export class PaypalClient {
  private cfg: PaypalConfig;
  private fetchFn: PaypalFetch;
  private cached: { token: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(cfg: PaypalConfig, fetchFn: PaypalFetch = defaultFetch) {
    this.cfg = cfg;
    this.fetchFn = fetchFn;
  }

  get apiBase(): string {
    return this.cfg.apiBase;
  }

  /**
   * OAuth2 client-credentials token, cached in memory until shortly
   * before expiry. Concurrent callers share one in-flight exchange.
   * `now` is injectable so cache behaviour is testable without sleeping.
   */
  async accessToken(now: number = Date.now()): Promise<string> {
    if (this.cached && now < this.cached.expiresAt - TOKEN_REFRESH_SKEW_MS) {
      return this.cached.token;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.exchange(now).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async exchange(now: number): Promise<string> {
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    const res = await this.fetchFn(`${this.cfg.apiBase}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });
    if (res.status !== 200 || typeof res.json?.access_token !== "string") {
      throw errorFromResponse(res, "token exchange failed");
    }
    const expiresInMs = Number(res.json.expires_in ?? 0) * 1000;
    this.cached = { token: res.json.access_token, expiresAt: now + expiresInMs };
    return res.json.access_token;
  }

  /** POST /v1/payments/payouts — body is built by payouts.ts (idempotency lives there). */
  async createPayoutBatch(body: unknown): Promise<any> {
    return this.authed("POST", "/v1/payments/payouts", body);
  }

  async getPayoutBatch(batchId: string): Promise<any> {
    return this.authed("GET", `/v1/payments/payouts/${encodeURIComponent(batchId)}`);
  }

  async getPayoutItem(itemId: string): Promise<any> {
    // The route is payouts-item (singular, hyphenated) — verified live
    // in the sandbox suite (E2). The plausible /payouts/items/{id} is
    // not a route at all: it 404s with an empty body.
    return this.authed("GET", `/v1/payments/payouts-item/${encodeURIComponent(itemId)}`);
  }

  /**
   * POST /v1/payments/payouts-item/{id}/cancel — cancels an UNCLAIMED
   * item so the held funds return to the sender before the 30-day
   * auto-return. Sandbox behavior observed in suite E3: the route
   * exists but answered 500 INTERNAL_SERVICE_ERROR — callers must
   * treat a throw as "the cancel did not happen", never as success.
   */
  async cancelPayoutItem(itemId: string): Promise<any> {
    return this.authed("POST", `/v1/payments/payouts-item/${encodeURIComponent(itemId)}/cancel`);
  }

  /**
   * Webhook signature verification via PayPal's verify endpoint (the
   * call shape PayPal prescribes): the transmission headers plus the
   * untouched parsed event. Returns true only on verification SUCCESS.
   */
  async verifyWebhookSignature(args: {
    authAlgo: string | null;
    certUrl: string | null;
    transmissionId: string | null;
    transmissionSig: string | null;
    transmissionTime: string | null;
    webhookId: string;
    webhookEvent: unknown;
  }): Promise<boolean> {
    const res = await this.authed("POST", "/v1/notifications/verify-webhook-signature", {
      auth_algo: args.authAlgo,
      cert_url: args.certUrl,
      transmission_id: args.transmissionId,
      transmission_sig: args.transmissionSig,
      transmission_time: args.transmissionTime,
      webhook_id: args.webhookId,
      webhook_event: args.webhookEvent,
    }).catch(() => null);
    return res?.verification_status === "SUCCESS";
  }

  private async authed(method: string, path: string, body?: unknown): Promise<any> {
    const token = await this.accessToken();
    const res = await this.fetchFn(`${this.cfg.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status < 200 || res.status >= 300) {
      throw errorFromResponse(res, `${method} ${path} failed`);
    }
    return res.json;
  }
}

function errorFromResponse(res: PaypalHttpResponse, fallback: string): PaypalError {
  const name = typeof res.json?.name === "string" ? res.json.name : null;
  const message =
    typeof res.json?.message === "string" ? res.json.message : fallback;
  const details = Array.isArray(res.json?.details) ? res.json.details : null;
  return new PaypalError(
    res.status,
    name,
    `${fallback}: HTTP ${res.status}${name ? ` ${name}` : ""} — ${message}`,
    details,
  );
}
