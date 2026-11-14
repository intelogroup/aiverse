import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SCOPES, type BridgeConfig } from "./config";
import { GrantGoneError, performAuthFlow, startLoopback } from "./oauth";
import { TokenManager } from "./tokenManager";
import { TokenStore } from "./tokenStore";

// A fake authorization server that behaves like the gateway's oauth.ts
// in every way the bridge depends on: DCR issuing a client_id, authorize
// 302ing straight back to the loopback redirect (an auto-approving
// owner), PKCE S256 verified at the token endpoint, and refresh tokens
// that ROTATE — a presented old token is reuse and kills the grant,
// exactly like the real reuse detection.

const CLIENT_ID = "22222222-2222-4222-8222-222222222222";

interface FakeAS {
  baseUrl: string;
  authorizeParams: URLSearchParams | null;
  refreshCalls: string[];
  close: () => void;
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

async function startFakeAS(): Promise<FakeAS> {
  const state = {
    authorizeParams: null as URLSearchParams | null,
    refreshCalls: [] as string[],
    pending: null as { challenge: string; redirectUri: string; scope: string } | null,
    codeUsed: false,
    currentRefresh: null as string | null,
    issuedRefresh: new Set<string>(),
    seq: 0,
  };
  const issue = (scope: string) => {
    state.seq += 1;
    const refreshToken = `rt-${state.seq}`;
    state.currentRefresh = refreshToken;
    state.issuedRefresh.add(refreshToken);
    return {
      access_token: `at-${state.seq}`,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: 3600,
      scope,
    };
  };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && url.pathname === "/oauth/register") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw) as { redirect_uris?: string[] };
      json(201, { client_id: CLIENT_ID, client_name: "AIVerse MCP Bridge", redirect_uris: body.redirect_uris ?? [] });
      return;
    }
    if (req.method === "GET" && url.pathname === "/oauth/authorize") {
      state.authorizeParams = url.searchParams;
      state.pending = {
        challenge: url.searchParams.get("code_challenge") ?? "",
        redirectUri: url.searchParams.get("redirect_uri") ?? "",
        scope: url.searchParams.get("scope") ?? "",
      };
      const back = new URL(state.pending.redirectUri);
      back.searchParams.set("code", "fake-code-1");
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: back.toString() });
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/oauth/token") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const params = new URLSearchParams(raw);
      const invalid = (description: string) => json(400, { error: "invalid_grant", error_description: description });
      if (params.get("grant_type") === "authorization_code") {
        if (state.codeUsed || params.get("code") !== "fake-code-1") return invalid("unknown authorization code");
        if (params.get("client_id") !== CLIENT_ID) return invalid("client_id does not match the code");
        if (params.get("redirect_uri") !== state.pending?.redirectUri) return invalid("redirect_uri does not match the code");
        if (s256(params.get("code_verifier") ?? "") !== state.pending?.challenge) return invalid("PKCE verification failed");
        state.codeUsed = true;
        json(200, issue(state.pending.scope));
        return;
      }
      if (params.get("grant_type") === "refresh_token") {
        const presented = params.get("refresh_token") ?? "";
        state.refreshCalls.push(presented);
        if (presented === state.currentRefresh) {
          json(200, issue("world:observe world:act inbox:read relay:send discover"));
          return;
        }
        if (state.issuedRefresh.has(presented)) {
          state.currentRefresh = null; // reuse: the family and grant die, like the real server
          return invalid("refresh token reuse detected; grant revoked");
        }
        return invalid("unknown refresh token");
      }
      json(400, { error: "unsupported_grant_type", error_description: "nope" });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake AS has no port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get authorizeParams() {
      return state.authorizeParams;
    },
    refreshCalls: state.refreshCalls,
    close: () => server.close(),
  };
}

function tmpStore(): TokenStore {
  const dir = mkdtempSync(join(tmpdir(), "aiverse-bridge-oauth-"));
  return new TokenStore(join(dir, "tokens.json"));
}

function configFor(baseUrl: string, store: TokenStore): BridgeConfig {
  // TokenStore's file path is private; the manager only needs the base
  // URL from the config — the rest is filler for the type.
  void store;
  return { baseUrl, scopes: [...DEFAULT_SCOPES], configDir: "", tokenFile: "" };
}

