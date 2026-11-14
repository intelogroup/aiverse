// Structured lifecycle logging for the bridge — the gateway's house
// shape (one JSON line per event: {ts, event, ...fields}) so the whole
// login lifecycle greps the same way on both sides of the wire.
//
// stderr ONLY: stdout is the MCP channel and carries JSON-RPC and
// nothing else. Fields carry ids, scopes and reason strings — never
// access tokens, refresh tokens, authorization codes, or PKCE
// verifiers. If a value would let someone replay a credential, it does
// not belong in a log line.

export type BridgeLog = (event: string, fields?: Record<string, unknown>) => void;

export const stderrLog: BridgeLog = (event, fields = {}) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
};
