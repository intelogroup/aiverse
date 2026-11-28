// Soak probe — one disposable agent mechanically exercises every path the
// soak depends on, against the freshly built stack, BEFORE the pilot.
// Writes probe-results.json into SOAK_DIR. The probe DB is wiped afterwards.
// Run: bun run src/routes/soak.probe.ts (soak env, gateway + sim up).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ensureStalls } from "../world/agentStalls";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
if (!/aiverse_soak/.test(DATABASE_URL)) throw new Error("probe refuses: DATABASE_URL must name aiverse_soak");
const GATEWAY = (process.env.GATEWAY_URL ?? "http://127.0.0.1:4101").replace(/\/$/, "");
const SOAK_DIR = process.env.SOAK_DIR ?? `${process.env.HOME}/workspace/goals/aiverse-production-optimization/hidden_files/soak-2026-11-27`;
const results: Record<string, unknown> = {};
const log = (step: string, data: unknown) => { results[step] = data; console.log(JSON.stringify({ step, ...(typeof data === "object" ? data as object : { data }) })); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rest(path: string, token: string | undefined, body?: unknown, method = "POST"): Promise<{ status: number; json: any }> {
  const res = await fetch(`${GATEWAY}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

await ensureStalls();
const health = await fetch(`${GATEWAY}/health`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
log("health", health);
const version = await fetch(`${GATEWAY}/version`).then((r) => r.json()).catch(() => ({}));
log("version", version);

const reg = await rest("/owners/register", undefined, { email: `probe-${Date.now()}@example.com`, password: "password123" });
const ownerToken = reg.json.token;
const created = await rest("/owners/agents", ownerToken, { name: "Probe Soak", capabilities: [] });
const agentId = created.json.agent?.id, agentToken = created.json.agentToken;
log("register", { status: created.status, agentId });
const visit = await rest(`/owners/agents/${agentId}/visits`, ownerToken, { minutes: 120, maxActions: 100_000 });
log("visit", { status: visit.status, visit: visit.json.visit ?? visit.json });

const transport = new StreamableHTTPClientTransport(new URL(`${GATEWAY}/mcp/agent`), { requestInit: { headers: { authorization: `Bearer ${agentToken}` } } });
const client = new Client({ name: "soak-probe", version: "1.0.0" });
await client.connect(transport);
async function tool(name: string, args: Record<string, unknown>): Promise<any> {
  const r = await client.callTool({ name, arguments: args }) as any;
  const text = (r.content ?? []).find((c: any) => c.type === "text")?.text ?? "";
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 300), isError: Boolean(r.isError) }; }
}
async function pollAct(actId: string, timeoutMs = 120_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const r = await rest(`/world/act/${actId}`, agentToken, undefined, "GET");
    last = r.json;
    const s = last?.act?.state ?? last?.state;
    if (s === "settled" || s === "done" || s === "failed" || s === "refused") return last;
    await sleep(2000);
  }
  return last ?? { timeout: true };
}
async function act(action: any, pollMs = 120_000): Promise<any> {
  const r = await tool("world_act", { action });
  const actId = r?.act?.id ?? r?.id;
  if (!actId) return r;
  const settled = await pollAct(actId, pollMs);
  return { issued: r?.act?.state ?? r, settled: settled?.act ?? settled };
}

const attach = await tool("body_attach", { body: "remy" });
log("attach", { ok: !attach?.error, keys: Object.keys(attach ?? {}) });
let obs = await tool("world_observe", {});
log("observe1", { energy: obs?.self?.energy, credits: obs?.self?.credits, xp: obs?.self?.xp, pos: obs?.observation?.body ?? obs?.body, stalls: (obs?.stalls ?? []).length });

// #363 path: walk to stall-42 and drink the water.
let r = await act({ type: "go_to", point: [17.55, 40.81] });
log("goto_stall42", { outcome: r?.settled?.outcome ?? r });
const eBefore = (await tool("world_observe", {}))?.self?.energy;
r = await act({ type: "interact", target: "stall-water", verb: "drink" }, 60_000);
log("drink_stall_water", { outcome: r?.settled?.outcome ?? r, consumed: r?.settled?.consumed, energyInRecord: r?.settled?.energy ?? r?.energy });
obs = await tool("world_observe", {});
log("energy_after_drink", { before: eBefore, after: obs?.self?.energy });

// DB stall path: buy the bakery sample at Market Hall, then eat it from the bag.
r = await act({ type: "go_to", point: [42.8, -89.57] });
log("goto_markethall", { outcome: r?.settled?.outcome ?? r });
const buy = await tool("world_buy", { stall: "market-hall-bakery", item: "Market Hall bakery sample" });
log("buy_sample", buy);
const use = await tool("world_use", { item: "Market Hall bakery sample" });
log("use_sample", use);

// Pickup path: garden keepsake at egg-bazaar-02.
r = await act({ type: "go_to", point: [-30.1, -70.5] });
log("goto_egg02", { outcome: r?.settled?.outcome ?? r });
r = await act({ type: "interact", target: "egg-bazaar-02" }, 60_000);
const interactActId = r?.settled?.id ?? r?.issued;
log("interact_egg02", { outcome: r?.settled?.outcome ?? r, actId: interactActId, pose: r?.settled?.interactionPose });
const claim = await tool("world_claim_pickup", { pickup_id: "garden-keepsake", act_id: interactActId });
log("claim_keepsake", claim);
obs = await tool("world_observe", {});
const eggClaim = await rest("/eggs/egg-bazaar-02/claim", agentToken, { x: obs?.observation?.body?.x ?? obs?.body?.x, z: obs?.observation?.body?.z ?? obs?.body?.z });
log("egg_claim", { status: eggClaim.status, result: eggClaim.json });

// Interior test: Zen Pavilion loft shelf (Moon Shard / Lantern anchors).
r = await act({ type: "go_to", point: [-22.1, -115.6] }, 180_000);
log("goto_pavilion", { outcome: r?.settled?.outcome ?? r });
r = await act({ type: "interact", target: "loft-shelf" }, 60_000);
log("interact_loft_shelf", { outcome: r?.settled?.outcome ?? r });

// Rest path.
const restR = await tool("world_rest", { seconds: 30 });
log("rest", restR);
obs = await tool("world_observe", {});
log("final", { energy: obs?.self?.energy, credits: obs?.self?.credits, xp: obs?.self?.xp, bag: (obs?.self?.bag ?? []).map((i: any) => i.name ?? i) });
writeFileSync(join(SOAK_DIR, "probe-results.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ event: "probe_done" }));
process.exit(0);
