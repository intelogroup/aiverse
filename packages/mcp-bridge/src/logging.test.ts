import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_SCOPES, type BridgeConfig } from "./config";
import { stderrLog } from "./log";
import { GrantGoneError, performAuthFlow, type FetchFn } from "./oauth";
import { buildBridgeServer } from "./server";
import { TokenManager } from "./tokenManager";
import { TokenStore } from "./tokenStore";

// Stderr discipline for the bridge's login lifecycle: the structured
// events (auth flow, refresh, proxy retry, grant death) must land on
// stderr as gateway-shaped JSON lines — stdout is the MCP channel —
// and NO credential value (authorization code, access token, refresh
// token) may ever appear in the output. The fake AS below issues
// deliberately greppable token strings (at-N / rt-N / fake-code-1) so
// the no-leak assertion can search for the actual secrets in play.

const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const SCOPE_STRING = "world:observe world:act inbox:read relay:send discover";

interface FakeAS {
  baseUrl: string;
  refreshCalls: string[];
  close: () => void;
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

// Trimmed copy of oauth.test.ts's fake authorization server: DCR,
// auto-approving authorize, PKCE verified at exchange, rotating
// refresh tokens whose reuse kills the grant.
async function startFakeAS(): Promise<FakeAS> {
  const state = {
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
          json(200, issue(SCOPE_STRING));
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
    refreshCalls: state.refreshCalls,
    close: () => server.close(),
  };
}

function tmpStore(): TokenStore {
  const dir = mkdtempSync(join(tmpdir(), "aiverse-bridge-logging-"));
  return new TokenStore(join(dir, "tokens.json"));
}

function configFor(baseUrl: string): BridgeConfig {
  return { baseUrl, scopes: [...DEFAULT_SCOPES], configDir: "", tokenFile: "" };
}

function captureStderr() {
  const lines: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...args: any[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  });
  return {
    lines,
    jsonEvents: () =>
      lines
        .filter((l) => l.startsWith("{"))
        .map((l) => {
          try {
            return JSON.parse(l) as any;
          } catch {
            return null;
          }
        })
        .filter(Boolean),
    restore: () => spy.mockRestore(),
  };
}

describe("bridge lifecycle logging", () => {
  test("flow + refresh + proxy retry + grant death all log to stderr, with no credential in any line", async () => {
    const fake = await startFakeAS();
    const cap = captureStderr();
    try {
      // 1. The connect flow.
      const store = tmpStore();
      const result = await performAuthFlow({
        baseUrl: fake.baseUrl,
        scopes: [...DEFAULT_SCOPES],
        store,
        openUrl: async (url) => {
          const res = await fetch(url);
          await res.text();
          expect(res.status).toBe(200);
        },
        events: stderrLog,
        callbackTimeoutMs: 10_000,
      });

      // 2. A refresh: adopt the flow's tokens, drop the cached access
      // token, and the next handout must rotate rt-1 → rt-2.
      const manager = new TokenManager(configFor(fake.baseUrl), store, { log: stderrLog });
      manager.adoptFlowResult(result);
      manager.invalidateAccess();
      expect(await manager.getAccessToken()).toBe("at-2");

      // 3. The proxy leg: the gateway 401s the first attempt, the
      // bridge refreshes (rt-2 → rt-3) and retries to success.
      let mcpCalls = 0;
      const mcpStub: FetchFn = async (_url, init) => {
        mcpCalls += 1;
        if (mcpCalls === 1) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        const rpc = JSON.parse(String(init?.body ?? "{}")) as { id?: number };
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id ?? 1,
            result: {
              tools: [
                {
                  name: "world_observe",
                  description: "stub observe tool",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };
      const server = buildBridgeServer({ baseUrl: fake.baseUrl, tokens: manager, fetchFn: mcpStub, log: stderrLog });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "logging-test-client", version: "0.0.0" });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toContain("world_observe");
      await client.close();
      await server.close();

      // 4. Grant death: a store still holding the burned rt-2. The
      // first attempt presents it (the fake AS reads reuse and kills
      // the grant); the second must fail stickily WITHOUT another
      // network call.
      const deadStore = tmpStore();
      deadStore.save({
        version: 1,
        baseUrl: fake.baseUrl,
        clientId: CLIENT_ID,
        refreshToken: "rt-2",
        scope: SCOPE_STRING,
        updatedAt: new Date().toISOString(),
      });
      const deadManager = new TokenManager(configFor(fake.baseUrl), deadStore, { log: stderrLog });
      const callsBefore = fake.refreshCalls.length;
      await expect(deadManager.getAccessToken()).rejects.toBeInstanceOf(GrantGoneError);
      await expect(deadManager.getAccessToken()).rejects.toBeInstanceOf(GrantGoneError);
      expect(fake.refreshCalls.length).toBe(callsBefore + 1);

      // The events, in the gateway's shape.
      const events = cap.jsonEvents();
      const names = events.map((e) => e.event);
      for (const want of ["auth_flow_started", "auth_flow_completed", "token_refreshed", "proxy_auth_retry", "grant_gone"]) {
        expect(names).toContain(want);
      }
      expect(names.filter((n) => n === "token_refreshed").length).toBe(2);
      expect(names.filter((n) => n === "grant_gone").length).toBe(1);
      for (const e of events) {
        expect(typeof e.ts).toBe("string");
        expect(Number.isNaN(Date.parse(e.ts))).toBe(false);
      }

      // And the whole point: no credential value anywhere in the output.
      const text = cap.lines.join("\n");
      for (const secret of ["fake-code-1", "rt-1", "rt-2", "rt-3", "at-1", "at-2", "at-3"]) {
        expect(text).not.toContain(secret);
      }
    } finally {
      cap.restore();
      fake.close();
    }
  });
});