async function runFlow(fake: FakeAS, store: TokenStore) {
  return performAuthFlow({
    baseUrl: fake.baseUrl,
    scopes: [...DEFAULT_SCOPES],
    store,
    // No browser: the "owner" is an HTTP client that follows the
    // authorize redirect for real — the loopback listener still gets
    // its callback as an actual HTTP GET.
    openUrl: async (url) => {
      const res = await fetch(url);
      await res.text();
      expect(res.status).toBe(200);
    },
    callbackTimeoutMs: 10_000,
  });
}

describe("OAuth flow against a fake authorization server", () => {
  test("full flow: register → authorize → loopback code → exchange → persisted grant", async () => {
    const fake = await startFakeAS();
    try {
      const store = tmpStore();
      const result = await runFlow(fake, store);
      expect(result.accessToken).toBe("at-1");
      expect(result.clientId).toBe(CLIENT_ID);
      const saved = store.load();
      expect(saved?.refreshToken).toBe("rt-1");
      expect(saved?.clientId).toBe(CLIENT_ID);
      expect(saved?.baseUrl).toBe(fake.baseUrl);
      // The authorize request carried the full scope set and S256 PKCE.
      expect(fake.authorizeParams?.get("scope")).toBe(DEFAULT_SCOPES.join(" "));
      expect(fake.authorizeParams?.get("code_challenge_method")).toBe("S256");
      expect(fake.authorizeParams?.get("response_type")).toBe("code");
      expect(fake.authorizeParams?.get("redirect_uri")).toStartWith("http://127.0.0.1:");
      // PKCE itself is proven by the fake: it verified S256(verifier)
      // against the challenge before issuing anything.
    } finally {
      fake.close();
    }
  });

  test("refresh rotates and the new refresh token is persisted before use", async () => {
    const fake = await startFakeAS();
    try {
      const store = tmpStore();
      await runFlow(fake, store);
      const manager = new TokenManager(configFor(fake.baseUrl, store), store);
      // A fresh process has no access token in memory: the first call refreshes.
      expect(await manager.getAccessToken()).toBe("at-2");
      expect(store.load()?.refreshToken).toBe("rt-2");
      expect(fake.refreshCalls).toEqual(["rt-1"]);
      // The second call is served from the in-memory cache — no new refresh.
      expect(await manager.getAccessToken()).toBe("at-2");
      expect(fake.refreshCalls).toEqual(["rt-1"]);
    } finally {
      fake.close();
    }
  });

  test("replaying a burned refresh token is grant gone, and stays gone without more network", async () => {
    const fake = await startFakeAS();
    try {
      const store = tmpStore();
      await runFlow(fake, store);
      const manager = new TokenManager(configFor(fake.baseUrl, store), store);
      await manager.getAccessToken(); // rotates rt-1 → rt-2
      // A second bridge instance still holding the burned rt-1 (the
      // lost-rotation scenario): the server reads reuse and kills the grant.
      const stale = tmpStore();
      stale.save({ ...store.load()!, refreshToken: "rt-1" });
      const staleManager = new TokenManager(configFor(fake.baseUrl, stale), stale);
      await expect(staleManager.getAccessToken()).rejects.toBeInstanceOf(GrantGoneError);
      const callsAfterDeath = fake.refreshCalls.length;
      await expect(staleManager.getAccessToken()).rejects.toBeInstanceOf(GrantGoneError);
      expect(fake.refreshCalls.length).toBe(callsAfterDeath); // sticky: no retry storm
    } finally {
      fake.close();
    }
  });

  test("the loopback listener refuses a state mismatch", async () => {
    const loopback = await startLoopback();
    try {
      // Plain-promise capture, deliberately not expect().rejects: under
      // bun test, an expect().rejects subscription placed on a promise
      // that settles later via a network callback never observes the
      // settlement (the wait times out instead) — verified in isolation;
      // the same order with a plain .then capture settles in ~50 ms.
      const waiting = loopback.waitForCallback("the-real-state", 10_000).then(
        () => "resolved",
        (e: Error) => `rejected: ${e.message}`,
      );
      const res = await fetch(`${loopback.redirectUri}?code=whatever&state=someone-elses-state`);
      await res.text();
      expect(await waiting).toContain("state mismatch");
    } finally {
      loopback.close();
    }
  });
});
