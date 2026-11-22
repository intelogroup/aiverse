// Cold-agent driving gate (step 5 of the world driving plan). An opencode agent on a cheap OpenRouter model, holding only the agent MCP
// (/mcp/agent, the same door every outside agent uses), is asked to drive a loop in the real City 3 sim. The harness meters the run itself by
// polling the agent's own GET /world/observe (free), so the verdict does not depend on what the agent says it did.
//
//   bun experiments/drive-gate/run.ts [runs=1]       env: GATEWAY_URL, DRIVE_MODEL, OPENROUTER_API_KEY. Restart the sim between runs so the car is back at its spot.
//
// Pass (per run): >= 3 distinct junction entries, 0 red_light, 0 collision, ended on foot or stopped. Gate: 3 of 4 runs pass.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { junctionAt } from "../../packages/world-sim/src/trafficSignals";

const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:4100";
const MODEL = process.env.DRIVE_MODEL ?? "openrouter/qwen/qwen3.7-flash";
const OUT = process.env.GATE_OUT ?? join(process.cwd(), ".drive-gate");
const MAX_S = Number(process.env.GATE_MAX_S ?? 600);

/** The task, as the agent reads it. Kept to the goal and the route; the rules of the road are in the world's own docs and observe.vehicle. */
export const TASK = [
  "You have a body in the shared Bazaar world, and everything you do goes through the aiverse tools (world_observe, world_act, world_look, world_clips, or vehicle_enter / vehicle_exit).",
  "Two red cars are parked in the Bazaar; yours has the id car-east, on the west back street at about x -128, z -14, facing north (go_to a point there to find it; the other red car, car-tea, is not yours). Your job: drive it round a loop of signalled junctions, obey the road rules, then park it and get out.",
  "Getting in is your own decision: walk to the car (world_observe lists it in scene as kind \"vehicle\"), then enter it. Read observe.vehicle every time before you drive on: speed, the next signal and its lamp, how far off the correct lane you are, and your infractions.",
  "Route: the car faces north (compass 0) and the street runs north-south. Drive north (heading 0) to the first junction and turn RIGHT there (east), then keep going straight east through the next junctions. Pass at least three junctions in all, then stop.",
  "Rules: stop for a red lamp before the junction and go on green; keep to the right-hand lane; stay under the speed limit; do not hit anything. Drive in short steps (drive takes up to 5 seconds) and re-read observe between steps.",
  "When you have passed at least three junctions, brake to a stop, exit the car, and reply with one sentence about what happened. Never stop to ask me anything.",
].join("\n");

const post = (path: string, body: object, token?: string) => fetch(GATEWAY + path, {
  method: "POST", headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body),
});
async function json<T = any>(r: Response, what: string): Promise<T> {
  const t = await r.text();
  if (!r.ok) throw new Error(`${what}: HTTP ${r.status} ${t.slice(0, 200)}`);
  return JSON.parse(t) as T;
}

async function newDriver(tag: string) {
  const owner = { email: `gate-${crypto.randomUUID()}@example.com`, password: crypto.randomUUID() + crypto.randomUUID() };
  await json(await post("/owners/register", owner), "owner register");
  const ownerToken = (await json<any>(await post("/owners/login", owner), "owner login")).token;
  const created = await json<any>(await post("/owners/agents", { name: `Driver-${tag}`, capabilities: ["driving"] }, ownerToken), "create agent");
  await json(await post(`/owners/agents/${created.agent.id}/visits`, { minutes: 60, maxActions: 2000 }, ownerToken), "start visit");
  const token: string = created.agentToken;
  // The gate is about driving, not about the 143 m walk from the default spawn (runs 43-44 quit on it). When the sim is reachable (local gate), place the
  // body beside car-east first; the gateway's own attach then finds it already there.
  const simUrl = process.env.SIM_URL ?? "http://localhost:3020", simSecret = process.env.SIM_INTERNAL_SECRET;
  if (simUrl && simSecret && process.env.GATE_SPAWN !== "default") {
    const r = await fetch(`${simUrl}/bodies`, { method: "POST", headers: { authorization: `Bearer ${simSecret}`, "x-sim-api": "2", "content-type": "application/json" },
      body: JSON.stringify({ agentId: created.agent.id, expiresAtMs: Date.now() + 3_600_000, spawn: { x: -126.4, z: -14 }, body: "summer" }) });
    if (!r.ok) throw new Error(`sim spawn ${r.status}: ${await r.text()}`);
  }
  await json(await post("/world/body", { body: "summer" }, token), "attach");
  return { id: created.agent.id as string, token };
}

interface Meter { samples: number; junctions: number[]; red: number; collision: number; speeding: number; wrongLane: number; maxSpeed: number; drove: boolean; ended: string; path: [number, number][]; hits: { x: number; z: number; speed: number; junctions: number }[] }

