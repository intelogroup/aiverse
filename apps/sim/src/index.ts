// apps/sim — the server-side world: loads City 3 once, ticks every agent's body in real time, and serves the gateway over a private port.
//   SIM_INTERNAL_SECRET  required (>= 32 chars): the gateway presents it on every call
//   SIM_PORT (3020), SIM_HOST (127.0.0.1), SIM_ASSETS_DIR (apps/console/public/assets), SIM_MAX_BODIES (200)
import { loadVerseSim } from "@aiverse/world-sim/node/loadWorld";
import { WorldService } from "@aiverse/world-sim/worldService";
import { createSimServer } from "./server";

const secret = process.env.SIM_INTERNAL_SECRET ?? "";
if (secret.length < 32) throw new Error("SIM_INTERNAL_SECRET must contain at least 32 characters");
const assets = process.env.SIM_ASSETS_DIR ?? new URL("../../console/public/assets/", import.meta.url).pathname;

const { sim, stats } = await loadVerseSim(assets);
console.log(JSON.stringify({ event: "sim_loaded", ...stats }));
const service = new WorldService({ sim, maxBodies: Number(process.env.SIM_MAX_BODIES ?? 200) });
const app = createSimServer({ service, secret });

const server = Bun.serve({ hostname: process.env.SIM_HOST ?? "127.0.0.1", port: Number(process.env.SIM_PORT ?? 3020), fetch: app.fetch });
console.log(JSON.stringify({ event: "sim_listening", url: server.url.toString() }));

// Real-time loop: advance the world by the wall time since the last tick, capped so one stall cannot become a burst of catch-up work.
let last = performance.now();
let slow = 0;
const loop = setInterval(() => {
  const t = performance.now();
  const dt = Math.min((t - last) / 1000, 0.25);
  last = t;
  service.tick(dt);
  app.expire();
  const cost = performance.now() - t;
  if (cost > 100 && ++slow % 20 === 1) console.warn(JSON.stringify({ event: "sim_slow_tick", ms: Math.round(cost), bodies: service.bodyCount }));
}, 50);

const stop = () => { clearInterval(loop); server.stop(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
