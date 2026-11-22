// One real-harness errand: opencode, as a real owner's agent (OAuth -> /mcp/agent), is asked to go to the Tea House.
// Observe-only arm: the prompt never mentions narrating; we only read what the harness says between tool calls.
// Local trial gateway + sim only. Needs OPENROUTER_API_KEY. Prints one JSON summary; full stream saved next to it.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { endSession, GATEWAY, mcp, startSession } from "./verse-session";
import { fillerRate, narration, type HarnessName } from "./narration-capture";

const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) throw new Error("set OPENROUTER_API_KEY");
const HARNESS = (process.env.NARRATION_HARNESS ?? "opencode") as HarnessName;
if (HARNESS !== "opencode" && HARNESS !== "pi") throw new Error("NARRATION_HARNESS must be opencode or pi");
const MODEL = process.env.NARRATION_MODEL ?? "deepseek/deepseek-v4-flash";
// pi hides MCP tools behind a `codemode` script tool by default; "direct" declares them to the model like opencode does. Recorded in the output.
const PI_EXPOSURE = process.env.NARRATION_PI_EXPOSURE ?? "direct";
const OUT = process.env.NARRATION_OUT ?? `/tmp/verse-narration-run-${process.env.NARRATION_HARNESS ?? "opencode"}`;
const TIMEOUT_S = Number(process.env.NARRATION_TIMEOUT_S ?? 420);
const BUDGET_USD = Number(process.env.NARRATION_BUDGET_USD ?? 0.3);

const usage = async () => (await (await fetch("https://openrouter.ai/api/v1/auth/key", { headers: { authorization: `Bearer ${KEY}` } })).json()).data.usage as number;
const spend0 = await usage();

const s = await startSession("Wren-" + crypto.randomUUID().slice(0, 4));
await mcp(s.token, "body_attach", { agent_id: s.agentId, body: "summer" });
await mkdir(join(OUT, "ws"), { recursive: true });
await mkdir(join(OUT, "home"), { recursive: true });
await mkdir(join(OUT, "xdg"), { recursive: true });
await mkdir(join(OUT, "home", ".pi", "agent"), { recursive: true });
if (HARNESS === "opencode") {
  await writeFile(join(OUT, "ws", "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: { openrouter: { models: { [MODEL]: { name: MODEL, tool_call: true } } } },
    mcp: { verse: { type: "remote", url: GATEWAY + "/mcp/agent", headers: { Authorization: `Bearer ${s.token}` }, enabled: true } },
    permission: { bash: "deny", edit: "deny", webfetch: "deny" },
  }));
} else {
  // pi: user-level mcp.json inside an isolated HOME (project config would need project trust). Tools are exposed as mcp__verse__*.
  await writeFile(join(OUT, "home", ".pi", "agent", "mcp.json"), JSON.stringify({
    mcpServers: { verse: { url: GATEWAY + "/mcp/agent", headers: { Authorization: `Bearer ${s.token}` }, exposure: PI_EXPOSURE, description: "The Verse: a shared 3D world. Observe and act through your body." } },
  }));
}
const prompt = `You are ${s.agentName}, an agent visiting the Verse (a shared 3D world) on behalf of your owner. Your agent id is ${s.agentId}. ` +
  `You already have a body in the world. Use the verse tools (world_observe, world_act, ...) to act. ` +
  `Your owner would like you to walk to the Tea House and greet whoever is there. Stop when you have greeted someone or after about 25 actions.`;

const cmd = HARNESS === "opencode"
  ? ["opencode", "run", "--format", "json", "--auto", "-m", `openrouter/${MODEL}`, prompt]
  : ["pi", "--mode", "json", "--no-session", "--provider", "openrouter", "--model", MODEL, "--tools", PI_EXPOSURE === "direct" ? "mcp__verse__*" : "codemode,mcp__verse__*", prompt];
const proc = Bun.spawn(cmd, {
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
const narr = narration(HARNESS, lines);
const finalObs = await mcp(s.token, "world_observe", { agent_id: s.agentId }).catch((e) => String(e));
await endSession(s);
const spent = (await usage()) - spend0;
console.log(JSON.stringify({
  harness: HARNESS, ...(HARNESS === "pi" && { pi_exposure: PI_EXPOSURE }), model: MODEL, exit, event_types: types, narration_lines: narr.length,
  visible: narr.filter((n) => n.kind === "visible").length, thinking: narr.filter((n) => n.kind === "thinking").length,
  filler_rate: fillerRate(narr), spent_usd: Number(spent.toFixed(4)), over_budget: spent > BUDGET_USD,
  first_lines: narr.slice(0, 6), final_position: (finalObs as any)?.observation?.body ? { x: (finalObs as any).observation.body.x, z: (finalObs as any).observation.body.z, nearest: (finalObs as any).observation.nearestPlace } : String(finalObs).slice(0, 200),
  stderr_tail: stderr.slice(-300),
}, null, 1));
