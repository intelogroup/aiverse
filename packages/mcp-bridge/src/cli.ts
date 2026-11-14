#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveConfig } from "./config";
import { performAuthFlow } from "./oauth";
import { buildBridgeServer } from "./server";
import { TokenManager } from "./tokenManager";
import { TokenStore } from "./tokenStore";

// aiverse-bridge: a stdio MCP server for clients that cannot speak
// Streamable HTTP (Claude Desktop, Cursor, …). Launched as a subprocess
// by the client; speaks MCP on stdout — so EVERY diagnostic goes to
// stderr, and stdout carries JSON-RPC and nothing else.
//
// First run (no stored grant for this gateway): the OAuth flow runs
// BEFORE the stdio server starts, so the client's initialize simply
// waits while the owner signs in and consents in their browser. Later
// runs go straight to serving: the stored refresh token mints access
// tokens as needed.

const log = (message: string): void => {
  console.error(message);
};

function openInBrowser(url: string): void {
  // The URL always lands on stderr first: a machine where the open
  // command fails (headless, minimal Linux) still gives the owner a
  // link to paste into a browser themselves.
  log(`aiverse-bridge: if your browser does not open, visit this URL to connect:\n${url}`);
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {
      /* the stderr URL above is the fallback */
    });
    child.unref();
  } catch {
    /* same fallback */
  }
}

async function main(): Promise<void> {
  const config = resolveConfig();
  const store = new TokenStore(config.tokenFile);
  const tokens = new TokenManager(config, store);

  if (!tokens.hasGrant()) {
    log(`aiverse-bridge: no stored grant for ${config.baseUrl} — connecting now.`);
    const result = await performAuthFlow({
      baseUrl: config.baseUrl,
      scopes: config.scopes,
      store,
      openUrl: openInBrowser,
      log,
    });
    tokens.adoptFlowResult(result);
    log(`aiverse-bridge: connected. Refresh token saved to ${config.tokenFile} (mode 0600).`);
  }

  const server = buildBridgeServer({ baseUrl: config.baseUrl, tokens, log });
  server.onclose = () => process.exit(0);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  await server.connect(new StdioServerTransport());
  log(`aiverse-bridge: ready — proxying stdio → ${config.baseUrl}/mcp/agent`);
}

main().catch((err: unknown) => {
  log(`aiverse-bridge: fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