/** Poll the agent's own observe; count distinct junction entries from the body position and read the sim's infraction tally. */
function startMeter(token: string) {
  const m: Meter = { samples: 0, junctions: [], red: 0, collision: 0, speeding: 0, wrongLane: 0, maxSpeed: 0, drove: false, ended: "", path: [], hits: [] };
  let last = -1, stop = false;
  const loop = (async () => {
    while (!stop) {
      try {
        const r = await fetch(GATEWAY + "/world/observe", { headers: { authorization: `Bearer ${token}` } });
        if (r.ok) {
          const o = (await r.json() as any).observation;
          m.samples++;
          const x = o.body.x, z = o.body.z;
          if (m.samples % 4 === 0) m.path.push([Math.round(x), Math.round(z)]);
          const v = o.vehicle;
          if (v) {
            m.drove = true; m.maxSpeed = Math.max(m.maxSpeed, v.speedMps);
            if (v.infractions.collision > m.collision) m.hits.push({ x: +x.toFixed(1), z: +z.toFixed(1), speed: +v.speedMps.toFixed(1), junctions: m.junctions.length });   // where each collision happened, for the failure census
            m.red = Math.max(m.red, v.infractions.red_light); m.collision = Math.max(m.collision, v.infractions.collision);
            m.speeding = Math.max(m.speeding, v.infractions.speeding); m.wrongLane = Math.max(m.wrongLane, v.infractions.wrong_lane);
            const j = junctionAt(x, -z);
            const id = j ? j.id : -1;
            if (id !== last && id >= 0 && !m.junctions.includes(id)) m.junctions.push(id);
            last = id;
            m.ended = `driving at ${v.speedMps.toFixed(1)} m/s`;
          } else m.ended = m.drove ? "on foot after driving" : "on foot";
        }
      } catch { /* the gateway may be busy: next sample */ }
      await Bun.sleep(250);
    }
  })();
  return { m, finish: async () => { stop = true; await loop; return m; } };
}

async function session(token: string, dir: string) {
  await mkdir(join(dir, "xdg"), { recursive: true }); await mkdir(join(dir, "home"), { recursive: true });
  const modelId = MODEL.replace(/^openrouter\//, "");
  await Bun.write(join(dir, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: { openrouter: { models: { [modelId]: { name: modelId, tool_call: true, attachment: true, modalities: { input: ["text", "image"], output: ["text"] } } } } },
    mcp: { aiverse: { type: "remote", url: GATEWAY + "/mcp/agent", headers: { Authorization: `Bearer ${token}` }, enabled: true } },
    permissions: ["read", "edit", "glob", "grep", "shell", "subagent", "skill", "question", "webfetch", "websearch", "external_directory"]
      .map((action) => ({ action, resource: "*", effect: "deny" })),
  }));
  const proc = Bun.spawn([process.env.OPENCODE_BIN ?? "opencode", "run", ...(process.env.OPENCODE_STANDALONE === "0" ? [] : ["--standalone"]), "--format", "json", "-m", MODEL, TASK], {
    cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "ignore",
    // PWD must be the workspace: opencode ignores the process cwd and would otherwise run in this repo with no config (no MCP, no denies).
    env: { ...process.env, PWD: dir, XDG_CONFIG_HOME: join(dir, "xdg"), HOME: join(dir, "home"), XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? "", ".cache") },
  });
  const killer = setTimeout(() => proc.kill(), MAX_S * 1000);
  const out = await new Response(proc.stdout).text();
  clearTimeout(killer);
  await Bun.write(join(dir, "transcript.jsonl"), out);
  let usd = 0, calls = 0, said = "";
  const tools: Record<string, number> = {}, errors: string[] = [];
  for (const line of out.split("\n")) {
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "step_finish") usd += e.part?.cost ?? 0;
    if (e.type === "tool_use") {
      calls++; const t = String(e.part?.tool ?? "?"); tools[t] = (tools[t] ?? 0) + 1;
      if (e.part?.state?.status === "error" && errors.length < 3) errors.push(String(e.part.state.error ?? "").slice(0, 140));
    }
    if (e.type === "text") said = String(e.part?.text ?? "").slice(0, 240);
  }
  return { usd, calls, said, tools, errors };
}

/** A run passes when it drove through enough junctions without running a red or hitting anything. */
export const passes = (m: Pick<Meter, "junctions" | "red" | "collision">) => m.junctions.length >= 3 && m.red === 0 && m.collision === 0;

async function main() {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("set OPENROUTER_API_KEY");
  const runs = Number(process.argv[2] ?? 1);
  await mkdir(OUT, { recursive: true });
  const results: any[] = [];
  for (let i = 1; i <= runs; i++) {
    const tag = `${Date.now().toString(36)}${i}`;
    const me = await newDriver(tag);
    const meter = startMeter(me.token);
    let res: Awaited<ReturnType<typeof session>> | { error: string };
    try { res = await session(me.token, join(OUT, `run-${tag}`)); } catch (e) { res = { error: String(e).slice(0, 200) }; }
    const m = await meter.finish();
    const row = { run: i, tag, pass: passes(m), junctions: m.junctions.length, red: m.red, collision: m.collision, speeding: m.speeding, wrongLane: m.wrongLane, maxSpeed: +m.maxSpeed.toFixed(1), drove: m.drove, ended: m.ended, hits: m.hits, ...res };
    results.push(row);
    await Bun.write(join(OUT, `run-${tag}.path.json`), JSON.stringify(m.path));
    console.log(JSON.stringify(row));
  }
  console.log(JSON.stringify({ event: "gate", model: MODEL, runs, passed: results.filter((r) => r.pass).length }));
}
if (import.meta.main) await main();
