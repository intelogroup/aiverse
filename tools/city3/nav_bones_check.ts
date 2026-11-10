// Route test: street door -> corridor centre on every floor of every bones lot.
// Run after bakeNavmesh: bun run tools/city3/nav_bones_check.ts
import { readFileSync } from "node:fs";
import { CityNav } from "../../packages/world-sim/src/cityNav";
const R = new URL("../../", import.meta.url).pathname;
const nav = await CityNav.create(new Uint8Array(readFileSync(R + "packages/world-sim/data/world-city3-navmesh.bin")));
const lots = JSON.parse(readFileSync(R + "tools/city3/out/bones_all.json", "utf8"));
const idx = JSON.parse(readFileSync(R + "apps/console/public/assets/interiors/index.json", "utf8"));
let bad = 0;
for (const l of lots) {
  const [x0, y0, x1, y1] = l.rect; const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const door = idx.find((r: any) => r.id === `shop-${l.id}`)?.door ?? [l.face === "W" ? x0 : l.face === "E" ? x1 : cx, -(l.face === "S" ? y0 : l.face === "N" ? y1 : cy)];
  const o = { S: [0, -2], N: [0, 2], W: [-2, 0], E: [2, 0] }[l.face as "S"];
  const out = { x: door[0] + o[0], y: 0.2, z: door[1] - o[1] };
  const res: string[] = [];
  l.FL.forEach((f: number, i: number) => {
    const y = f + 0.2;
    const r = nav.route(out, { x: cx, y, z: -cy });
    const last = r?.waypoints[r.waypoints.length - 1];
    const ok = !!r && r.endGap < 2.0 && Math.abs(last!.y - y) < 0.6;
    if (!ok) { bad++; res.push(`f${i}:FAIL`); }
  });
  if (res.length) console.log(l.id, res.join(" "));
}
console.log(bad ? `${bad} FAIL` : "all reachable", lots.length, "lots");
