import { describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore } from "./tokenStore";

// End-to-end proxy proof: the bridge is spawned as a real subprocess and
// spoken to over its actual stdio pipes, against a stub gateway (token
// endpoint + /mcp/agent). Nothing about the MCP leg is mocked — if the
// bridge mangles a frame, a header or an argument, this is where it
// shows.

const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const PKG_DIR = join(import.meta.dir, "..");
const CLI = join(PKG_DIR, "src", "cli.ts");
const SCOPES = "world:observe world:act inbox:read relay:send discover";

interface StubGateway {
  baseUrl: string;
  refreshCalls: string[];
  mcpCalls: { auth: string | null; method: string; params: any }[];
  close: () => void;
}

async function startStubGateway(opts: { refusedAccess?: string[]; deadGrant?: boolean } = {}): Promise<StubGateway> {
  const state = {
    refreshCalls: [] as string[],
    mcpCalls: [] as { auth: string | null; method: string; params: any }[],
    currentRefresh: "rt-seed",
    seq: 0,
  };
  const refused = new Set(opts.refusedAccess ?? []);
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && url.pathname === "/oauth/token") {
      const params = new URLSearchParams(raw);
      const presented = params.get("refresh_token") ?? "";
      state.refreshCalls.push(presented);
      if (opts.deadGrant || presented !== state.currentRefresh) {
        json(400, { error: "invalid_grant", error_description: "grant is revoked or expired" });
        return;
      }
      state.seq += 1;
      state.currentRefresh = `rt-${state.seq}`;
      json(200, {
        access_token: `at-${state.seq}`,
        refresh_token: state.currentRefresh,
        token_type: "Bearer",
        expires_in: 3600,
        scope: SCOPES,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/mcp/agent") {
      const auth = req.headers.authorization ?? null;
      const rpc = JSON.parse(raw) as { id: number; method: string; params: any };
      state.mcpCalls.push({ auth, method: rpc.method, params: rpc.params });
      if (!auth || refused.has(auth.replace("Bearer ", ""))) {
        json(401, { error: "unauthorized" });
        return;
      }
      const answer = (result: unknown) => json(200, { jsonrpc: "2.0", id: rpc.id, result });
      if (rpc.method === "tools/list") {
        answer({
          tools: [
            {
              name: "world_observe",
              description: "stub observe tool",
              inputSchema: { type: "object", properties: { agent_id: { type: "string" } } },
            },
          ],
        });
        return;
      }
      if (rpc.method === "tools/call") {
        answer({
          content: [{ type: "text", text: `stub:${rpc.params?.name}:${rpc.params?.arguments?.agent_id ?? ""}` }],
        });
        return;
      }
      if (rpc.method === "resources/list") {
        answer({ resources: [{ uri: "aiverse://guide", name: "aiverse-guide", mimeType: "text/plain" }] });
        return;
      }
      if (rpc.method === "resources/read") {
        answer({ contents: [{ uri: rpc.params?.uri, mimeType: "text/plain", text: "stub guide text" }] });
        return;
      }
      json(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "method not found" } });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stub gateway has no port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    refreshCalls: state.refreshCalls,
    mcpCalls: state.mcpCalls,
    close: () => server.close(),
  };
}

// ---------------------------------------------------------------------------
// A minimal stdio JSON-RPC client for the spawned bridge: newline-
// delimited frames, matched by id.

class StdioClient {
  private buffered: string[] = [];
  private waiters: ((line: string) => void)[] = [];
  private partial = "";
  stderrText = "";

