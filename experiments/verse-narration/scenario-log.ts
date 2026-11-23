// Plays the Tea House scene (host agent + real-harness visitor with live narration push) and records, with timestamps, everything
// needed to REPLAY it: the public viewer stream (roster, poses, speech), the harness's tool calls, and the narration the owner received.
// No browser: this works on any machine, GPU or not. Output dir SCEN_OUT: tap.jsonl, events.jsonl, places.json, visitor.json, greeter.log.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodePose } from "../../packages/world-sim/src/streamProtocol";

const OUT = process.env.SCEN_OUT ?? "/tmp/verse-scenario";
const GATEWAY = process.env.VERSE_GATEWAY ?? "http://127.0.0.1:4198";
const MAX_S = Number(process.env.SCEN_MAX_S ?? 330);
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFile = async (f: string, ms: number) => { const end = Date.now() + ms; while (!existsSync(f) && Date.now() < end) await sleep(300); return existsSync(f); };
const child = (name: string, script: string, env: Record<string, string>) => {
  const fd = openSync(join(OUT, name + ".log"), "w");
  const p = spawn("bun", [script], { env: { ...process.env, ...env }, stdio: ["ignore", fd, fd] });
  return { p, done: new Promise<number | null>((r) => p.on("close", r)) };
};

// --- the public viewer stream, exactly what a watcher's console receives
const tap: string[] = [];
const names = new Map<number, string>();
const ws = new WebSocket(GATEWAY.replace(/^http/, "ws") + "/public/ws");
ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe_world" }));
ws.onmessage = (e) => {
  let m: any; try { m = JSON.parse(String(e.data)); } catch { return; }
  const t = Date.now();
  if (m.type === "world_roster") { for (const b of m.payload.bodies) names.set(b.n, b.name); tap.push(JSON.stringify({ t, kind: "roster", bodies: m.payload.bodies })); }
  else if (m.type === "world_frames") { const ps = m.payload.b.map((tp: unknown) => { const p = decodePose(tp as never); return { n: p.n, x: +p.x.toFixed(2), z: +p.z.toFixed(2), h: +p.heading.toFixed(2), s: +p.speed.toFixed(2) }; }); tap.push(JSON.stringify({ t, kind: "pose", p: ps })); }
  else if (m.type === "world_say") for (const s of m.payload.say) tap.push(JSON.stringify({ t, kind: "say", n: s.n, text: s.text }));
};

const READY = join(OUT, "greeter.ready"), SESSION = join(OUT, "visitor.json"), GO = join(OUT, "go");
const greeter = child("greeter", "experiments/verse-narration/greeter.ts", { GREETER_READY_FILE: READY });
const visitor = child("tea-run", "experiments/verse-narration/tea-run.ts", {
  NARRATION_PUSH: "1", NARRATION_HARNESS: process.env.SCEN_HARNESS ?? "opencode", NARRATION_TIMEOUT_S: String(MAX_S - 30),
  NARRATION_SESSION_FILE: SESSION, NARRATION_GO_FILE: GO, NARRATION_OUT: join(OUT, "harness"),
  NARRATION_EVENTS_FILE: join(OUT, "events.jsonl"), NARRATION_PLACES_FILE: join(OUT, "places.json"),
});
if (!(await waitFile(READY, 280_000))) console.log("host never reached the tea house; starting anyway");
await sleep(1500);
const goAt = Date.now();
writeFileSync(GO, String(goAt)); // release the visitor
console.log("scene started");
let finished = false; visitor.done.then(() => { finished = true; });
const hardStop = Date.now() + MAX_S * 1000;
while (!finished && Date.now() < hardStop) await sleep(500);
await sleep(10_000); // the host's last lines
ws.close();
writeFileSync(join(OUT, "tap.jsonl"), tap.join("\n"));
writeFileSync(join(OUT, "meta.json"), JSON.stringify({ goAt, endAt: Date.now(), harness: process.env.SCEN_HARNESS ?? "opencode", model: process.env.NARRATION_MODEL ?? "deepseek/deepseek-v4-flash", names: Object.fromEntries(names) }));
for (const c of [visitor, greeter]) { try { c.p.kill(); } catch { /* done */ } }
console.log(`recorded ${tap.length} stream records over ${((Date.now() - goAt) / 1000).toFixed(0)} s -> ${OUT}`);
process.exit(0);
