import assert from "node:assert/strict";
import { loadVerseSim } from "../../packages/world-sim/node/loadWorld";
import { WorldService } from "../../packages/world-sim/src/worldService";

const assets = new URL("../../apps/console/public/assets/", import.meta.url).pathname;
const { sim } = await loadVerseSim(assets);
const world = new WorldService({ sim });
const start = sim.places.find(p => p.id === "stall-40")!.stand;
const villa = sim.places.find(p => p.id === "villa");
assert.ok(villa, "This experiment needs the Villa landmark and rebaked dam collision. See pr-reruns/README.md.");
const goal = villa.stand;
world.attach("courier", { x: start[0], z: start[1] }, "remy");
const act = world.act("courier", "villa-walk", { type: "go_to", place: "villa" });
const track = [];
for (let i = 0; i < 60 * 360 && act.state === "running"; i++) {
  world.tick(1 / 60);
  await Promise.resolve();
  if (i % 30 === 0) {
    const { x, y, z } = world.body("courier");
    track.push({ t: sim.t, x, y, z });
  }
}
const end = world.body("courier");
const crossing = track.filter(p => p.z >= 180 && p.z < 215);
console.log(JSON.stringify({ start, goal, end, outcome: act.outcome, crossing, track }, null, 2));
assert.ok(act.outcome?.ok);
assert.ok(Math.hypot(end.x - goal[0], end.z - goal[1]) < 1);
assert.ok(crossing.length > 20 && crossing.every(p => Math.abs(p.y - 0.2) < 0.03));
