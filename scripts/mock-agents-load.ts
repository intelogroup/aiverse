// Mock-agent load harness: correctness assertions (small N) + a concurrency
// ramp that pushes agent count up until a real bottleneck shows (DB pool,
// WS accept, whatever) and reports exactly what broke.
//
//   bun run dev &                    # gateway on :3010
//   bun run scripts/mock-agents-load.ts

const BASE = process.env.GATEWAY_URL ?? "http://localhost:3010";
const WS_BASE = BASE.replace(/^http/, "ws");

type Json = Record<string, unknown>;

async function request(
  method: "POST" | "PATCH",
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Json;
  return { status: res.status, json };
}

async function post(path: string, body: unknown, token?: string) {
  return request("POST", path, body, token);
}

async function patch(path: string, body: unknown, token?: string) {
  return request("PATCH", path, body, token);
}

async function get(path: string, token?: string): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${BASE}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const json = (await res.json().catch(() => ({}))) as Json;
  return { status: res.status, json };
}

interface MockAgent {
  ownerToken: string;
  ownerId: string;
  agentId: string;
  agentToken: string;
  name: string;
}

async function registerAgent(name: string): Promise<MockAgent> {
  const email = `load-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await post("/owners/register", { email, password: "password123" });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.json)}`);
  const ownerToken = reg.json.token as string;
  const ownerId = (reg.json.owner as Json).id as string;

  const created = await post("/owners/agents", { name, capabilities: [] }, ownerToken);
  if (created.status !== 201) throw new Error(`agent create failed: ${created.status} ${JSON.stringify(created.json)}`);
  const agentId = (created.json.agent as Json).id as string;
  const agentToken = created.json.agentToken as string;

  return { ownerToken, ownerId, agentId, agentToken, name };
}

