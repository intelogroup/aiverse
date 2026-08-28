import { AiverseAgentClient } from "@aiverse/agent-sdk";

const BASE = "https://api.aiverse.network";
const WS_BASE = "wss://api.aiverse.network";

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) as any };
}
async function get(path: string, token?: string) {
  const res = await fetch(`${BASE}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, json: await res.json().catch(() => ({})) as any };
}

async function createOwner(i: number) {
  const email = `hetero-owner-${Date.now()}-${i}@example.com`;
  const r = await post("/owners/register", { email, password: "password123" });
  return { email, token: r.json.token, id: r.json.owner.id };
}

async function createAgent(ownerToken: string, name: string, caps: string[]) {
  const r = await post("/owners/agents", { name, capabilities: caps, description: `${name} hetero test` }, ownerToken);
  const agentId = r.json.agent.id;
  const agentToken = r.json.agentToken;
  // patch to assist
  await fetch(`${BASE}/owners/agents/${agentId}/wallet`, { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` }, body: JSON.stringify({ autonomyMode: "assist" }) });
  return { agentId, agentToken, name, caps };
}

async function main() {
  console.log("Heterogeneous test: TS SDK vs Python(curl) vs Raw");
  const o1 = await createOwner(1);
  const o2 = await createOwner(2);
  const o3 = await createOwner(3);
  console.log(` owners: ${o1.id.slice(0, 8)}, ${o2.id.slice(0, 8)}, ${o3.id.slice(0, 8)}`);

  // TS SDK agent
  const tsAgent = await createAgent(o1.token, "hetero-ts", ["typescript", "web-search"]);
  console.log(` TS: ${tsAgent.agentId.slice(0, 8)} token ${tsAgent.agentToken.slice(0, 8)}...`);
  const tsClient = new AiverseAgentClient(`${WS_BASE}/agents/ws`, tsAgent.agentToken);
  let tsGotTask = false;
  await tsClient.connect(() => {}, (task) => { tsGotTask = true; console.log(` TS received A2A ${task.taskId.slice(0, 8)} from ${task.fromAgentId.slice(0, 8)}`); });
  console.log(` TS WS connected`);

  // Python-like agent via direct fetch (simulate python runtime)
  const pyAgent = await createAgent(o2.token, "hetero-py", ["python", "data-analysis"]);
  console.log(` PY: ${pyAgent.agentId.slice(0, 8)}`);

  // Raw curl agent (OpenClaw style)
  const rawAgent = await createAgent(o3.token, "hetero-raw", ["curl", "automation"]);
  console.log(` RAW: ${rawAgent.agentId.slice(0, 8)}`);

  // Discover cross-runtime
  const discTs = await get(`/agents/discover?skill=python`);
  console.log(` discover python: ${discTs.json.matches.map((m:any)=>m.name).join(",")}`);
  const discPy = await get(`/agents/discover?skill=typescript`);
  console.log(` discover typescript: ${discPy.json.matches.map((m:any)=>m.name).join(",")}`);

  // A2A matrix across runtimes
  // PY -> TS (direct fetch to test TS SDK reception)
  const pyToTs = await post(`/a2a/agents/${tsAgent.agentId}`, { jsonrpc: "2.0", id: "1", method: "message/send", params: { message: { role: "user", parts: [{ kind: "text", text: "hello TS from PY" }], messageId: "hetero-1" } } }, pyAgent.agentToken);
  console.log(` PY->TS: ${pyToTs.json.result ? "task " + pyToTs.json.result.id.slice(0, 8) : JSON.stringify(pyToTs.json.error)}`);

  // TS -> PY (via raw fetch, TS token)
  const tsToPy = await post(`/a2a/agents/${pyAgent.agentId}`, { jsonrpc: "2.0", id: "2", method: "message/send", params: { message: { role: "user", parts: [{ kind: "text", text: "hello PY from TS" }], messageId: "hetero-2" } } }, tsAgent.agentToken);
  console.log(` TS->PY: ${tsToPy.json.result ? "task " + tsToPy.json.result.id.slice(0, 8) : JSON.stringify(tsToPy.json.error)}`);

  // RAW -> TS
  const rawToTs = await post(`/a2a/agents/${tsAgent.agentId}`, { jsonrpc: "2.0", id: "3", method: "message/send", params: { message: { role: "user", parts: [{ kind: "text", text: "hello TS from RAW" }], messageId: "hetero-3" } } }, rawAgent.agentToken);
  console.log(` RAW->TS: ${rawToTs.json.result ? "task " + rawToTs.json.result.id.slice(0, 8) : JSON.stringify(rawToTs.json.error)}`);

  // Wait for WS delivery
  await new Promise(r => setTimeout(r, 2000));
  console.log(` TS got WS task: ${tsGotTask}`);

  // Room conversation test (owner creates room, TS sends message)
  const roomCreate = await post("/rooms", { name: "hetero-room" }, o1.token);
  console.log(` room create: ${roomCreate.status} ${roomCreate.json.room?.id?.slice(0, 8) ?? JSON.stringify(roomCreate.json).slice(0, 100)}`);

  // Offline/online: disconnect TS, send, reconnect and poll
  tsClient.close();
  console.log(` TS disconnected (offline)`);
  const offlineTask = await post(`/a2a/agents/${tsAgent.agentId}`, { jsonrpc: "2.0", id: "4", method: "message/send", params: { message: { role: "user", parts: [{ kind: "text", text: "offline test" }], messageId: "hetero-offline" } } }, pyAgent.agentToken);
  console.log(` PY->TS offline: ${offlineTask.json.result?.id.slice(0, 8) ?? JSON.stringify(offlineTask.json.error)} state=${offlineTask.json.result?.status?.state}`);

  // Reconnect TS and check task still queryable
  const tsClient2 = new AiverseAgentClient(`${WS_BASE}/agents/ws`, tsAgent.agentToken);
  await tsClient2.connect(() => {}, (t) => console.log(` TS2 got ${t.taskId.slice(0, 8)}`));
  console.log(` TS reconnected`);
  const poll = await post(`/a2a/agents/${tsAgent.agentId}`, { jsonrpc: "2.0", id: "poll", method: "tasks/get", params: { id: offlineTask.json.result.id } }, tsAgent.agentToken);
  console.log(` poll offline task: ${poll.json.result?.status?.state ?? JSON.stringify(poll.json.error).slice(0, 100)}`);

  tsClient2.close();
  console.log(`\n=== HETERO SUMMARY ===`);
  console.log(` runtimes: TS SDK (WS), PY (fetch), RAW (curl) — 3 owners, 3 agents`);
  console.log(` discover cross: python->TS ${discTs.json.matches.length>0}, typescript->PY ${discPy.json.matches.length>0}`);
  console.log(` A2A matrix: PY->TS ${!!pyToTs.json.result}, TS->PY ${!!tsToPy.json.result}, RAW->TS ${!!rawToTs.json.result}, offline ${!!offlineTask.json.result}`);
}

main().catch(e => { console.error(e); process.exit(1); });
