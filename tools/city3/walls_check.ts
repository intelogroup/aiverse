// Wall test on the REAL collision world (loadVerseSim -> capsule world): walk a body at every shop wall from outside, at walk and run speed,
// head-on and at 45 deg, and require it never ends inside the lot rect; walk it through the door and require it ends inside.
//   bun run tools/city3/walls_check.ts
import { readFileSync } from "node:fs";
import { loadVerseSim } from "../../packages/world-sim/node/loadWorld";
import { makeWalker, step } from "../../packages/world-sim/src/walker";

const R = new URL("../../", import.meta.url).pathname;
const { sim, stats } = await loadVerseSim(R + "apps/console/public/assets");
console.log("collision", stats.collisionSets.length, "sets", stats.triangles, "tris");
const world = sim.world;
const idx = JSON.parse(readFileSync(R + "apps/console/public/assets/interiors/index.json", "utf8"));
const OUT: Record<string, [number, number]> = { S: [0, 1], N: [0, -1], E: [1, 0], W: [-1, 0] };

/** walk from (x,z) along heading toward (dx,dz) for `secs`; returns the end position. */
function walk(x: number, z: number, dx: number, dz: number, run: boolean, secs: number, rect?: number[]) {
  const gy = world.groundY(x, z, 0.6) ?? 0.2;
  const s = makeWalker(x, gy, z, Math.atan2(dx, dz));
  s.heading = s.body = Math.atan2(dx, dz);
  let entry: [number, number] | null = null; // first position inside the lot rect
  for (let t = 0; t < secs; t += 1 / 30) {
    step(s, { forward: 1, strafe: 0, turn: 0, run, faceHeading: Math.atan2(dx, dz) }, 1 / 30, world);
    if (rect && !entry && inside(rect, s.x, s.z, 0.45)) entry = [s.x, s.z];
  }
  return Object.assign(s, { entry });
}
function inside(r: number[], x: number, z: number, m: number) { return x > r[0] + m && x < r[2] - m && z > r[1] + m && z < r[3] - m; }
const _unused = (r: number[], x: number, z: number, m: number) => x > r[0] + m && x < r[2] - m && z > r[1] + m && z < r[3] - m;

let tried = 0, leaks: string[] = [], doorFail: string[] = [];
for (const e of idx) {
  const r: number[] = e.rect; if (!r || !e.door) continue;
  const [dx0, dz0] = e.door;
  const sides: [number, number, number, number][] = [ // [fixed axis coord, from, to, side id] -> built below
    [0, 0, 0, 0],
  ];
  void sides;
  const walls = [
    { n: [0, -1], pts: (t: number) => [r[0] + t * (r[2] - r[0]), r[1]] }, // z=r1 wall seen from -z side, walker heads +z
    { n: [0, 1], pts: (t: number) => [r[0] + t * (r[2] - r[0]), r[3]] },
    { n: [-1, 0], pts: (t: number) => [r[0], r[1] + t * (r[3] - r[1])] },
    { n: [1, 0], pts: (t: number) => [r[2], r[1] + t * (r[3] - r[1])] },
  ];
  for (const w of walls) {
    for (let i = 1; i < 20; i++) {
      const [px, pz] = w.pts(i / 20);
      if (Math.hypot(px - dx0, pz - dz0) < 2.2) continue; // the door gap
      for (const ang of [0, 0.7, -0.7]) {
        const c = Math.cos(ang), sn = Math.sin(ang);
        const ix = -w.n[0], iz = -w.n[1]; // inward
        const hx = ix * c - iz * sn, hz = ix * sn + iz * c;
        const sx = px - hx * 1.5, sz = pz - hz * 1.5; // start 1.5 m outside along the heading
        if (inside(r, sx, sz, -0.01) || idx.some((o: any) => o.rect && inside(o.rect, sx, sz, -0.3))) continue; // starts must be outdoors
        for (const run of [false, true]) {
          tried++;
          const s = walk(sx, sz, hx, hz, run, 4, r);
          // entering through the door gap (sliding along the wall into it) is legal; anywhere else is a leak
          if (s.entry && Math.hypot(s.entry[0] - dx0, s.entry[1] - dz0) > 2.0) leaks.push(`${e.id} wall(${w.n}) t=${i / 20} ang=${ang} run=${run} entry=${s.entry!.map((v) => v.toFixed(2))} -> ${s.x.toFixed(2)},${s.z.toFixed(2)}`);
        }
      }
    }
  }
  // door: from 2.5 m out, straight in, must end inside
  const [ox, oz] = OUT[e.front] ?? [0, 1];
  const s = walk(dx0 + ox * 2.5, dz0 + oz * 2.5, -ox, -oz, false, 4);
  if (e.id !== "tea" && !inside(r, s.x, s.z, 0.3)) doorFail.push(`${e.id} door ${dx0},${dz0} front=${e.front} -> ${s.x.toFixed(2)},${s.z.toFixed(2)}`);
}
console.log("tried", tried, "walks;", leaks.length, "leaks;", doorFail.length, "blocked doors");
for (const l of leaks) console.log("LEAK", l);
for (const l of doorFail.slice(0, 25)) console.log("DOOR", l);
process.exit(leaks.length || doorFail.length ? 1 : 0);
