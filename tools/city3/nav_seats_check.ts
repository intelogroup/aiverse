// Walk test for shipped seats: a real body starts at the lot's stand point and must sit on every seat (then stand).
// Seats that fail are what a navmesh route cannot tell you about (the walker snags on a furniture corner).
// Run after export_anchors.py and any navmesh/furniture change:  bun run tools/city3/nav_seats_check.ts [--write]   (--write drops the failures)
import { readFileSync, writeFileSync } from "node:fs";
import { loadVerseSim } from "../../packages/world-sim/node/loadWorld";
const R = new URL("../../", import.meta.url).pathname;
const ASSETS = R + "apps/console/public/assets/";
const FILE = ASSETS + "city3-anchors.json";
const { sim } = await loadVerseSim(ASSETS);
const seats = JSON.parse(readFileSync(FILE, "utf8")) as { id: string; building: string }[];

async function settle(id: string, action: object, maxS: number) {
  let out: { status: string } | null = null;
  void sim.body(id)!.act(action as never).then((o) => (out = o));
  for (let t = 0; t < maxS * 10 && !out; t++) { sim.tick(0.1); await Promise.resolve(); }
  return (out as { status: string } | null)?.status ?? "timeout";
}

const STARTS = [[0, 0], [3, 3], [-4, 6], [0, -3], [5, 0]];
const bad: string[] = [];
for (const s of seats) {
  const lot = sim.places.find((p) => p.id === s.building);
  if (!lot) continue; // tea / press: authored elsewhere
  for (const [dx, dz] of STARTS) { // the walk depends on where it starts: every start must work
    sim.removeBody("chk");
    sim.addBody({ id: "chk", spawn: { x: lot.stand[0] + dx, z: lot.stand[1] + dz } });
    if ((await settle("chk", { type: "sit", sittable: s.id }, 200)) !== "seated" || (await settle("chk", { type: "stand" }, 8)) !== "stood") { bad.push(s.id); break; }
  }
}
console.log(`${seats.length - bad.length}/${seats.length} seats sittable`, bad.length ? `(dropped: ${bad.join(" ")})` : "");
if (process.argv.includes("--write")) writeFileSync(FILE, JSON.stringify(seats.filter((s) => !bad.includes(s.id))));
