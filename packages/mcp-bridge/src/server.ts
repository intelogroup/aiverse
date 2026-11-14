import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { GRANT_GONE_MESSAGE, GrantGoneError, type FetchFn } from "./oauth";
import { postJsonRpc } from "./remote";
import type { TokenManager } from "./tokenManager";

// The stdio face of the bridge. It owns NO tools of its own: tools/list,
// tools/call and resources/* are forwarded to the gateway's /mcp/agent
// as they arrive, with the current access token attached, and the
// gateway's answers come back untouched. The gateway stays the single
// source of truth for the tool surface, the scope gates and every
// refusal text — a bridge that re-implemented any of that would drift.
//
// Auth recovery is exactly one step deep, by design: a 401 (the gateway
// checks grant liveness per request, so a revoked grant 401s even with
// an unexpired token) triggers one refresh and one retry. If the
// refresh itself answers invalid_grant, or the retry still 401s, the
// grant is gone — the client gets that message and nothing retries
// further.

export interface BridgeServerDeps {
  baseUrl: string;
  tokens: TokenManager;
  fetchFn?: FetchFn;
  log?: (message: string) => void;
}

/** A JSON-RPC error the gateway itself returned (a protocol-level refusal, not a tool result). */
class RemoteRpcError extends Error {}

export function buildBridgeServer(deps: BridgeServerDeps): Server {
  let nextId = 1;

  const attempt = async (method: string, params: unknown) => {
    const accessToken = await deps.tokens.getAccessToken();
    return postJsonRpc(deps.baseUrl, accessToken, { jsonrpc: "2.0", id: nextId++, method, params }, deps.fetchFn);
  };

  const forward = async (method: string, params: unknown): Promise<any> => {
    let res = await attempt(method, params);
    if (res.status === 401) {
      deps.log?.("aiverse-bridge: gateway refused the access token (401) — refreshing once and retrying");
      deps.tokens.invalidateAccess();
      res = await attempt(method, params); // getAccessToken() refreshes; a dead grant throws GrantGoneError here
      if (res.status === 401) throw new GrantGoneError("gateway still answered 401 after a refresh");
    }
    if (res.status !== 200) {
      throw new Error(`aiverse gateway answered HTTP ${res.status} for ${method}: ${res.text.slice(0, 200)}`);
    }
    if (!res.rpc) throw new Error(`aiverse gateway answered a non-JSON-RPC body for ${method}`);
    if (res.rpc.error) {
      throw new RemoteRpcError(res.rpc.error.message ?? `gateway error ${res.rpc.error.code ?? ""}`.trim());
    }
    return res.rpc.result;
  };

  const server = new Server(
    { name: "aiverse-bridge", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (request) => forward("tools/list", request.params));
  server.setRequestHandler(ListResourcesRequestSchema, async (request) => forward("resources/list", request.params));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => forward("resources/read", request.params));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await forward("tools/call", request.params);
    } catch (err) {
      // A tool call's failures ride back as an error RESULT the model can
      // read and relay — grant-gone most of all, since the fix is a human
      // re-running the bridge, and the client should say exactly that.
      if (err instanceof GrantGoneError) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      if (err instanceof RemoteRpcError) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      throw err;
    }
  });

  return server;
}

export { GRANT_GONE_MESSAGE };
