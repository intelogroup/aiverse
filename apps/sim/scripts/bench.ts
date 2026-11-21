// In-process scaling bench for the sim: how do tick and observe cost grow with bodies? Scripted bots, no LLM, no network.
//   bun run --cwd apps/sim bench -- --n 50,100,200,500,1000 --seconds 30 --observe-hz 0.5 --seed 1
//   --n bodies per run (comma list) · --seconds simulated seconds per run · --observe-hz observes per bot per simulated second
//   (0.5 realistic, 5 worst case) · --seed rng seed · --hz tick rate (default 20 = apps/sim/src/index.ts's 50 ms interval)
//   --ambient 0 turns the resident cars off. Ticks run flat out (not paced), so wall time per tick is pure compute.
// Run it ALONE: the timings are only meaningful on an idle machine. Not measured: HTTP, JSON encoding, app.expire(), viewer frames().
import { loadVerseSim } from "@aiverse/world-sim/node/loadWorld";
import { AmbientWorld } from "@aiverse/world-sim/ambientWorld";
import { WorldService, WorldError } from "@aiverse/world-sim/worldService";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d; };
const NS = arg("n", "50,100,200,500,1000").split(",").map(Number);
const SECONDS = Number(arg("seconds", "30"));
const OBS_HZ = Number(arg("observe-hz", "0.5"));
const SEED = Number(arg("seed", "1"));
const HZ = Number(arg("hz", "20"));
const AMBIENT = arg("ambient", "1") !== "0";
const DT = 1 / HZ, BUDGET_MS = 1000 / HZ, OBSERVE_BUDGET_MS = 250;
if (![...NS, SECONDS, OBS_HZ, SEED, HZ].every(Number.isFinite) || NS.some((n) => n < 1)) throw new Error("bad args");

const mulberry32 = (a: number) => () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
const r2 = (x: number) => Math.round(x * 100) / 100;
const mb = (x: number) => r2(x / 1048576);

const assets = new URL("../../console/public/assets/", import.meta.url).pathname;
const { sim } = await loadVerseSim(assets);
const pts = sim.places.map((p) => p.pos);   // spawn and goal anchors: every place the oracle knows spans the walkable city
const bound = { x0: Math.min(...pts.map((p) => p[0])) - 30, x1: Math.max(...pts.map((p) => p[0])) + 30, z0: Math.min(...pts.map((p) => p[1])) - 30, z1: Math.max(...pts.map((p) => p[1])) + 30 };

