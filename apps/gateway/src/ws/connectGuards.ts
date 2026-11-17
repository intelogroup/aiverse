// Burst defenses for agent WS connects (extracted from ws/gateway.ts,
// cleanup L2; behavior unchanged).
import { redis } from "../redis/client";

// Reconnect budget: per-agent fixed-window counter in Redis. On exceed,
// the connect is shed with close 4009 and a retry_after_ms hint (ms until
// the window resets) in the close reason — the server-driven retry hint
// that, with client-side jittered backoff, keeps a shed fleet from
// re-synchronizing into a second storm.
export const RECONNECT_BUDGET_CLOSE_CODE = 4009;

const RECONNECT_BUDGET_LIMIT = 30;

const RECONNECT_BUDGET_WINDOW_SECONDS = 300;

// Returns 0 when this connect is within budget, else the ms until the
// current window resets.
export async function consumeReconnectBudget(agentId: string): Promise<number> {
  const key = `ws:reconnect:${agentId}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, RECONNECT_BUDGET_WINDOW_SECONDS);
  if (count <= RECONNECT_BUDGET_LIMIT) return 0;
  const pttl = await redis.pttl(key);
  return pttl > 0 ? pttl : RECONNECT_BUDGET_WINDOW_SECONDS * 1000;
}

// Connect admission: a per-process token bucket guarding the TLS+auth
// CPU a connect storm burns before any ticket is even redeemed. 200/s
// sustained, 400 burst by default; env-tunable with the production values
// as defaults, same pattern as the singleton-job intervals. The bucket
// re-clamps to the current cap on every check, so an env change takes
// effect on the next connect without a restart.
function connectRatePerSec(): number {
  const v = Number(process.env.AIVERSE_WS_CONNECT_RATE_PER_SEC);
  return Number.isFinite(v) && v >= 0 ? v : 200;
}

function connectBurstAllowance(): number {
  const v = Number(process.env.AIVERSE_WS_CONNECT_BURST);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 400;
}

let connectBucketTokens: number | undefined;

let connectBucketLastMs = Date.now();

function tryAdmitAgentConnect(): boolean {
  const cap = connectBurstAllowance();
  const now = Date.now();
  if (connectBucketTokens === undefined) connectBucketTokens = cap;
  connectBucketTokens = Math.min(
    cap,
    connectBucketTokens + ((now - connectBucketLastMs) / 1000) * connectRatePerSec(),
  );
  connectBucketLastMs = now;
  if (connectBucketTokens >= 1) {
    connectBucketTokens -= 1;
    return true;
  }
  return false;
}

// Hono handler placed ahead of upgradeWebSocket on /agents/ws: returning
// a response here ends the chain, so a shed connect costs one token check
// — no upgrade, no ticket redemption, no DB work. Existing connections
// are never touched by shedding; they are the expensive-to-rebuild asset.
export function agentConnectAdmission(
  c: { text: (body: string, status: number, headers?: Record<string, string>) => Response },
  next: () => Promise<unknown>,
): Promise<unknown> | Response {
  if (!tryAdmitAgentConnect()) {
    return c.text("too many connection attempts", 503, { "Retry-After": "1" });
  }
  return next();
}
