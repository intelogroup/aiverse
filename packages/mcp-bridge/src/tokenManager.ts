import type { BridgeConfig } from "./config";
import { GrantGoneError, refreshTokens, type AuthFlowResult, type FetchFn } from "./oauth";
import type { TokenStore } from "./tokenStore";

// Owns the access token's whole life: minted by the auth flow or by a
// refresh, cached in memory only, and refreshed again when it nears
// expiry or the gateway refuses it. The one hard rule lives here: a
// refresh ROTATES the refresh token, so the new one is written to the
// store before the access token is handed out — a crash between the two
// would otherwise strand the bridge with a burned token.
//
// A dead grant is sticky. Once a refresh answers invalid_grant, the
// manager remembers and every later call fails with the same
// GrantGoneError without touching the network — no retry loops against
// a grant the owner has already taken away.

const REFRESH_MARGIN_MS = 60 * 1000;

export class TokenManager {
  private access: { token: string; expiresAt: number } | null = null;
  private gone: GrantGoneError | null = null;
  private readonly fetchFn?: FetchFn;

  constructor(
    private readonly config: BridgeConfig,
    private readonly store: TokenStore,
    opts: { fetchFn?: FetchFn } = {},
  ) {
    this.fetchFn = opts.fetchFn;
  }

  /** A stored grant exists AND was minted by the configured gateway. */
  hasGrant(): boolean {
    const grant = this.store.load();
    return grant !== null && grant.baseUrl === this.config.baseUrl;
  }

  /** Take the auth flow's freshly minted access token into the cache. */
  adoptFlowResult(result: AuthFlowResult): void {
    this.access = { token: result.accessToken, expiresAt: result.accessExpiresAt };
    this.gone = null;
  }

  /** Forget the cached access token (the gateway just 401'd it): the next getAccessToken() refreshes. */
  invalidateAccess(): void {
    this.access = null;
  }

  async getAccessToken(): Promise<string> {
    if (this.gone) throw this.gone;
    if (this.access && this.access.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
      return this.access.token;
    }
    const grant = this.store.load();
    if (!grant || grant.baseUrl !== this.config.baseUrl) {
      throw new Error(
        `no stored grant for ${this.config.baseUrl} — run the bridge once in a terminal so it can open your browser and connect`,
      );
    }
    try {
      const tokens = await refreshTokens({
        baseUrl: this.config.baseUrl,
        clientId: grant.clientId,
        refreshToken: grant.refreshToken,
        fetchFn: this.fetchFn,
      });
      // Persist the rotated refresh token FIRST, then cache the access token.
      try {
        this.store.save({
          ...grant,
          refreshToken: tokens.refreshToken,
          scope: tokens.scope || grant.scope,
          updatedAt: new Date().toISOString(),
        });
      } catch (err) {
        // The presented token is already burned server-side and its
        // replacement is lost with this failed write: presenting the
        // stored token again would read as reuse and revoke the grant
        // outright. Fail stickily, exactly like a dead grant — the way
        // back is a fresh connect flow, never a quiet retry.
        this.gone = new GrantGoneError(
          `the rotated refresh token could not be saved (${err instanceof Error ? err.message : String(err)}), so the stored token is burned and must not be presented again`,
        );
        throw this.gone;
      }
      this.access = { token: tokens.accessToken, expiresAt: Date.now() + tokens.expiresIn * 1000 };
      return tokens.accessToken;
    } catch (err) {
      if (err instanceof GrantGoneError) this.gone = err;
      throw err;
    }
  }
}