async function runN(n: number) {
  const rng = mulberry32(SEED + n);
  let simT = 0;
  const service = new WorldService({ sim, nowS: () => simT, maxBodies: n + 10, ambient: AMBIENT ? new AmbientWorld(() => simT) : undefined });
  Bun.gc(true);
  const rss0 = process.memoryUsage().rss, heap0 = process.memoryUsage().heapUsed;
  const errors: Record<string, number> = {};
  const err = (k: string) => { errors[k] = (errors[k] ?? 0) + 1; };
  // attach: spawn near a random place (+ jitter) over the whole city; a refused spawn retries elsewhere (counted, so crowding is visible)
  const bots: { id: string; last: string | null; seq: number; x: number; z: number; path: number; inCarSince: number }[] = [];
  let spawnRetries = 0;
  for (let i = 0; i < n; i++) {
    const id = `bot-${i}`;
    for (let tries = 0; ; tries++) {
      const a = pts[Math.floor(rng() * pts.length)]!;
      try { service.attach(id, { x: a[0] + (rng() - 0.5) * 40, z: a[1] + (rng() - 0.5) * 40, maxR: 15 }); break; }
      catch (e) { const c = e instanceof WorldError ? e.code : "attach_error"; if (c === "world_full" || tries >= 20) { err(c); throw new Error(`attach ${id} failed: ${c}`); } spawnRetries++; }
    }
    const b = service.body(id);
    bots.push({ id, last: null, seq: 0, x: b.x, z: b.z, path: 0, inCarSince: -1 });
  }
  const bodiesAttached = service.bodyCount;
  // a say must not replace bot.last: it would hide the open walk and the next order would be refused as busy
  const send = (bot: (typeof bots)[number], action: object) => {
    const id = `a${bot.seq++}`;
    try { const rec = service.act(bot.id, id, action); if ((action as { type: string }).type !== "say") bot.last = id; if (rec.state === "settled" && rec.outcome && !rec.outcome.ok) err(`${(action as { type: string }).type}:${rec.outcome.status}`); }
    catch (e) { err(e instanceof WorldError ? e.code : "act_error"); }
  };
  // half the goals are a named place (reachable: a raw place.pos sits inside a stall's collision and gets "no safe route"), half a random point near the bot
  const goal = (bot: (typeof bots)[number]) => rng() < 0.5
    ? { place: sim.places[Math.floor(rng() * sim.places.length)]!.id }
    : { point: [Math.min(bound.x1, Math.max(bound.x0, bot.x + (rng() - 0.5) * 120)), Math.min(bound.z1, Math.max(bound.z0, bot.z + (rng() - 0.5) * 120))] };

  const tickMs: number[] = [], obsMs: number[] = [], actMs: number[] = [];
  let observes = 0, enters = 0, entered = 0, says = 0, orders = 0;
  const ticks = Math.round(SECONDS * HZ);
  const wall0 = performance.now();
  for (let k = 0; k < ticks; k++) {
    // bots decide (act/observe are timed on their own; they are the gateway's cost, not the tick's)
    for (const bot of bots) {
      const car = service.fleet.byDriver(bot.id);
      if (car) {   // seated: ride a few seconds, then get out and walk again (stop is the brake, exit needs a near-stopped car)
        if (bot.inCarSince < 0) { bot.inCarSince = simT; entered++; }
        if (simT - bot.inCarSince > 3) { send(bot, { type: "stop" }); if (simT - bot.inCarSince > 5) send(bot, { type: "exit_vehicle" }); }
      } else bot.inCarSince = -1;
      const t0 = performance.now();
      if (rng() < OBS_HZ * DT) { const o = service.observe(bot.id, 0, 0); observes++; void o; obsMs.push(performance.now() - t0); }
      const t1 = performance.now();
      const prev = bot.last ? service.actRecord(bot.id, bot.last) : undefined;
      const open = prev?.state === "running";
      if (prev?.state === "settled" && prev.outcome && !prev.outcome.ok && prev.action.type !== "enter_vehicle") err(`${prev.action.type}:${prev.outcome.status}`);
      if (rng() < 0.05 * DT) { says++; send(bot, { type: "say", text: `hello from ${bot.id}` }); }   // speech does not interrupt a walk
      if (!car && !open) {
        if (rng() < 0.04) { enters++; send(bot, { type: "enter_vehicle" }); }
        else { orders++; send(bot, { type: rng() < 0.3 ? "run_to" : "go_to", ...goal(bot) }); }
      }
      actMs.push(performance.now() - t1);
    }
    const t = performance.now();
    simT += DT;   // WorldService.tick advances sim.t itself; simT only feeds the injected wall clocks
    service.tick(DT);
    tickMs.push(performance.now() - t);
    await new Promise((r) => setImmediate(r));   // the real loop is a setInterval: action promises (path planning) only resolve when the event loop turns
    if (k % HZ === 0) for (const bot of bots) { const b = service.body(bot.id); bot.path += Math.hypot(b.x - bot.x, b.z - bot.z); bot.x = b.x; bot.z = b.z; }
  }
  const wallS = (performance.now() - wall0) / 1000;
  const mem = process.memoryUsage();
  const endState: Record<string, number> = {};   // what each bot's last order is doing at the end: running, or how it settled
  for (const b of bots) { const r = b.last ? service.actRecord(b.id, b.last) : undefined; const k = !r ? "none" : r.state === "running" ? "running" : `${r.outcome?.status}${r.outcome?.ok ? "" : "!"}`; endState[k] = (endState[k] ?? 0) + 1; }
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const row = {
    n, bodies: bodiesAttached, spawnRetries, errors,
    tickMs: { p50: r2(pct(tickMs, 0.5)), p99: r2(pct(tickMs, 0.99)), max: r2(Math.max(...tickMs)), budget: r2(BUDGET_MS) },
    observeMs: { p50: r2(pct(obsMs, 0.5)), p99: r2(pct(obsMs, 0.99)), n: observes },
    actMsMeanPerBotTick: r2(sum(actMs) / actMs.length),
    // fraction of one core spent per simulated second: tick + observe + act (the gateway would add HTTP on top)
    cpuLoad: r2((sum(tickMs) + sum(obsMs) + sum(actMs)) / (SECONDS * 1000)),
    wallS: r2(wallS),
    endState,
    movedM: { meanPath: r2(sum(bots.map((b) => b.path)) / n), movers: bots.filter((b) => b.path > 1).length },
    actions: { orders, says, enterTries: enters, rides: entered },
    mem: { rssPerBodyMB: mb((mem.rss - rss0) / n), heapPerBodyMB: mb((mem.heapUsed - heap0) / n) },
    verdict: "",
  };
  const tickOk = row.tickMs.p99 <= BUDGET_MS, obsOk = row.observeMs.p99 <= OBSERVE_BUDGET_MS;
  row.verdict = `N=${n}: tick p99 ${row.tickMs.p99} ms ${tickOk ? "<=" : ">"} ${r2(BUDGET_MS)} ms budget (${tickOk ? "OK" : "OVER"}), observe p99 ${row.observeMs.p99} ms ${obsOk ? "<=" : ">"} ${OBSERVE_BUDGET_MS} ms (${obsOk ? "OK" : "OVER"}), cpu ${Math.round(row.cpuLoad * 100)}% of a core`;
  for (const id of service.agentIds()) service.detach(id);
  return row;
}

const rows = [];
for (const n of NS) { rows.push(await runN(n)); console.error(rows[rows.length - 1]!.verdict); }
console.log(JSON.stringify({ config: { ns: NS, seconds: SECONDS, observeHz: OBS_HZ, hz: HZ, seed: SEED, ambient: AMBIENT, bun: Bun.version }, rows }, null, 1));