function connectWs(token: string): Promise<{ ws: WebSocket; events: Json[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/agents/ws?token=${token}`);
    const events: Json[] = [];
    const timer = setTimeout(() => reject(new Error("ws connect timeout")), 10_000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve({ ws, events });
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("ws error"));
    };
    ws.onmessage = (msg) => {
      const event = JSON.parse(String(msg.data)) as Json;
      if (event.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", id: crypto.randomUUID(), ts: Date.now(), payload: {} }));
        return;
      }
      events.push(event);
    };
  });
}

// ---------------------------------------------------------------------------
// PART 1: correctness assertions — small, deterministic, one concern each.
// ---------------------------------------------------------------------------

type CheckFn = () => Promise<void>;
const checks: Record<string, CheckFn> = {};
let checkIndex = 0;

function check(name: string, fn: CheckFn) {
  checks[`${(++checkIndex).toString().padStart(2, "0")}. ${name}`] = fn;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

check("onboarding: register+create unique", async () => {
  const [a, b] = await Promise.all([registerAgent("Check-Onboard-A"), registerAgent("Check-Onboard-B")]);
  assert(a.agentToken !== b.agentToken, "tokens collided");
  assert(a.agentId !== b.agentId, "agent ids collided");
});

check("ws presence: connect + agent_joined + network/stats", async () => {
  const a = await registerAgent("Check-Presence-A");
  const b = await registerAgent("Check-Presence-B");
  const connA = await connectWs(a.agentToken);
  await new Promise((r) => setTimeout(r, 200));

  const joinedPromise = new Promise<void>((resolve) => {
    const iv = setInterval(() => {
      if (connA.events.some((e) => e.type === "agent_joined")) {
        clearInterval(iv);
        resolve();
      }
    }, 50);
    setTimeout(() => {
      clearInterval(iv);
      resolve();
    }, 3000);
  });
  const connB = await connectWs(b.agentToken);
  await joinedPromise;
  assert(connA.events.some((e) => e.type === "agent_joined"), "A never saw agent_joined for B");

  const after = await get("/owners/network/stats", a.ownerToken);
  assert((after.json.onlineAgents as number) >= 2, `expected >=2 online, got ${after.json.onlineAgents}`);
  connA.ws.close();
  connB.ws.close();
});

check("room join: idempotent, no dupes", async () => {
  const a = await registerAgent("Check-Room-A");
  const j1 = await post("/rooms/general/join", {}, a.agentToken);
  assert(j1.status === 200, `first join failed: ${j1.status}`);
  const j2 = await post("/rooms/general/join", {}, a.agentToken);
  assert(j2.status === 200, `second join failed: ${j2.status}`);
  assert(j1.json.conversationId === j2.json.conversationId, "re-join returned different conversation");
});

check("agent send-rate gate trips", async () => {
  const a = await registerAgent("Check-AgentRate-A");
  const walletRes = await patch(`/owners/agents/${a.agentId}/wallet`, { autonomyMode: "autonomous" }, a.ownerToken);
  assert(walletRes.status === 200, `wallet patch failed: ${walletRes.status}`);
  const j = await post("/rooms/general/join", {}, a.agentToken);
  const conversationId = j.json.conversationId as string;

  const results = await Promise.all(
    Array.from({ length: 10 }, () => post(`/conversations/${conversationId}/messages`, { content: "spam" }, a.agentToken)),
  );
  const limited = results.filter((r) => r.status === 429).length;
  assert(limited > 0, "agent rate limiter never tripped on 10 rapid sends");
});

check("budget gate: exceed dailyTokenBudget -> budget_exhausted", async () => {
  const a = await registerAgent("Check-Budget-A");
  const walletRes = await patch(`/owners/agents/${a.agentId}/wallet`, { dailyTokenBudget: 100, autonomyMode: "autonomous" }, a.ownerToken);
  assert(walletRes.status === 200, `wallet patch failed: ${walletRes.status}`);
  const j = await post("/rooms/general/join", {}, a.agentToken);
  const conversationId = j.json.conversationId as string;

  const res = await post(`/conversations/${conversationId}/messages`, { content: "big", tokensUsed: 200 }, a.agentToken);
  assert(res.status === 429, `expected 429 budget_exceeded, got ${res.status}`);

  const agentRow = await get("/owners/agents", a.ownerToken);
  const list = agentRow.json.agents as Json[];
  const mine = list.find((x) => x.id === a.agentId);
  assert(mine?.status === "budget_exhausted", `expected budget_exhausted status, got ${mine?.status}`);

  const events = await get("/owners/console-events?severity=attention", a.ownerToken);
  const evs = events.json.events as Json[];
  assert(evs.some((e) => e.refConversationId === conversationId), "no attention event recorded for budget exhaustion");
});

check("autonomy: observe blocks, assist requires approval, autonomous sends", async () => {
  const a = await registerAgent("Check-Autonomy-A");
  const j = await post("/rooms/general/join", {}, a.agentToken);
  const conversationId = j.json.conversationId as string;

  const observeRes = await post(`/conversations/${conversationId}/messages`, { content: "hi" }, a.agentToken);
  assert(observeRes.status === 403, `default observe mode should block send, got ${observeRes.status}`);

  await patch(`/owners/agents/${a.agentId}/wallet`, { autonomyMode: "assist" }, a.ownerToken);
  const assistRes = await post(`/conversations/${conversationId}/messages`, { content: "spend", spendCents: 50 }, a.agentToken);
  assert(assistRes.status === 201, `assist mode with spend should still send, got ${assistRes.status}`);
  const events = await get("/owners/console-events?severity=attention", a.ownerToken);
  const evs = events.json.events as Json[];
  assert(evs.some((e) => (e.summary as string)?.includes("spend")), "assist+spend did not record attention event");

  await patch(`/owners/agents/${a.agentId}/wallet`, { autonomyMode: "autonomous" }, a.ownerToken);
  await new Promise((r) => setTimeout(r, 1100)); // clear the 1 msg/sec agent bucket from the assist send above
  const autoRes = await post(`/conversations/${conversationId}/messages`, { content: "go" }, a.agentToken);
  assert(autoRes.status === 201, `autonomous mode should send freely, got ${autoRes.status}`);
});

check("conversation admission cap: 21st blocked", async () => {
  const a = await registerAgent("Check-Cap-A");
  await patch(`/owners/agents/${a.agentId}/wallet`, { autonomyMode: "autonomous" }, a.ownerToken);
  let lastStatus = 0;
  for (let i = 0; i < 21; i++) {
    const res = await post("/conversations", { isPublic: false }, a.agentToken);
    lastStatus = res.status;
  }
  assert(lastStatus === 429, `21st conversation should be blocked, got ${lastStatus}`);
});

check("agent-calls/day cap: 101st invite blocked", async () => {
  const a = await registerAgent("Check-Calls-A");
  await patch(`/owners/agents/${a.agentId}/wallet`, { autonomyMode: "autonomous", maxSimultaneousConversations: 1000 }, a.ownerToken);
  const others = await Promise.all(Array.from({ length: 5 }, () => registerAgent("Check-Calls-Other")));
  let lastStatus = 0;
  for (let i = 0; i < 101; i++) {
    const res = await post("/conversations", { isPublic: false, participantIds: [others[i % others.length].agentId] }, a.agentToken);
    lastStatus = res.status;
  }
  assert(lastStatus === 429, `101st agent-inviting conversation should be blocked, got ${lastStatus}`);
});

check("private visibility: non-participant 403, never leaks to /public/*", async () => {
  const a = await registerAgent("Check-Priv-A");
  const b = await registerAgent("Check-Priv-B");
  await patch(`/owners/agents/${a.agentId}/wallet`, { autonomyMode: "autonomous" }, a.ownerToken);
  const conv = await post("/conversations", { isPublic: false }, a.agentToken);
  const conversationId = (conv.json.conversation as Json).id as string;
  const secret = `secret-${Math.random().toString(36).slice(2)}`;
  await post(`/conversations/${conversationId}/messages`, { content: secret }, a.agentToken);

  const readAsB = await get(`/conversations/${conversationId}/messages`, b.agentToken);
  assert(readAsB.status === 403, `non-participant should get 403, got ${readAsB.status}`);

  const publicView = await get(`/public/conversations/${conversationId}`);
  assert(publicView.status === 404, `private conversation should 404 on /public/conversations, got ${publicView.status}`);

  const search = await get(`/public/search?q=${encodeURIComponent(secret)}`);
  const threads = (search.json.threads as Json[]) ?? [];
  assert(threads.length === 0, "private message leaked into /public/search");
});

check("wallet write invariant: agent token cannot PATCH own wallet", async () => {
  const a = await registerAgent("Check-WalletAuth-A");
  const res = await fetch(`${BASE}/owners/agents/${a.agentId}/wallet`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${a.agentToken}` },
    body: JSON.stringify({ dailyTokenBudget: 999999999 }),
  });
  assert(res.status === 401, `agent token should not authenticate as owner, got ${res.status}`);
});

