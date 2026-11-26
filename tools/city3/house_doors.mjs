#!/usr/bin/env bun
// Give every walk-in house a swinging front door: write a `doorLeaf` spec (packages/world-sim/src/houseDoor.ts) into its room in
// apps/console/public/assets/interiors/index.json and ship the model's real door leaf as assets/doors/<model>.glb.
//   bun tools/city3/house_doors.mjs        (after houses.sh; needs $SRC/<model>/leaf/ from open_house.py --leaf, see MODELS)
// The leaf is cut by the same --cut box as open.glb, in open.glb's frame, so its centre maps to the world through the lot's
// origin + rotationY exactly like the room door does; that mapping is asserted against the room's door point before writing.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const A = "apps/console/public/assets", SRC = process.env.SRC ?? `${process.env.HOME}/Developer/city3-downloads`;
// doorx/doorz are houses.sh's --doorx/--doorz (the door point in the model frame); hinge is the jamb opposite the knob, seen from the street.
//   leaf.glb: open_house.py SRC OUT <the model's --scale/--cut from houses.sh> --leaf, then gltf-transform optimize --texture-size 512 --compress meshopt --texture-compress webp
const MODELS = {
  "/assets/houses/american.glb": { dir: "american-house", doorx: -4.465, doorz: 4.2, hinge: "right" },
  "/assets/houses/suburban-bogdan.glb": { dir: "suburban-bogdan", doorx: 3.54, doorz: 1.25, hinge: "left" },
  "/assets/houses/residence-wsg.glb": { dir: "residence-wsg", doorx: 2.875, doorz: 4.04, hinge: "right" },
};
// Hand-surveyed doors (no leaf GLB: the console draws a slab). Scandi Hawk's is the old HawkDoor's inner jamb and threshold.
const SURVEYED = {
  "house-ring-35-0": { x: 22.925, y: 0.53, z: -142.086, width: 1.6, height: 2.04, yaw: 0, hinge: "left" },
};

const r3 = (v) => +v.toFixed(3);
const turn = ([x, z], deg) => { const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t); return [x * c + z * s, -x * s + z * c]; };
const districts = new Map(JSON.parse(readFileSync(`${A}/districts.json`, "utf8")).districts.map((d) => [d.id, d]));
const rooms = JSON.parse(readFileSync(`${A}/interiors/index.json`, "utf8"));
mkdirSync(`${A}/doors`, { recursive: true });
const shipped = new Set();
let n = 0;
for (const room of rooms) {
  if (SURVEYED[room.id]) { room.doorLeaf = SURVEYED[room.id]; n++; continue; }
  const lot = districts.get(room.lot), m = lot && MODELS[lot.url];
  if (!m) continue;
  const leaf = JSON.parse(readFileSync(`${SRC}/${m.dir}/leaf/leaf.json`, "utf8"));
  const { floor } = JSON.parse(readFileSync(`${SRC}/${m.dir}/open/col_local.json`, "utf8"));
  const { floorY } = JSON.parse(readFileSync(`${A}${room.collision.replace(/^\/assets/, "")}`, "utf8"));
  const yaw = lot.rotationY ?? 0, [ox, oz] = lot.origin;
  // the frame check: the room door was written by place_house.mjs as origin + turn(doorx, doorz)
  const dp = turn([m.doorx, m.doorz], yaw);
  if (Math.hypot(ox + dp[0] - room.door[0], oz + dp[1] - room.door[1]) > 0.02) throw new Error(`${room.id}: door frame mismatch`);
  const c = turn([(leaf.min[0] + leaf.max[0]) / 2, (leaf.min[2] + leaf.max[2]) / 2], yaw);
  const url = `/assets/doors/${m.dir}.glb`;
  if (!shipped.has(url)) { copyFileSync(`${SRC}/${m.dir}/leaf/leaf.opt.glb`, `${A}/doors/${m.dir}.glb`); shipped.add(url); }
  room.doorLeaf = { x: r3(ox + c[0]), y: r3(floorY + leaf.min[1] - floor), z: r3(oz + c[1]), width: leaf.width, height: leaf.height, thick: leaf.thick, yaw, hinge: m.hinge, leaf: url };
  n++;
}
writeFileSync(`${A}/interiors/index.json`, JSON.stringify(rooms));
console.log(`house doors: ${n} rooms, ${shipped.size} leaf GLBs`);
