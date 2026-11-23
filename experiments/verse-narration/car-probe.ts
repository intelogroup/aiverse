// Deterministic (no LLM) probe: can each drivable car actually move from its parking spot?
// STATUS: written after a driving run found car-tea wedged; the walk-to-a-point-beside-the-car fix has NOT yet run to completion.
// (go_to {body: <car id>} only works once the car is in view, so the probe walks to the parking spot from drive.ts PARKED first.)
// For each car id: walk to it, get in, try a short forward step along its facing, then a reverse step; print the sim's own words.
import { endSession, mcp, startSession } from "./verse-session";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cars = (process.env.PROBE_CARS ?? "car-east,car-tea").split(",");
// Parking spots from packages/world-sim/src/drive.ts PARKED (x, z): the probe walks to a point 2 m beside each, then enters.
const SPOT: Record<string, [number, number]> = { "car-east": [-128.2, -14], "car-tea": [-28, -56] };
for (const carId of cars) {
  const s = await startSession("Probe-" + crypto.randomUUID().slice(0, 4));
  const act = async (action: object) => (await mcp(s.token, "world_act", { agent_id: s.agentId, action })).act;
  const obs = async () => (await mcp(s.token, "world_observe", { agent_id: s.agentId })).observation;
  try {
    await mcp(s.token, "body_attach", { agent_id: s.agentId, body: "summer" });
    const [cx, cz] = SPOT[carId];
    await act({ type: "go_to", point: [cx + 2, cz] });
    const t0 = Date.now(); let near = false;
    while (Date.now() - t0 < 300_000) {
      const o = await obs();
      if (Math.hypot(o.body.x - cx, o.body.z - cz) <= 3.0) { near = true; break; }
      await sleep(2500);
    }
    console.log(`\n== ${carId}: reached after ${((Date.now() - t0) / 1000).toFixed(0)} s: ${near}`);
    const enter = await mcp(s.token, "vehicle_enter", { agent_id: s.agentId, vehicle_id: carId });
    console.log("enter:", enter.act.outcome?.detail?.slice(0, 90));
    const o = await obs();
    console.log("vehicle:", JSON.stringify(o.vehicle)?.slice(0, 200));
    const compass = o.vehicle?.compassDeg ?? 0;
    for (const [label, a] of [["forward 2 s", { type: "drive", speed: 3, heading: compass, seconds: 2 }], ["reverse 2 s", { type: "drive", gas: 1, reverse: true, seconds: 2 }], ["forward again", { type: "drive", speed: 3, heading: compass, seconds: 2 }]] as const) {
      const r = await act(a as object);
      const d = r.outcome?.detail ?? JSON.stringify(r).slice(0, 160);
      console.log(`${label}: ${d.slice(0, 170)}`);
    }
    await act({ type: "exit_vehicle" }).catch(() => {});
  } finally { await endSession(s); }
}