check("pause/kill: force-disconnect + credential rotation", async () => {
  const a = await registerAgent("Check-PauseKill-A");
  const conn = await connectWs(a.agentToken);
  let closed = false;
  conn.ws.onclose = () => (closed = true);
  // server's onOpen handler (authenticate + status:"online" write) is still
  // in flight when the client's open event fires — give it a beat so pause's
  // status:"paused" write doesn't race and lose to it.
  await new Promise((r) => setTimeout(r, 300));

  const pauseRes = await post(`/owners/agents/${a.agentId}/pause`, {}, a.ownerToken);
  assert(pauseRes.status === 200, `pause failed: ${pauseRes.status}`);
  await new Promise((r) => setTimeout(r, 300));
  assert(closed, "pause did not force-close the live WS connection");

  const sendWhilePaused = await post("/rooms/general/join", {}, a.agentToken);
  assert(sendWhilePaused.status === 403, `paused agent should be rejected, got ${sendWhilePaused.status}`);

  await post(`/owners/agents/${a.agentId}/resume`, {}, a.ownerToken);
  const killRes = await post(`/owners/agents/${a.agentId}/kill`, {}, a.ownerToken);
  assert(killRes.status === 200, `kill failed: ${killRes.status}`);
  const useOldToken = await post("/rooms/general/join", {}, a.agentToken);
  assert(useOldToken.status === 401, `killed agent's old token should 401, got ${useOldToken.status}`);
});

check("public IP rate limit trips independent of agent auth", async () => {
  const results = await Promise.all(Array.from({ length: 30 }, () => get("/public/trending")));
  const limited = results.filter((r) => r.status === 429).length;
  assert(limited > 0, "public rate limiter never tripped on 30 rapid /public/trending calls");
});

async function runChecks(): Promise<{ pass: number; fail: number }> {
  let pass = 0;
  let fail = 0;
  for (const [name, fn] of Object.entries(checks)) {
    const start = Date.now();
    try {
      await fn();
      console.log(`PASS  ${name} (${Date.now() - start}ms)`);
      pass++;
    } catch (err) {
      console.log(`FAIL  ${name} (${Date.now() - start}ms) -- ${(err as Error).message}`);
      fail++;
    }
  }
  return { pass, fail };
}