  constructor(private readonly proc: ReturnType<typeof Bun.spawn>) {
    const pump = async (stream: ReadableStream<Uint8Array>, onText: (text: string) => void) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        onText(decoder.decode(value, { stream: true }));
      }
    };
    void pump(proc.stdout as ReadableStream<Uint8Array>, (text) => {
      this.partial += text;
      for (;;) {
        const idx = this.partial.indexOf("\n");
        if (idx < 0) return;
        const line = this.partial.slice(0, idx);
        this.partial = this.partial.slice(idx + 1);
        const waiter = this.waiters.shift();
        if (waiter) waiter(line);
        else this.buffered.push(line);
      }
    });
    void pump(proc.stderr as ReadableStream<Uint8Array>, (text) => {
      this.stderrText += text;
    });
  }

  private nextLine(timeoutMs = 15_000): Promise<string> {
    const queued = this.buffered.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for the bridge to answer. stderr so far:\n${this.stderrText}`)),
        timeoutMs,
      );
      this.waiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  }

  async send(message: Record<string, unknown>): Promise<void> {
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
    await this.proc.stdin.flush();
  }

  async request(id: number, method: string, params: Record<string, unknown> = {}): Promise<any> {
    await this.send({ jsonrpc: "2.0", id, method, params });
    for (;;) {
      const line = await this.nextLine();
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as { id?: number };
      if (parsed.id === id) return parsed;
    }
  }

  async handshake(): Promise<any> {
    const init = await this.request(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "bridge-proxy-test", version: "0.0.0" },
    });
    await this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return init;
  }

  kill(): void {
    this.proc.kill();
  }
}

function spawnBridge(stub: StubGateway, refreshToken: string): StdioClient {
  const xdg = mkdtempSync(join(tmpdir(), "aiverse-bridge-xdg-"));
  new TokenStore(join(xdg, "aiverse-bridge", "tokens.json")).save({
    version: 1,
    baseUrl: stub.baseUrl,
    clientId: CLIENT_ID,
    refreshToken,
    scope: SCOPES,
    updatedAt: new Date().toISOString(),
  });
  const proc = Bun.spawn(["bun", CLI], {
    cwd: PKG_DIR,
    env: { ...process.env, AIVERSE_BASE_URL: stub.baseUrl, XDG_CONFIG_HOME: xdg },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return new StdioClient(proc);
}

describe("stdio bridge proxy (spawned, real pipes)", () => {
  test("tools/list and tools/call pass through with the Bearer token; arguments untouched", async () => {
    const stub = await startStubGateway();
    const client = spawnBridge(stub, "rt-seed");
    try {
      const init = await client.handshake();
      expect(init.result?.serverInfo?.name).toBe("aiverse-bridge");

      const list = await client.request(2, "tools/list");
      expect(list.result?.tools?.[0]?.name).toBe("world_observe");

      const call = await client.request(3, "tools/call", {
        name: "world_observe",
        arguments: { agent_id: "agent-42" },
      });
      expect(call.result?.content?.[0]?.text).toBe("stub:world_observe:agent-42");

      const read = await client.request(4, "resources/read", { uri: "aiverse://guide" });
      expect(read.result?.contents?.[0]?.text).toBe("stub guide text");

      // One refresh minted the access token; every remote call carried it.
      expect(stub.refreshCalls).toEqual(["rt-seed"]);
      expect(stub.mcpCalls.map((c) => c.auth)).toEqual(["Bearer at-1", "Bearer at-1", "Bearer at-1"]);
      // The agent_id argument crossed the bridge exactly as the client sent it.
      const callSeen = stub.mcpCalls.find((c) => c.method === "tools/call");
      expect(callSeen?.params?.arguments?.agent_id).toBe("agent-42");
    } finally {
      client.kill();
      stub.close();
    }
  }, 30_000);

  test("a remote 401 triggers exactly one refresh and a retry", async () => {
    const stub = await startStubGateway({ refusedAccess: ["at-1"] });
    const client = spawnBridge(stub, "rt-seed");
    try {
      await client.handshake();
      const call = await client.request(2, "tools/call", { name: "world_observe", arguments: {} });
      expect(call.result?.content?.[0]?.text).toBe("stub:world_observe:");
      // First token refused → bridge refreshed (rt-seed, then rt-1) and retried with at-2.
      expect(stub.refreshCalls).toEqual(["rt-seed", "rt-1"]);
      expect(stub.mcpCalls.map((c) => c.auth)).toEqual(["Bearer at-1", "Bearer at-2"]);
    } finally {
      client.kill();
      stub.close();
    }
  }, 30_000);

  test("a dead grant surfaces 'grant gone — re-run to reconnect' and stops retrying", async () => {
    const stub = await startStubGateway({ deadGrant: true });
    const client = spawnBridge(stub, "rt-dead");
    try {
      await client.handshake();
      const call = await client.request(2, "tools/call", { name: "world_observe", arguments: {} });
      expect(call.result?.isError).toBe(true);
      expect(call.result?.content?.[0]?.text).toMatch(/grant gone/);
      expect(call.result?.content?.[0]?.text).toMatch(/Re-run the bridge to reconnect/);
      // Sticky: a second call fails the same way with no new token request.
      const again = await client.request(3, "tools/call", { name: "world_observe", arguments: {} });
      expect(again.result?.isError).toBe(true);
      expect(stub.refreshCalls).toEqual(["rt-dead"]);
    } finally {
      client.kill();
      stub.close();
    }
  }, 30_000);
});
