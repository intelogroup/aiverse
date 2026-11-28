// Soak verify — new-base (0bb5567df1ad) seeding re-verification.
// Claim-tests EVERY pickup in the seeded set with ONE throwaway agent:
// go_to the manifest position, interact the anchor, world_claim_pickup.
// The throwaway agent's footprint (claims, inventory, events, visits,
// agent, owner) is deleted afterwards by the operator, UUID-scoped —
// the global (non-perAgent) pickups must be unconsumed when the run starts.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const GATEWAY = (process.env.GATEWAY_URL ?? "http://127.0.0.1:4101").replace(/\/$/, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function rest(path: string, token: string | undefined, body?: unknown, method = "POST"): Promise<{ status: number; json: any }> {
  const res = await fetch(`${GATEWAY}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const reg = await rest("/owners/register", undefined, { email: `verify-${Date.now()}@example.com`, password: "password123" });
const ownerToken = reg.json.token;
const ownerId = reg.json.owner?.id ?? reg.json.id;
const created = await rest("/owners/agents", ownerToken, { name: `Verify Soak ${Date.now() % 1000000}`, capabilities: [] });
const agentId = created.json.agent?.id, agentToken = created.json.agentToken;
if (!agentId || !agentToken) { console.log(JSON.stringify({ fatal: "agent create failed", created })); process.exit(1); }
console.log(JSON.stringify({ event: "verify_agent", agentId, ownerId }));
await rest(`/owners/agents/${agentId}/visits`, ownerToken, { minutes: 180, maxActions: 100_000 });
const transport = new StreamableHTTPClientTransport(new URL(`${GATEWAY}/mcp/agent`), { requestInit: { headers: { authorization: `Bearer ${agentToken}` } } });
const client = new Client({ name: "soak-verify", version: "1.0.0" });
await client.connect(transport);
async function tool(name: string, args: Record<string, unknown>): Promise<any> {
  const r = await client.callTool({ name, arguments: args }) as any;
  const text = (r.content ?? []).find((c: any) => c.type === "text")?.text ?? "";
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 300), isError: Boolean(r.isError) }; }
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

// [pickup_id, target, go_to point [x, z], expected credits, expected xp]
const PICKUPS: [string, string, [number, number], number, number][] = [
  ["garden-keepsake", "egg-bazaar-02", [-30.1, -70.5], 3, 5],
  ["stone-cabin-tea-jar", "stone-cabin-tea-jar", [-19, 84], 3, 5],
  ["market-hall-bakery-sample", "market-hall-bakery-sample", [42.8, -90.65], 1, 2],
  ["shard-sun", "egg-bazaar-05", [42, 10], 15, 10],
  ["shard-leaf", "egg-bazaar-06", [-100, -68.5], 15, 10],
  ["shard-ember", "egg-bazaar-04", [-30.2, 70.9], 15, 10],
  ["shard-star", "egg-bazaar-01", [-12.6, 1], 15, 10],
  ["shard-moon", "egg-soak-03", [48, 16], 15, 10],
  ["seeker-lantern", "egg-soak-04", [-36, 76], 20, 15],
  ["kettle-of-rest", "tea-radio", [-21.04, -75.9], 20, 15],
  ["terminal-keycard", "egg-soak-01", [-17, 82], 25, 20],
  ["golden-egg", "egg-soak-02", [-98, 66], 50, 25],
  ["credit-cache", "egg-bazaar-03", [-28.65, -41.6], 10, 5],
  ["xp-cache", "egg-bazaar-02", [-30.1, -70.5], 0, 15],
];

await tool("body_attach", { body: "cipher" });
const results: Record<string, any> = {};
for (const [pickup, target, point, expCr, expXp] of PICKUPS) {
  try {
    let r = await act({ type: "go_to", point }, 240_000);
    const gotoOk = Boolean(r?.outcome?.ok);
    console.log(JSON.stringify({ step: `${pickup}_goto`, ok: gotoOk, outcome: r?.outcome ?? r }));
    r = await act({ type: "interact", target }, 90_000);
    const intOk = Boolean(r?.id && r?.outcome?.ok);
    console.log(JSON.stringify({ step: `${pickup}_interact`, ok: intOk, outcome: r?.outcome ?? r, pose: r?.interactionPose }));
    if (intOk) {
      const claim = await tool("world_claim_pickup", { pickup_id: pickup, act_id: r.id });
      const got = claim?.reward ?? claim?.result?.reward ?? claim;
      const cr = got?.credits, xp = got?.xp;
      const ok = cr === expCr && xp === expXp;
      results[pickup] = { ok, claim };
      console.log(JSON.stringify({ step: `${pickup}_claim`, ok, expected: { credits: expCr, xp: expXp }, claim }));
    } else {
      results[pickup] = { ok: false, stage: "interact", outcome: r?.outcome ?? r };
    }
  } catch (e: any) {
    results[pickup] = { ok: false, stage: "exception", error: String(e?.message ?? e) };
    console.log(JSON.stringify({ step: `${pickup}_exception`, error: String(e?.message ?? e) }));
  }
}
const obs = await tool("world_observe", {});
console.log(JSON.stringify({ step: "final", credits: obs?.self?.credits, xp: obs?.self?.xp, bag: (obs?.self?.bag ?? []).map((i: any) => i.name ?? i) }));
const passed = Object.entries(results).filter(([, v]) => v.ok).map(([k]) => k);
const failed = Object.entries(results).filter(([, v]) => !v.ok).map(([k]) => k);
console.log(JSON.stringify({ event: "verify_done", agentId, ownerId, passed, failed }));
process.exit(0);
