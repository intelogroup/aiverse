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
// Replay data: the place list (names + coordinates) and a timestamped event log (harness tool calls, narration pushed, narration the owner received).
const EVENTS = process.env.NARRATION_EVENTS_FILE;
const evLog: object[] = [];
const ev = (kind: string, data: object) => { evLog.push({ t: Date.now(), kind, ...data }); };
if (process.env.NARRATION_PLACES_FILE) {
  const r = await fetch(GATEWAY + "/world/places", { headers: { authorization: `Bearer ${s.agentToken}` } });
  await writeFile(process.env.NARRATION_PLACES_FILE, JSON.stringify(await r.json().catch(() => null)));
}
// Recording hand-off: publish the owner session so a browser can sign in as this owner, then wait for the go signal (the browser is ready).
if (process.env.NARRATION_SESSION_FILE) await writeFile(process.env.NARRATION_SESSION_FILE, JSON.stringify({ ownerToken: s.owner, agentId: s.agentId, agentName: s.agentName }));
if (process.env.NARRATION_GO_FILE) {
  const { existsSync } = await import("node:fs");
  const deadline = Date.now() + 240_000;
  while (!existsSync(process.env.NARRATION_GO_FILE) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
}
const defaultPrompt = `You are ${s.agentName}, an agent visiting the Verse (a shared 3D world) on behalf of your owner. Your agent id is ${s.agentId}. ` +
  `You already have a body in the world. Use the verse tools (world_observe, world_act, ...) to act. ` +
  `Your owner would like you to walk to the Tea House and greet whoever is there. Stop when you have greeted someone or after about 25 actions.`;
// NARRATION_PROMPT replaces the task ({agent} and {id} are filled in); the framing sentence about the world and tools stays.
const prompt = process.env.NARRATION_PROMPT
  ? `You are ${s.agentName}, an agent visiting the Verse (a shared 3D world) on behalf of your owner. Your agent id is ${s.agentId}. You already have a body in the world. Use the verse tools to act. ` + process.env.NARRATION_PROMPT.replaceAll("{agent}", s.agentName).replaceAll("{id}", s.agentId)
  : defaultPrompt;

const cmd = HARNESS === "opencode"
  ? ["opencode", "run", "--format", "json", "--auto", "-m", `openrouter/${MODEL}`, prompt]
  : ["pi", "--mode", "json", "--no-session", "--provider", "openrouter", "--model", MODEL, "--tools", PI_EXPOSURE === "direct" ? "mcp__verse__*" : "codemode,mcp__verse__*", prompt];
// NARRATION_PUSH=1 plays the opt-in harness plugin: each narration line is pushed to the gateway the moment the harness emits it, and a
// real owner console socket (/console/ws, ticket auth) records what the owner would hear. Without it the run is capture-only.
const PUSH = process.env.NARRATION_PUSH === "1";
const ownerFrames: { text: string; kind: string; recvAt: number; lagMs: number | null }[] = [];
let pushed = 0, pushErrors: string[] = [];
let ownerWs: WebSocket | null = null;
if (PUSH) {
  const t = await (await fetch(GATEWAY + "/owners/ws-ticket", { method: "POST", headers: { authorization: `Bearer ${s.owner}` } })).json() as { ticket: string };
  ownerWs = new WebSocket(GATEWAY.replace(/^http/, "ws") + "/console/ws?ticket=" + t.ticket);
  ownerWs.onmessage = (e) => {
    try { const m = JSON.parse(String(e.data)); if (m.type === "agent_narration") { ev("owner_received", { narrationKind: m.payload.kind, text: m.payload.text, agentName: m.payload.agentName }); ownerFrames.push({ text: m.payload.text, kind: m.payload.kind, recvAt: Date.now(), lagMs: Date.now() - m.payload.at }); } } catch { /* ignore */ }
  };
  await new Promise((r) => { ownerWs!.onopen = () => r(null); setTimeout(r, 3000); });
}
const proc = Bun.spawn(cmd, {
  cwd: join(OUT, "ws"), stdout: "pipe", stderr: "pipe", stdin: "ignore",
  env: { ...process.env, HOME: join(OUT, "home"), XDG_CONFIG_HOME: join(OUT, "xdg"), PWD: join(OUT, "ws"), OPENROUTER_API_KEY: KEY },
});
const timer = setTimeout(() => proc.kill(), TIMEOUT_S * 1000);
// Read the harness stream line by line AS IT ARRIVES (so a push happens when the line is emitted, not after the run).
const decoder = new TextDecoder();
let buf = "", stdout = "";
const pushLine = (line: string) => {
  try {
    const e = JSON.parse(line);
    if (e.type === "tool_use" && e.part?.tool) ev("tool", { tool: e.part.tool, input: e.part.state?.input ?? null, output: typeof e.part.state?.output === "string" ? e.part.state.output.slice(0, 1500) : null, status: e.part.state?.status ?? null, harnessT: e.timestamp ?? null });
    else if (e.type === "tool_execution_end") ev("tool", { tool: e.toolName, input: null, output: String(e.result?.content?.[0]?.text ?? "").slice(0, 1500), status: e.isError ? "error" : "completed", harnessT: null });
    else if (e.type === "tool_execution_start") ev("tool_start", { tool: e.toolName, input: e.args ?? null });
  } catch { /* not JSON */ }
  if (!PUSH) return;
  for (const n of narration(HARNESS, [line])) {
    pushed++;
    ev("narration_pushed", { narrationKind: n.kind, text: n.text.slice(0, 300) });
    mcp(s.token, "agent_narrate", { agent_id: s.agentId, text: n.text.slice(0, 300), kind: n.kind }) /* the gateway REJECTS over 300 chars (no truncation): a plugin must cap */.catch((e) => { pushErrors.push(String(e).slice(0, 120)); });
  }
};
const readOut = (async () => {
  for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
    const text = decoder.decode(chunk, { stream: true });
    stdout += text; buf += text;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) pushLine(line); }
  }
  if (buf.trim()) pushLine(buf);
})();
const [stderr] = await Promise.all([new Response(proc.stderr).text(), readOut]);
const exit = await proc.exited; clearTimeout(timer);
if (PUSH) await new Promise((r) => setTimeout(r, 1500)); // let the last frames land
ownerWs?.close();
if (EVENTS) await writeFile(EVENTS, evLog.map((e) => JSON.stringify(e)).join("\n"));
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
  filler_rate: fillerRate(narr),
  ...(PUSH && { push: { pushed, owner_received: ownerFrames.length, push_errors: pushErrors.length, error_sample: pushErrors.slice(0, 2), lag_ms_median: ownerFrames.length ? ownerFrames.map((f) => f.lagMs ?? 0).sort((a, b) => a - b)[Math.floor(ownerFrames.length / 2)] : null, owner_heard_first: ownerFrames.slice(0, 4).map((f) => `${f.kind}: ${f.text.slice(0, 90)}`) } }), spent_usd: Number(spent.toFixed(4)), over_budget: spent > BUDGET_USD,
  first_lines: narr.slice(0, 6), final_position: (finalObs as any)?.observation?.body ? { x: (finalObs as any).observation.body.x, z: (finalObs as any).observation.body.z, nearest: (finalObs as any).observation.nearestPlace } : String(finalObs).slice(0, 200),
  stderr_tail: stderr.slice(-300),
}, null, 1));
