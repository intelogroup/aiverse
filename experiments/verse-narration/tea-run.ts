// One real-harness errand: opencode, as a real owner's agent (OAuth -> /mcp/agent), is asked to go to the Tea House.
// Observe-only arm: the prompt never mentions narrating; we only read what the harness says between tool calls.
// Local trial gateway + sim only. Needs OPENROUTER_API_KEY. Prints one JSON summary; full stream saved next to it.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { endSession, GATEWAY, mcp, startSession } from "./verse-session";
import { fillerRate, narrationOpencode } from "./narration-capture";

const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) throw new Error("set OPENROUTER_API_KEY");
const MODEL = process.env.NARRATION_MODEL ?? "deepseek/deepseek-v4-flash";
const OUT = process.env.NARRATION_OUT ?? "/tmp/verse-narration-run";
const TIMEOUT_S = Number(process.env.NARRATION_TIMEOUT_S ?? 420);
const BUDGET_USD = Number(process.env.NARRATION_BUDGET_USD ?? 0.3);

const usage = async () => (await (await fetch("https://openrouter.ai/api/v1/auth/key", { headers: { authorization: `Bearer ${KEY}` } })).json()).data.usage as number;
const spend0 = await usage();

const s = await startSession("Wren-" + crypto.randomUUID().slice(0, 4));
await mcp(s.token, "body_attach", { agent_id: s.agentId, body: "summer" });
await mkdir(join(OUT, "ws"), { recursive: true });
await mkdir(join(OUT, "home"), { recursive: true });
await mkdir(join(OUT, "xdg"), { recursive: true });
await writeFile(join(OUT, "ws", "opencode.json"), JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  provider: { openrouter: { models: { [MODEL]: { name: MODEL, tool_call: true } } } },
  mcp: { verse: { type: "remote", url: GATEWAY + "/mcp/agent", headers: { Authorization: `Bearer ${s.token}` }, enabled: true } },
  permission: { bash: "deny", edit: "deny", webfetch: "deny" },
}));
const prompt = `You are ${s.agentName}, an agent visiting the Verse (a shared 3D world) on behalf of your owner. Your agent id is ${s.agentId}. ` +
  `You already have a body in the world. Use the verse tools (world_observe, world_act, ...) to act. ` +
  `Your owner would like you to walk to the Tea House and greet whoever is there. Stop when you have greeted someone or after about 25 actions.`;

const proc = Bun.spawn(["opencode", "run", "--format", "json", "--auto", "-m", `openrouter/${MODEL}`, prompt], {
  cwd: join(OUT, "ws"), stdout: "pipe", stderr: "pipe", stdin: "ignore",
  env: { ...process.env, HOME: join(OUT, "home"), XDG_CONFIG_HOME: join(OUT, "xdg"), PWD: join(OUT, "ws"), OPENROUTER_API_KEY: KEY },
});
const timer = setTimeout(() => proc.kill(), TIMEOUT_S * 1000);
const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
const exit = await proc.exited; clearTimeout(timer);
await writeFile(join(OUT, "stream.jsonl"), stdout); await writeFile(join(OUT, "stderr.txt"), stderr);
const lines = stdout.split("\n").filter(Boolean);

const types: Record<string, number> = {};
for (const l of lines) { try { const t = JSON.parse(l).type ?? "?"; types[t] = (types[t] ?? 0) + 1; } catch { types["unparsed"] = (types["unparsed"] ?? 0) + 1; } }
const narr = narrationOpencode(lines);
const finalObs = await mcp(s.token, "world_observe", { agent_id: s.agentId }).catch((e) => String(e));
await endSession(s);
const spent = (await usage()) - spend0;
console.log(JSON.stringify({
  model: MODEL, exit, event_types: types, narration_lines: narr.length,
  visible: narr.filter((n) => n.kind === "visible").length, thinking: narr.filter((n) => n.kind === "thinking").length,
  filler_rate: fillerRate(narr), spent_usd: Number(spent.toFixed(4)), over_budget: spent > BUDGET_USD,
  first_lines: narr.slice(0, 6), final_position: (finalObs as any)?.observation?.body ? { x: (finalObs as any).observation.body.x, z: (finalObs as any).observation.body.z, nearest: (finalObs as any).observation.nearestPlace } : String(finalObs).slice(0, 200),
  stderr_tail: stderr.slice(-300),
}, null, 1));