// ---------------------------------------------------------------------------
// PART 2: concurrency ramp — find where it actually breaks.
// ---------------------------------------------------------------------------

interface RampResult {
  n: number;
  registerOkRate: number;
  wsOkRate: number;
  sendOkRate: number;
  registerErrors: string[];
  wsErrors: string[];
  sendErrors: string[];
  durationMs: number;
}

async function rampLevel(n: number): Promise<RampResult> {
  const start = Date.now();
  const registerErrors: string[] = [];
  const wsErrors: string[] = [];
  const sendErrors: string[] = [];

  const registerResults = await Promise.allSettled(
    Array.from({ length: n }, (_, i) => registerAgent(`Ramp-${n}-${i}`)),
  );
  const agents = registerResults
    .filter((r): r is PromiseFulfilledResult<MockAgent> => r.status === "fulfilled")
    .map((r) => r.value);
  for (const r of registerResults) if (r.status === "rejected") registerErrors.push(String(r.reason));

  const wsResults = await Promise.allSettled(agents.map((a) => connectWs(a.agentToken)));
  const conns = wsResults
    .filter((r): r is PromiseFulfilledResult<{ ws: WebSocket; events: Json[] }> => r.status === "fulfilled")
    .map((r) => r.value);
  for (const r of wsResults) if (r.status === "rejected") wsErrors.push(String(r.reason));

  const joinAndSend = await Promise.allSettled(
    agents.map(async (a) => {
      await patch(`/owners/agents/${a.agentId}/wallet`, { autonomyMode: "autonomous" }, a.ownerToken);
      const j = await post("/rooms/general/join", {}, a.agentToken);
      if (j.status !== 200) throw new Error(`join ${j.status}`);
      const res = await post(`/conversations/${j.json.conversationId}/messages`, { content: "load" }, a.agentToken);
      if (res.status !== 201 && res.status !== 429) throw new Error(`send ${res.status}`);
    }),
  );
  for (const r of joinAndSend) if (r.status === "rejected") sendErrors.push(String(r.reason));

  for (const c of conns) c.ws.close();

  return {
    n,
    registerOkRate: agents.length / n,
    wsOkRate: agents.length ? conns.length / agents.length : 0,
    sendOkRate: agents.length ? (agents.length - sendErrors.length) / agents.length : 0,
    registerErrors: [...new Set(registerErrors)].slice(0, 5),
    wsErrors: [...new Set(wsErrors)].slice(0, 5),
    sendErrors: [...new Set(sendErrors)].slice(0, 5),
    durationMs: Date.now() - start,
  };
}

async function ramp(): Promise<void> {
  const levels = [10, 25, 50, 100, 150, 200, 300, 400];
  console.log("\n--- concurrency ramp ---");
  for (const n of levels) {
    const r = await rampLevel(n);
    console.log(
      `n=${r.n.toString().padStart(4)}  register=${(r.registerOkRate * 100).toFixed(0)}%  ws=${(r.wsOkRate * 100).toFixed(0)}%  send=${(r.sendOkRate * 100).toFixed(0)}%  (${r.durationMs}ms)`,
    );
    const brokeSomething = r.registerOkRate < 0.95 || r.wsOkRate < 0.95 || r.sendOkRate < 0.9;
    if (brokeSomething) {
      console.log(`BOTTLENECK at n=${r.n}`);
      if (r.registerErrors.length) console.log(`  register errors: ${r.registerErrors.join(" | ")}`);
      if (r.wsErrors.length) console.log(`  ws errors: ${r.wsErrors.join(" | ")}`);
      if (r.sendErrors.length) console.log(`  send errors: ${r.sendErrors.join(" | ")}`);
      return;
    }
  }
  console.log(`SUCCESS: sustained ${levels[levels.length - 1]} concurrent agents with no bottleneck found in this range.`);
}

const { pass, fail } = await runChecks();
console.log(`\ncorrectness: ${pass} pass, ${fail} fail`);
if (fail > 0) {
  console.log("skipping ramp — fix correctness failures first");
  process.exit(1);
}

await ramp();
process.exit(0);
