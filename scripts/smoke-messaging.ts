// Manual Phase 2 smoke test against a live gateway:
//   bun run apps/gateway/src/index.ts &
//   bun run scripts/smoke-messaging.ts
const BASE = process.env.GATEWAY_URL ?? "http://localhost:3010";
const WS_BASE = BASE.replace(/^http/, "ws");

async function registerAgent(name: string) {
  const email = `smoke-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await fetch(`${BASE}/owners/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const { token } = await reg.json();
  const created = await fetch(`${BASE}/owners/agents`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, capabilities: [] }),
  });
  const { agentToken } = await created.json();
  return agentToken as string;
}

const tokenA = await registerAgent("SmokeA");
const tokenB = await registerAgent("SmokeB");

// One-time WS ticket — keeps the long-lived agent token out of query strings
// and gateway access logs.
async function fetchWsTicket(agentToken: string): Promise<string> {
  const res = await fetch(`${BASE}/auth/ws-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${agentToken}` },
  });
  if (!res.ok) throw new Error(`ws-ticket issue failed: ${res.status}`);
  const { ticket } = await res.json();
  return ticket as string;
}

const wsB = new WebSocket(`${WS_BASE}/agents/ws?ticket=${await fetchWsTicket(tokenB)}`);
await new Promise((r) => (wsB.onopen = r));

const wsA = new WebSocket(`${WS_BASE}/agents/ws?ticket=${await fetchWsTicket(tokenA)}`);
await new Promise((r) => (wsA.onopen = r));

const joinA = await fetch(`${BASE}/rooms/general/join`, {
  method: "POST",
  headers: { authorization: `Bearer ${tokenA}` },
});
const { conversationId } = await joinA.json();

await fetch(`${BASE}/rooms/general/join`, {
  method: "POST",
  headers: { authorization: `Bearer ${tokenB}` },
});

const received = new Promise((resolve) => {
  wsB.onmessage = (msg) => {
    const event = JSON.parse(String(msg.data));
    if (event.type === "message") resolve(event);
  };
});

const sendRes = await fetch(`${BASE}/conversations/${conversationId}/messages`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` },
  body: JSON.stringify({ content: "smoke test message" }),
});
const { message } = await sendRes.json();

const event = (await received) as { payload: { conversation_id: string; message_id: string } };
if (event.payload.message_id !== message.id || event.payload.conversation_id !== conversationId) {
  console.error("FAIL: WS event did not match Postgres row", event, message);
  process.exit(1);
}
console.log("PASS: B received A's message over WS, matches Postgres row");

console.log("Blasting 50 msg/sec to confirm rate limiter trips...");
const burst = await Promise.all(
  Array.from({ length: 50 }, () =>
    fetch(`${BASE}/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ content: "spam" }),
    }),
  ),
);
const statuses = burst.map((r) => r.status);
const okCount = statuses.filter((s) => s === 201).length;
const limitedCount = statuses.filter((s) => s === 429).length;
console.log(`201: ${okCount}, 429: ${limitedCount}`);
if (limitedCount === 0) {
  console.error("FAIL: rate limiter never tripped on 50 msg/sec burst");
  process.exit(1);
}
console.log("PASS: rate limiter tripped instead of letting all 50 land");

wsA.close();
wsB.close();
process.exit(0);
