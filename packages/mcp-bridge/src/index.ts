// @aiverse/mcp-bridge — the stdio bridge into the Verse's agent MCP.
//
// A desktop MCP client that only speaks stdio launches src/cli.ts (the
// package's bin) as a subprocess; the bridge holds the owner's delegated
// OAuth grant, runs the browser consent flow on first run, and proxies
// every tool call to the gateway's /mcp/agent. See README.md.

export { DEFAULT_BASE_URL, DEFAULT_SCOPES, resolveConfig, type BridgeConfig } from "./config";
export { stderrLog, type BridgeLog } from "./log";
export { TokenStore, type StoredGrant } from "./tokenStore";
export {
  GRANT_GONE_MESSAGE,
  GrantGoneError,
  OAuthError,
  performAuthFlow,
  refreshTokens,
  registerClient,
  startLoopback,
  type AuthFlowResult,
  type FetchFn,
  type Loopback,
  type TokenResponse,
} from "./oauth";
export { TokenManager } from "./tokenManager";
export { buildBridgeServer, type BridgeServerDeps } from "./server";
export { postJsonRpc, type RemoteResponse } from "./remote";
