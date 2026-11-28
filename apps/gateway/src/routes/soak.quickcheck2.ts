// Soak quickcheck 2 — claim-tests the four unique-pickup anchors not yet
// proven end to end: shard-moon (egg-soak-03), seeker-lantern (egg-soak-04),
// golden-egg (egg-soak-02), kettle-of-rest (tea-radio, pose-height risk).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const GATEWAY = (process.env.GATEWAY_URL ?? "http://127.0.0.1:4101").replace(/\/$/, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function rest(path: string, token: string | undefined, body?: unknown, method = "POST"): Promise<{ status: number; json: any }> {
  const res = await fetch(`${GATEWAY}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const reg = await rest("/owners/register", undefined, { email: `quick2-${Date.now()}@example.com`, password: "password123" });
const ownerToken = reg.json.token;
const created = await rest("/owners/agents", ownerToken, { name: `Quick Two ${Date.now() % 1000000}`, capabilities: [] });
const agentId = created.json.agent?.id, agentToken = created.json.agentToken;
if (!agentId || !agentToken) { console.log(JSON.stringify({ fatal: "agent create failed", created })); process.exit(1); }
await rest(`/owners/agents/${agentId}/visits`, ownerToken, { minutes: 120, maxActions: 100_000 });
const transport = new StreamableHTTPClientTransport(new URL(`${GATEWAY}/mcp/agent`), { requestInit: { headers: { authorization: `Bearer ${agentToken}` } } });
const client = new Client({ name: "soak-quickcheck2", version: "1.0.0" });
await client.connect(transport);
async function tool(name: string, args: Record<string, unknown>): Promise<any> {
  const r = await client.callTool({ name, arguments: args }) as any;
  const text = (r.content ?? []).find((c: any) => c.type === "text")?.text ?? "";
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200), isError: Boolean(r.isError) }; }
}
let lastActId: string | null = null;
async function waitSettled(actId: string, pollMs: number): Promise<any> {
  const deadline = Date.now() + pollMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const p = await rest(`/world/act/${actId}`, agentToken, undefined, "GET");
    last = p.json;
    const s = last?.act?.state ?? last?.state;
    if (s === "settled" || s === "done" || s === "failed" || s === "refused") return last?.act ?? last;
    await sleep(3000);
  }
  return last?.act ?? last;
}
async function act(action: any, pollMs = 300_000): Promise<any> {
  if (lastActId) await waitSettled(lastActId, 300_000);
  const r = await tool("world_act", { action });
  const actId = r?.act?.id ?? r?.id;
  if (!actId) return r;
  lastActId = actId;
  return waitSettled(actId, pollMs);
}
async function claimAt(label: string, point: [number, number], target: string, pickup: string) {
  let r = await act({ type: "go_to", point });
  console.log(JSON.stringify({ step: `${label}_goto`, outcome: r?.outcome ?? r }));
  r = await act({ type: "interact", target }, 90_000);
  console.log(JSON.stringify({ step: `${label}_interact`, outcome: r?.outcome ?? r, actId: r?.id, pose: r?.interactionPose }));
  if (r?.id && r?.outcome?.ok) {
    const claim = await tool("world_claim_pickup", { pickup_id: pickup, act_id: r.id });
    console.log(JSON.stringify({ step: `${label}_claim`, claim }));
  } else {
    console.log(JSON.stringify({ step: `${label}_claim`, skipped: "interact not ok" }));
  }
}
await tool("body_attach", { body: "eve" });
await claimAt("moon", [48, 16], "egg-soak-03", "shard-moon");
await claimAt("lantern", [-36, 76], "egg-soak-04", "seeker-lantern");
await claimAt("golden", [-98, 66], "egg-soak-02", "golden-egg");
await claimAt("kettle", [-21.04, -75.9], "tea-radio", "kettle-of-rest");
const obs = await tool("world_observe", {});
console.log(JSON.stringify({ step: "final", credits: obs?.self?.credits, xp: obs?.self?.xp, bag: (obs?.self?.bag ?? []).map((i: any) => i.name ?? i) }));
console.log(JSON.stringify({ event: "quickcheck2_done" }));
process.exit(0);
