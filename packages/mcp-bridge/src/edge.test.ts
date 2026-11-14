import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeConfig } from "./config";
import { GrantGoneError, type FetchFn } from "./oauth";
import { postJsonRpc } from "./remote";
import { TokenManager } from "./tokenManager";
import { TokenStore, type StoredGrant } from "./tokenStore";

// Adversarial edges for the bridge's credential handling and response
// unwrapping — the cases tokenStore.test.ts / proxy.test.ts /
// oauth.test.ts do not pin: a grant minted by a DIFFERENT gateway must
// never be offered to this one; a corrupt or unwritable store must fail
// cleanly (and a failed save must leave no trace, nor ever cause a
// burned token to be presented twice); and the SSE fallback in
// postJsonRpc, which the plain-JSON stub in proxy.test.ts never reaches.

const BASE_A = "https://a.example";
const BASE_B = "https://b.example";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";

function grantFor(baseUrl: string, refreshToken: string): StoredGrant {
  return {
    version: 1,
    baseUrl,
    clientId: CLIENT_ID,
    refreshToken,
    scope: "world:observe",
    updatedAt: "2026-11-14T00:00:00.000Z",
  };
}

function configFor(baseUrl: string, dir: string, tokenFile: string): BridgeConfig {
  return { baseUrl, scopes: ["world:observe"], configDir: dir, tokenFile };
}

/** A fetch double that records every call and answers a rotating refresh. */
function rotatingGateway(presented: string[]): FetchFn {
  return async (_url, init) => {
    const params = new URLSearchParams(String(init?.body ?? ""));
    presented.push(params.get("refresh_token") ?? "");
    return new Response(
      JSON.stringify({
        access_token: "at-fresh",
        refresh_token: "rt-rotated",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "world:observe",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

describe("a stored grant is bound to the gateway that minted it", () => {
  test("base A grant + base B config: no grant, no network, the token never leaves for B", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiverse-bridge-edge-"));
    const file = join(dir, "tokens.json");
    new TokenStore(file).save(grantFor(BASE_A, "rt-from-a"));

    const presented: string[] = [];
    const manager = new TokenManager(configFor(BASE_B, dir, file), new TokenStore(file), {
      fetchFn: rotatingGateway(presented),
    });
    expect(manager.hasGrant()).toBe(false);
    await expect(manager.getAccessToken()).rejects.toThrow(`no stored grant for ${BASE_B}`);
    expect(presented).toEqual([]);
  });
});

describe("corrupt + unwritable stores fail cleanly", () => {
  test("a tokens.json corrupted mid-run reads as no grant — one clean error, zero network", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiverse-bridge-edge-"));
    const file = join(dir, "tokens.json");
    const store = new TokenStore(file);
    store.save(grantFor(BASE_A, "rt-seed"));
    writeFileSync(file, "{corrupted mid-run");

    const presented: string[] = [];
    const manager = new TokenManager(configFor(BASE_A, dir, file), store, {
      fetchFn: rotatingGateway(presented),
    });
    expect(manager.hasGrant()).toBe(false);
    await expect(manager.getAccessToken()).rejects.toThrow(`no stored grant for ${BASE_A}`);
    expect(presented).toEqual([]);
  });

  test("a failed save leaves NO tmp file behind and the previous store untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiverse-bridge-edge-"));
    const file = join(dir, "tokens.json");
    const store = new TokenStore(file);
    store.save(grantFor(BASE_A, "rt-previous"));

    // Sabotage the rename target: tokens.json becomes a directory, so the
    // atomic rename must fail — after which the store dir must hold no
    // stranded tmp file (it would contain a live refresh token).
    rmSync(file);
    mkdirSync(file);
    expect(() => store.save(grantFor(BASE_A, "rt-new"))).toThrow();
    expect(readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
    expect(statSync(file).isDirectory()).toBe(true);
  });

  test("a config path blocked by a plain file fails the save and creates nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiverse-bridge-edge-"));
    const blocker = join(dir, "aiverse-bridge");
    writeFileSync(blocker, "not a directory");
    const store = new TokenStore(join(blocker, "tokens.json"));
    expect(() => store.save(grantFor(BASE_A, "rt-x"))).toThrow();
    expect(existsSync(join(blocker, "tokens.json"))).toBe(false);
  });

  test("when the rotated token cannot be saved, the burned token is NEVER presented twice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aiverse-bridge-edge-"));
    const file = join(dir, "tokens.json");
    writeFileSync(file, `${JSON.stringify(grantFor(BASE_A, "rt-seed"), null, 2)}\n`);
    class FailingSaveStore extends TokenStore {
      saveAttempts = 0;
      override save(): void {
        this.saveAttempts++;
        throw new Error("ENOSPC: no space left on device");
      }
    }
    const store = new FailingSaveStore(file);
    const presented: string[] = [];
    const manager = new TokenManager(configFor(BASE_A, dir, file), store, {
      fetchFn: rotatingGateway(presented),
    });

    // First call: the refresh happens, the save fails, the failure is a
    // single human-readable GrantGoneError — not a raw fs error.
    const first = await manager.getAccessToken().then(
      () => null,
      (err: unknown) => err,
    );
    expect(first).toBeInstanceOf(GrantGoneError);
    expect((first as Error).message).toContain("could not be saved");
    expect(presented).toEqual(["rt-seed"]);
    expect(store.saveAttempts).toBe(1);

    // Second call: the sticky failure answers WITHOUT the network. The
    // seed token was burned by the first refresh — presenting it again
    // would read as reuse at the gateway and revoke the whole grant.
    const second = await manager.getAccessToken().then(
      () => null,
      (err: unknown) => err,
    );
    expect(second).toBeInstanceOf(GrantGoneError);
    expect(presented).toEqual(["rt-seed"]);
    expect(store.saveAttempts).toBe(1);
  });
});

describe("SSE-framed gateway answers are unwrapped", () => {
  const sseFetch =
    (body: string): FetchFn =>
    async () =>
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

  test("a single data: frame unwraps to its JSON-RPC payload", async () => {
    const payload = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "world_observe" }] } };
    const res = await postJsonRpc(
      BASE_A,
      "at-1",
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      sseFetch(`event: message\ndata: ${JSON.stringify(payload)}\n\n`),
    );
    expect(res.status).toBe(200);
    expect(res.rpc).toEqual(payload);
  });

  test("with several frames the LAST data: frame wins; unparseable frames are skipped", async () => {
    const notification = { jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } };
    const result = { jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "ok" }] } };
    const body = [
      `event: message\ndata: ${JSON.stringify(notification)}\n\n`,
      `data: this is not json\n\n`,
      `event: message\ndata: ${JSON.stringify(result)}\n\n`,
    ].join("");
    const res = await postJsonRpc(
      BASE_A,
      "at-1",
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "world_observe", arguments: {} } },
      sseFetch(body),
    );
    expect(res.rpc).toEqual(result);
  });
});
