// Random-walk fuzz on the real collision world: writes the sampled positions of every walk to argv[2] (JSON) for walls_fuzz_check.py.
//   bun run tools/city3/walls_fuzz.ts <out.json> [walks=3000]
import { writeFileSync } from "node:fs";
import { loadVerseSim } from "../../packages/world-sim/node/loadWorld";
import { makeWalker, step } from "../../packages/world-sim/src/walker";
const R = new URL("../../", import.meta.url).pathname;
const { sim } = await loadVerseSim(R + "apps/console/public/assets"); const w = sim.world;
let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const N = Number(process.argv[3] ?? 3000), paths: number[][][] = [];
while (paths.length < N) {
  const x = (rnd() - 0.5) * 300, z = (rnd() - 0.5) * 300, gy = w.groundY(x, z, 0.6);
  if (gy === null || gy > 0.45 || gy < 0.1) continue; // outdoor street level only
  if (w.blocked([x, gy, z], [x, gy, z + 0.001], 0.7)) continue; // start with 0.7 m clearance: a start on a wall face is a depenetration case, not a walk
  const h = rnd() * Math.PI * 2, s = makeWalker(x, gy, z, h); s.body = h; const p: number[][] = [[x, z, s.y]];
  for (let i = 0; i < 180; i++) { // 6 s, turn at random so it follows walls
    if (i % 30 == 0) s.heading = h + (rnd() - 0.5) * 1.2;
    step(s, { forward: 1, strafe: 0, turn: 0, run: rnd() < 0.5, faceHeading: s.heading }, 1 / 30, w);
    if (i % 6 == 5) p.push([s.x, s.z, s.y]);
  }
  paths.push(p);
}
writeFileSync(process.argv[2], JSON.stringify(paths));
console.log("walks", paths.length);
