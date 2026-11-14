import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { BridgeLog } from "./log";
import type { TokenStore } from "./tokenStore";

// The bridge's half of the OAuth 2.1 flow (RFC 6749 + RFC 7591 + RFC
// 7636 + RFC 8252): the desktop client that launches this process may
// only speak stdio, so the bridge does the browser dance itself —
// dynamic client registration, PKCE S256, a loopback redirect listener —
// and ends up holding what any OAuth client holds: a 1 h access token
// (memory only) and a rotating refresh token (the token store's file).
// The owner's credentials and the agent's Ed25519 key never come near
// this process.

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const defaultFetch: FetchFn = (url, init) => fetch(url, init);

/** The one message a dead grant produces, everywhere it surfaces. */
export const GRANT_GONE_MESSAGE =
  "grant gone — the owner revoked this bridge's access, or the grant expired. " +
  "Re-run the bridge to reconnect: it will open your browser for a fresh consent.";

/** The grant is dead (revoked, expired, or its refresh token was rejected). No retry will fix it. */
export class GrantGoneError extends Error {
  constructor(detail?: string) {
    super(detail ? `${GRANT_GONE_MESSAGE} (${detail})` : GRANT_GONE_MESSAGE);
    this.name = "GrantGoneError";
  }
}

/** Any other OAuth protocol error, carried verbatim from the server's error JSON. */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status: number,
  ) {
    super(`OAuth ${error}: ${description}`);
    this.name = "OAuthError";
  }
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}

// ---------------------------------------------------------------------------
// PKCE (S256 only — the gateway accepts nothing else).

function computeS256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

function newVerifier(): string {
  // 32 random bytes, base64url: 43 chars from the RFC 7636 unreserved set.
  return randomBytes(32).toString("base64url");
}

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591). Public client: the response
// carries a client_id and no secret — PKCE is the credential.

