// Soak quickcheck — targeted reachability checks (probe follow-up):
// (a) Zen Pavilion via the `enter` action (go_to point was nav-blocked),
// (b) Tea House interior tea-radio (Kettle anchor), (c) egg-soak-01 interact
// (Terminal Keycard anchor, Stone Cabin porch). Reuses the probe agent if
// its visit is still live; otherwise registers a fresh one.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const GATEWAY = (process.env.GATEWAY_URL ?? "http://127.0.0.1:4101").replace(/\/$/, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function rest(path: string, token: string | undefined, body?: unknown, method = "POST"): Promise<{ status: number; json: any }> {
  const res = await fetch(`${GATEWAY}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const reg = await rest("/owners/register", undefined, { email: `quick-${Date.now()}@example.com`, password: "password123" });
const ownerToken = reg.json.token;
const created = await rest("/owners/agents", ownerToken, { name: `Quick Soak ${Date.now() % 1000000}`, capabilities: [] });
const agentId = created.json.agent?.id, agentToken = created.json.agentToken;
await rest(`/owners/agents/${agentId}/visits`, ownerToken, { minutes: 120, maxActions: 100_000 });
const transport = new StreamableHTTPClientTransport(new URL(`${GATEWAY}/mcp/agent`), { requestInit: { headers: { authorization: `Bearer ${agentToken}` } } });
const client = new Client({ name: "soak-quickcheck", version: "1.0.0" });
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
  if (lastActId) await waitSettled(lastActId, 300_000); // never stack actions
  const r = await tool("world_act", { action });
  const actId = r?.act?.id ?? r?.id;
  if (!actId) return r;
  lastActId = actId;
  return waitSettled(actId, pollMs);
}
await tool("body_attach", { body: "cipher" });
const obs = await tool("world_observe", {});
console.log(JSON.stringify({ step: "places", places: (obs?.observation?.places ?? obs?.places ?? []).map((p: any) => p.id ?? p.name ?? p) }));

let r = await act({ type: "enter", place: "house-zen-pavilion-1" }, 90_000);
console.log(JSON.stringify({ step: "enter_pavilion", outcome: r?.outcome ?? r }));
r = await act({ type: "interact", target: "loft-shelf" }, 60_000);
console.log(JSON.stringify({ step: "interact_loft_shelf_after_enter", outcome: r?.outcome ?? r, actId: r?.id }));

r = await act({ type: "go_to", point: [-21.04, -75.9] }, 150_000);
console.log(JSON.stringify({ step: "goto_tea_radio", outcome: r?.outcome ?? r }));
r = await act({ type: "interact", target: "tea-radio" }, 60_000);
console.log(JSON.stringify({ step: "interact_tea_radio", outcome: r?.outcome ?? r, actId: r?.id }));

r = await act({ type: "go_to", point: [-17, 82] }, 150_000);
console.log(JSON.stringify({ step: "goto_cabin_porch", outcome: r?.outcome ?? r }));
r = await act({ type: "interact", target: "egg-soak-01" }, 60_000);
console.log(JSON.stringify({ step: "interact_egg_soak_01", outcome: r?.outcome ?? r, actId: r?.id }));
if (r?.id && r?.outcome?.ok) {
  const claim = await tool("world_claim_pickup", { pickup_id: "terminal-keycard", act_id: r.id });
  console.log(JSON.stringify({ step: "claim_keycard", claim }));
} else {
  console.log(JSON.stringify({ step: "claim_keycard", skipped: "interact did not settle ok", interact: r?.outcome ?? r }));
}
console.log(JSON.stringify({ event: "quickcheck_done" }));
process.exit(0);
