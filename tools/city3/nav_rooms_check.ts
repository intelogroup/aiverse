// Route test: street door -> a point 1.5 m inside every furnished room (on the door lane), every floor.
// Catches furniture that closes a room. Run after bakeNavmesh: bun run tools/city3/nav_rooms_check.ts
import { readFileSync } from "node:fs";
import { CityNav } from "../../packages/world-sim/src/cityNav";
const R = new URL("../../", import.meta.url).pathname;
const nav = await CityNav.create(new Uint8Array(readFileSync(R + "packages/world-sim/data/world-city3-navmesh.bin")));
const lots = JSON.parse(readFileSync(R + "tools/city3/out/bones_all.json", "utf8"));
const idx = JSON.parse(readFileSync(R + "apps/console/public/assets/interiors/index.json", "utf8"));
let bad = 0, n = 0;
for (const l of lots) {
  const [x0, y0, x1, y1] = l.rect; const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const door = idx.find((r: any) => r.id === `shop-${l.id}`)?.door ?? [cx, -cy];
  const o = { S: [0, -2], N: [0, 2], W: [-2, 0], E: [2, 0] }[l.face as "S"];
  const out = { x: door[0] + o[0], y: 0.2, z: door[1] - o[1] };
  const fails: string[] = [];
  for (const r of l.rooms) {
    const [a, b, c, d] = r.rect; const rx = (a + c) / 2, rz = -(b + d) / 2;
    const dx = r.door[0], dz = -r.door[1];
    const horiz = Math.abs(rx - dx) > Math.abs(rz - dz);
    const dir = horiz ? [Math.sign(rx - dx), 0] : [0, Math.sign(rz - dz)];
    const p = { x: dx + dir[0] * 1.5, y: r.z + 0.2, z: dz + dir[1] * 1.5 };
    n++;
    const res = nav.route(out, p); const last = res?.waypoints[res.waypoints.length - 1];
    if (!res || res.endGap > 0.8 || Math.abs(last!.y - p.y) > 0.6) { bad++; fails.push(`f${r.floor}${r.tag}${r.i}`); }
  }
  if (fails.length) console.log(l.id, fails.join(" "));
}
console.log(bad ? `${bad} FAIL of ${n}` : "all rooms reachable", n, "rooms");