export async function registerClient(
  baseUrl: string,
  redirectUri: string,
  fetchFn: FetchFn = defaultFetch,
): Promise<string> {
  const res = await fetchFn(`${baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "AIVerse MCP Bridge", redirect_uris: [redirectUri] }),
  });
  const body = (await res.json().catch(() => null)) as { client_id?: string } | null;
  if (res.status !== 201 || !body?.client_id) {
    throw new Error(`client registration failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body.client_id;
}

// ---------------------------------------------------------------------------
// Loopback redirect listener (RFC 8252 §7.3): bound to 127.0.0.1 on an
// ephemeral port, alive only for the duration of one authorize round
// trip. The browser lands here exactly once, with ?code&state — or with
// ?error when the owner (or the server) said no.

export interface Loopback {
  redirectUri: string;
  /** Resolve with the authorization code; reject on error, state mismatch, or timeout. */
  waitForCallback: (expectedState: string, timeoutMs?: number) => Promise<{ code: string }>;
  close: () => void;
}

const CALLBACK_PAGE = (title: string, note: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui,sans-serif;margin:4rem auto;max-width:32rem">` +
  `<h1>${title}</h1><p>${note}</p></body>`;

export function startLoopback(): Promise<Loopback> {
  let settle: ((url: URL) => void) | null = null;
  const arrived = new Promise<URL>((resolve) => {
    settle = resolve;
  });
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const failed = url.searchParams.get("error");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      failed
        ? CALLBACK_PAGE("AIVerse connection failed", `The authorization server answered: ${failed}. You can close this tab.`)
        : CALLBACK_PAGE("AIVerse connected", "Your agent client is connected to the Verse. You can close this tab."),
    );
    settle?.(url);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("loopback listener has no port"));
        return;
      }
      resolve({
        redirectUri: `http://127.0.0.1:${address.port}/callback`,
        waitForCallback: async (expectedState, timeoutMs = 5 * 60 * 1000) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<never>((_, rejectTimeout) => {
            timer = setTimeout(
              () => rejectTimeout(new Error("timed out waiting for the browser sign-in to finish")),
              timeoutMs,
            );
            timer.unref?.();
          });
          try {
            const url = await Promise.race([arrived, timeout]);
            const error = url.searchParams.get("error");
            if (error) {
              throw new Error(
                `authorization failed: ${error} — ${url.searchParams.get("error_description") ?? "no description"}`,
              );
            }
            if (url.searchParams.get("state") !== expectedState) {
              throw new Error("authorization callback state mismatch — refusing to continue");
            }
            const code = url.searchParams.get("code");
            if (!code) throw new Error("authorization callback carried no code");
            return { code };
          } finally {
            if (timer) clearTimeout(timer);
          }
        },
        close: () => server.close(),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// The token endpoint: one form-encoded POST shape for both grants.

async function tokenRequest(
  baseUrl: string,
  params: Record<string, string>,
  fetchFn: FetchFn,
): Promise<TokenResponse> {
  const res = await fetchFn(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = (await res.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  } | null;
  if (!res.ok || !body?.access_token || !body.refresh_token) {
    throw new OAuthError(
      body?.error ?? "server_error",
      body?.error_description ?? `token endpoint answered ${res.status}`,
      res.status,
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: body.expires_in ?? 3600,
    scope: body.scope ?? "",
  };
}

/**
 * Rotate the refresh token. The gateway burns the presented token and
 * issues its replacement in the response — the CALLER must persist the
 * returned refreshToken before anything else. An invalid_grant here
 * means the grant itself is gone (revoked, expired, or reuse-detected):
 * it is surfaced as GrantGoneError, never retried.
 */
export async function refreshTokens(args: {
  baseUrl: string;
  clientId: string;
  refreshToken: string;
  fetchFn?: FetchFn;
}): Promise<TokenResponse> {
  try {
    return await tokenRequest(
      args.baseUrl,
      { grant_type: "refresh_token", refresh_token: args.refreshToken, client_id: args.clientId },
      args.fetchFn ?? defaultFetch,
    );
  } catch (err) {
    if (err instanceof OAuthError && err.error === "invalid_grant") {
      throw new GrantGoneError(err.description);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The full first-run flow: register → authorize in the owner's browser →
// loopback code → exchange. On success the refresh token is already in
// the store when this resolves, and the access token is handed to the
// caller for its in-memory cache.

export interface AuthFlowResult {
  clientId: string;
  accessToken: string;
  accessExpiresAt: number;
  scope: string;
}

export async function performAuthFlow(args: {
  baseUrl: string;
  scopes: string[];
  store: TokenStore;
  /** Called with the authorize URL: open it in the owner's browser (and/or print it to stderr). */
  openUrl: (url: string) => void | Promise<void>;
  log?: (message: string) => void;
  /** Structured lifecycle events (auth_flow_started / auth_flow_completed). */
  events?: BridgeLog;
  fetchFn?: FetchFn;
  callbackTimeoutMs?: number;
}): Promise<AuthFlowResult> {
  const fetchFn = args.fetchFn ?? defaultFetch;
  args.events?.("auth_flow_started", { baseUrl: args.baseUrl, scopes: args.scopes });
  const loopback = await startLoopback();
  try {
    const clientId = await registerClient(args.baseUrl, loopback.redirectUri, fetchFn);
    const verifier = newVerifier();
    const state = randomBytes(16).toString("base64url");
    const authorizeUrl = new URL(`${args.baseUrl}/oauth/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", loopback.redirectUri);
    authorizeUrl.searchParams.set("scope", args.scopes.join(" "));
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", computeS256Challenge(verifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    args.log?.("aiverse-bridge: opening your browser for the AIVerse sign-in and consent…");
    await args.openUrl(authorizeUrl.toString());
    const { code } = await loopback.waitForCallback(state, args.callbackTimeoutMs);
    const tokens = await tokenRequest(
      args.baseUrl,
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: loopback.redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      },
      fetchFn,
    );
    args.store.save({
      version: 1,
      baseUrl: args.baseUrl,
      clientId,
      refreshToken: tokens.refreshToken,
      scope: tokens.scope,
      updatedAt: new Date().toISOString(),
    });
    args.events?.("auth_flow_completed", {
      baseUrl: args.baseUrl,
      scopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : args.scopes,
    });
    return {
      clientId,
      accessToken: tokens.accessToken,
      accessExpiresAt: Date.now() + tokens.expiresIn * 1000,
      scope: tokens.scope,
    };
  } finally {
    loopback.close();
  }
}
