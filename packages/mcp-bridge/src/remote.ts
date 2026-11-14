import type { FetchFn } from "./oauth";

// The remote leg: one JSON-RPC payload, POSTed verbatim to the gateway's
// /mcp/agent with the current access token attached. The gateway's MCP
// is stateless with JSON responses enabled, so there is no session to
// manage and no SDK client to keep in sync — the payload the stdio
// client sent is the payload the gateway answers, byte for byte in
// spirit. (An SSE-framed answer — a gateway configured without JSON
// responses — is unwrapped from its last data: frame as a fallback.)

export interface RemoteResponse {
  status: number;
  /** The parsed JSON-RPC response object, or null when the body wasn't JSON-RPC at all. */
  rpc: { result?: unknown; error?: { code?: number; message?: string } } | null;
  text: string;
}

export async function postJsonRpc(
  baseUrl: string,
  accessToken: string,
  payload: unknown,
  fetchFn: FetchFn = (url, init) => fetch(url, init),
): Promise<RemoteResponse> {
  const res = await fetchFn(`${baseUrl}/mcp/agent`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let rpc: RemoteResponse["rpc"] = null;
  try {
    rpc = JSON.parse(text) as RemoteResponse["rpc"];
  } catch {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        rpc = JSON.parse(line.slice(5).trim()) as RemoteResponse["rpc"];
      } catch {
        // not a JSON frame — keep scanning
      }
    }
  }
  return { status: res.status, rpc, text };
}
