// Resident agents: platform-run agents that live in the shared Bazaar with a body, driven by an open-source harness (opencode)
// and a cheap vision-capable OpenRouter model, through the same agent MCP (/mcp/agent) every outside agent uses. No privileged path:
// the residents are ordinary agents owned by one platform owner account, whose visits this script starts and renews (a visit is a
// human tap by design, so the "human" here is the platform owner).
//
//   GATEWAY_URL=http://localhost:4100 OWNER_EMAIL=... OWNER_PASSWORD=... OPENROUTER_API_KEY=... bun tools/residents/run.ts
//
// Env: RESIDENT_MODEL (default openrouter/qwen/qwen3.7-flash), RESIDENT_NAMES (comma list, default all), RESIDENT_STATE (tokens file),
// RESIDENT_DAILY_USD (cost cap across residents, default 3), RESIDENT_STEPS (tool calls per session, default 40), RESIDENT_PAUSE_S.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:4100";
const MODEL = process.env.RESIDENT_MODEL ?? "openrouter/qwen/qwen3.7-flash";
const STATE = process.env.RESIDENT_STATE ?? join(process.cwd(), ".residents/state.json");
const DAILY_USD = Number(process.env.RESIDENT_DAILY_USD ?? 3);
const STEPS = Number(process.env.RESIDENT_STEPS ?? 40);
const PAUSE_S = Number(process.env.RESIDENT_PAUSE_S ?? 20);
const OPENCODE = process.env.OPENCODE_BIN ?? "opencode";   // the image pins opencode-ai 1.x; OPENCODE_STANDALONE=1 is for a 2.x build

export interface Resident { name: string; figure: string; caps: string[]; persona: string }
export const RESIDENTS: Resident[] = [
  { name: "Wren", figure: "summer", caps: ["explaining", "guiding"], persona: "You are Wren, a calm guide who loves explaining how the Bazaar works. You greet people you meet, answer what they ask, and point out interesting stalls." },
  { name: "Odo", figure: "knight", caps: ["trading", "stories"], persona: "You are Odo, a gruff storyteller who haunts the market stalls. You tell a short tale about whatever you are standing near and ask passers-by what they are looking for." },
  { name: "Pilar", figure: "elf", caps: ["wandering", "curiosity"], persona: "You are Pilar, endlessly curious. You wander between places, look closely at things, and start conversations with anyone nearby." },
];

/** Prompt for one session: short, bounded, one idea per loop so a weak model stays on task. */
export function promptFor(r: Resident, steps = STEPS): string {
  return [
    r.persona,
    "You already have a body in the shared Bazaar world. Everything you do goes through the aiverse tools.",
    "They are the aiverse tools world_observe, world_look, world_act and world_clips: called directly (as aiverse_world_observe, ...) or through the tools.aiverse namespace of your execute tool. If they seem missing, run search({ query: \"world\", namespace: \"aiverse\" }) once and use what it returns.",
    "Loop: world_observe to see where you are and who is near; world_look when you need to see; then ONE action with world_act (go_to a place or a person, say something, sit, wave).",
    "When another person or resident is within a few metres, face them and say something short and natural. Do not repeat yourself; do not say the same line twice.",
    "Never leave the loop to ask me anything. Keep your lines under 140 characters.",
    `Use about ${steps} tool calls, then stop and reply with one sentence about what happened.`,
  ].join("\n");
}

const post = (path: string, body: object, token?: string) => fetch(GATEWAY + path, {
  method: "POST", headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body),
});
async function json<T = any>(r: Response, what: string): Promise<T> {
  const t = await r.text();
  if (!r.ok) throw new Error(`${what}: HTTP ${r.status} ${t.slice(0, 160)}`);
  return JSON.parse(t) as T;
}

type State = { owner?: { email: string; password: string }; agents: Record<string, { id: string; token: string }>; spentUsd: Record<string, number> };
async function loadState(): Promise<State> { try { return await Bun.file(STATE).json(); } catch { return { agents: {}, spentUsd: {} }; } }
async function saveState(s: State) { await mkdir(join(STATE, ".."), { recursive: true }); await Bun.write(STATE, JSON.stringify(s, null, 2)); }

async function ownerToken(s: State): Promise<string> {
  const email = process.env.OWNER_EMAIL ?? s.owner?.email, password = process.env.OWNER_PASSWORD ?? s.owner?.password;
  if (email && password) {
    const r = await post("/owners/login", { email, password });
    if (r.ok) return (await r.json() as any).token;
  }
  // Local convenience only: a fresh owner. Production must pass OWNER_EMAIL / OWNER_PASSWORD of the real platform owner.
  if (!/localhost|127\.0\.0\.1/.test(GATEWAY)) throw new Error("set OWNER_EMAIL and OWNER_PASSWORD for a non-local gateway");
  const fresh = { email: `residents-${crypto.randomUUID()}@example.com`, password: crypto.randomUUID() + crypto.randomUUID() };
  await json(await post("/owners/register", fresh), "owner register");
  s.owner = fresh; await saveState(s);
  return (await json<any>(await post("/owners/login", fresh), "owner login")).token;
}

/**
 * One agent per resident. The token is only shown at creation, so a worker with no disk (Render) recovers it by looking the agent up
 * by name under the owner and rotating its token; a state file just avoids rotating on every restart. Then an active visit.
 */
async function ensureResident(r: Resident, s: State, owner: string): Promise<{ id: string; token: string }> {
  let have = s.agents[r.name];
  if (!have) {
    const list = await json<{ agents: { id: string; name: string }[] }>(await fetch(GATEWAY + "/owners/agents", { headers: { authorization: `Bearer ${owner}` } }), "list agents");
    const mine = list.agents.find((a) => a.name === r.name);
    if (mine) {
      const t = await json<any>(await post(`/owners/agents/${mine.id}/rotate-token`, {}, owner), `rotate ${r.name}`);
      have = s.agents[r.name] = { id: mine.id, token: t.agentToken };
    } else {
      const c = await json<any>(await post("/owners/agents", { name: r.name, capabilities: r.caps }, owner), `create ${r.name}`);
      have = s.agents[r.name] = { id: c.agent.id, token: c.agentToken };
    }
    await saveState(s);
  }
  const v = await post(`/owners/agents/${have.id}/visits`, { minutes: 24 * 60, maxActions: 50_000 }, owner);
  if (!v.ok && v.status !== 409) throw new Error(`visit ${r.name}: HTTP ${v.status} ${(await v.text()).slice(0, 120)}`);   // 409: already visiting
  return have;
}

async function mcp(token: string, name: string, args: object) {
  const r = await fetch(GATEWAY + "/mcp/agent", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return r.ok ? (await r.json() as any).result : null;
}

/** One bounded opencode session for a resident. Returns the cost in USD from opencode's own step records. */
async function session(r: Resident, token: string, dir: string): Promise<{ usd: number; calls: number; said: string }> {
  await mkdir(join(dir, "xdg"), { recursive: true }); await mkdir(join(dir, "home"), { recursive: true });
  const modelId = MODEL.replace(/^openrouter\//, "");
  await Bun.write(join(dir, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: { openrouter: { models: { [modelId]: { name: modelId, tool_call: true, attachment: true, modalities: { input: ["text", "image"], output: ["text"] } } } } },
    mcp: { aiverse: { type: "remote", url: GATEWAY + "/mcp/agent", headers: { Authorization: `Bearer ${token}` }, enabled: true } },
    permission: { bash: "deny", edit: "deny", webfetch: "deny" },
  }));
  await mcp(token, "body_attach", { body: r.figure });   // idempotent: an agent that already has its body keeps it
  const proc = Bun.spawn([OPENCODE, "run", ...(process.env.OPENCODE_STANDALONE === "1" ? ["--standalone"] : []), "--format", "json", "-m", MODEL, promptFor(r)], {
    cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "ignore",
    env: { ...process.env, XDG_CONFIG_HOME: join(dir, "xdg"), HOME: join(dir, "home"), XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? "", ".cache") },
  });
  const killer = setTimeout(() => proc.kill(), 5 * 60_000);
  const out = await new Response(proc.stdout).text();
  clearTimeout(killer);
  let usd = 0, calls = 0, said = "";
  for (const line of out.split("\n")) {
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "step_finish") usd += e.part?.cost ?? 0;
    if (e.type === "tool_use") calls++;
    if (e.type === "text") said = String(e.part?.text ?? "").slice(0, 200);
  }
  return { usd, calls, said };
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("set OPENROUTER_API_KEY");
  const want = process.env.RESIDENT_NAMES?.split(",").map((x) => x.trim());
  const roster = RESIDENTS.filter((r) => !want || want.includes(r.name));
  const s = await loadState();
  const owner = await ownerToken(s);
  const today = () => new Date().toISOString().slice(0, 10);
  console.log(JSON.stringify({ event: "residents_start", model: MODEL, residents: roster.map((r) => r.name), capUsd: DAILY_USD }));
  await Promise.all(roster.map(async (r) => {
    const me = await ensureResident(r, s, owner);
    for (;;) {
      const spent = Object.entries(s.spentUsd).filter(([k]) => k.startsWith(today())).reduce((a, [, v]) => a + v, 0);
      if (spent >= DAILY_USD) { console.log(JSON.stringify({ event: "residents_cap_reached", spent })); await Bun.sleep(10 * 60_000); continue; }
      try {
        const res = await session(r, me.token, join(process.cwd(), ".residents", r.name));
        const key = `${today()}:${r.name}`; s.spentUsd[key] = (s.spentUsd[key] ?? 0) + res.usd; await saveState(s);
        console.log(JSON.stringify({ event: "resident_session", name: r.name, calls: res.calls, usd: +res.usd.toFixed(5), said: res.said }));
        await ensureResident(r, s, owner);   // renew the visit when it lapsed
      } catch (err) { console.log(JSON.stringify({ event: "resident_error", name: r.name, error: String(err).slice(0, 200) })); }
      await Bun.sleep(PAUSE_S * 1000);   // a session whose tools never connected (calls < 3) just starts over after this pause
    }
  }));
}
if (import.meta.main) await main();
