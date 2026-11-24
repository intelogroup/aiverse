#!/usr/bin/env bun
// Place one prebuilt house GLB in world coordinates and write its collision GLB, as a stand-alone streamed district (no splice into the 100 MB monolith).
//   bun tools/city3/place_house.mjs SRC.glb ID X Z YAW_DEG [--door=front|back|none] [--doorx=0] [--doorhalf=0.85] [--body=x0,x1,z0,z1] [--floor=0.63] [--ceil=2.8] [--scale=1] [--mask] [--asset=NAME] [--lift=0] [--room="Display name"] [--out=dir] [--manifest=districts.json]
// Frame: GLB x, z = -plan y, y up, walk slab y=0.2. The house footprint is centred on (X, Z); YAW_DEG must be a multiple of 90 so the collision
// stays axis-aligned. The house front faces local +z before the yaw. Output: <out>/<ID>.glb, <out>/<ID>.col.glb, <out>/<ID>.json (the DistrictDef rect).
import { NodeIO, Document, getBounds } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const [src, id, X, Z, YAW] = process.argv.slice(2, 7).map((v, i) => (i < 2 ? v : Number(v)));
const opt = Object.fromEntries(process.argv.slice(7).filter(a => a.startsWith("--")).map(a => a.slice(2).split("=")));
if (!src || !id || [X, Z, YAW].some(Number.isNaN)) throw new Error("usage: place_house.mjs SRC.glb ID X Z YAW_DEG [--door=front|none] [--scale=1] [--out=dir]");
if (YAW % 90) throw new Error("YAW_DEG must be a multiple of 90");
// --lift raises house and collision together: on a landscaped block the grass quads stand 0.03-0.07 m over the walk slab
const S = Number(opt.scale ?? 1), OUT = opt.out ?? "apps/console/public/assets/houses", WALK_Y = 0.2 + Number(opt.lift ?? 0), T = 0.3;
mkdirSync(OUT, { recursive: true });
// --asset=NAME: one shared GLB pair per model and yaw (NAME-y<YAW>.glb), authored at (0, 0); the district's `origin` puts it on the lot, so a model
// placed on many lots is stored and downloaded once. Without it the file is <ID>.glb in world coordinates (origin [0, 0]).
const FILE = opt.asset ? `${opt.asset}-y${YAW}` : id, [PX, PZ] = opt.asset ? [0, 0] : [X, Z];

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(src);
const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
const b = getBounds(scene); // world bbox through the node matrices
const [cx, cz] = [(b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2];
const inner = doc.createNode("house_inner").setTranslation([-cx * S, -b.min[1] * S, -cz * S]).setScale([S, S, S]);
// --floor = height of the visual floor top above the model's lowest point: the house sinks so that floor sits 0.28 m over the walk slab (hero-shop rule, the walker steps up 0.3)
const FL = opt.floor !== undefined ? Number(opt.floor) * S : null, SINK = FL === null ? 0 : FL - 0.28;
const outer = doc.createNode(`house_${FILE}`).setTranslation([PX, WALK_Y - SINK, PZ]);
const h = (YAW * Math.PI) / 360; outer.setRotation([0, Math.sin(h), 0, Math.cos(h)]);
for (const n of scene.listChildren()) { scene.removeChild(n); inner.addChild(n); }
// --mask: alpha-BLEND cards (thatch, foliage) become alpha-tested, which three.js draws without transparency sorting
if (opt.mask !== undefined) for (const m of doc.getRoot().listMaterials()) if (m.getAlphaMode() === "BLEND") m.setAlphaMode("MASK").setAlphaCutoff(0.5);
outer.addChild(inner); scene.addChild(outer);
await io.write(`${OUT}/${FILE}.glb`, doc);

// collision: closed boxes, authored in a "door frame" where the door side faces +z, then turned by the door side's angle and the yaw (90-degree steps).
// --door=front|right|back|left names the local side (+z, +x, -z, -x); --doorx is the gap centre along that facade in the door frame.
const w = (b.max[0] - b.min[0]) * S, d = (b.max[2] - b.min[2]) * S, ht = (b.max[1] - b.min[1]) * S;
const ry = (deg) => { const r = (deg * Math.PI) / 180, c = Math.round(Math.cos(r)), s = Math.round(Math.sin(r)); return ([x, z]) => [x * c + z * s, -x * s + z * c]; };
const SIDE = { none: 0, front: 0, right: 90, back: 180, left: 270 };
const door = opt.door ?? "none"; if (!(door in SIDE)) throw new Error(`--door must be one of ${Object.keys(SIDE).join("|")}`);
const toLocal = ry(SIDE[door]), toDoor = ry(-SIDE[door]), toWorld = ry(YAW);
const [hx, hz] = (YAW / 90) % 2 !== 0 ? [d / 2, w / 2] : [w / 2, d / 2];
const boxes = []; // [name, cx, cz, hx, hz, y0, y1] in the door frame
const gh = Number(opt.doorhalf ?? 0.85), dx = Number(opt.doorx ?? 0), top = WALK_Y + ht - SINK;
const [lx0, lx1, lz0, lz1] = opt.body ? opt.body.split(",").map(Number) : [-w / 2, w / 2, -d / 2, d / 2];
const cs = [[lx0, lz0], [lx1, lz0], [lx0, lz1], [lx1, lz1]].map(toDoor);
const [bx0, bx1, bz0, bz1] = [Math.min(...cs.map(p => p[0])), Math.max(...cs.map(p => p[0])), Math.min(...cs.map(p => p[1])), Math.max(...cs.map(p => p[1]))];
const yb = WALK_Y - 0.3, FLOOR_TOP = WALK_Y + 0.28, ceil = WALK_Y + Number(opt.ceil ?? 2.8);
const mx = (bx0 + bx1) / 2, mz = (bz0 + bz1) / 2, ex = (bx1 - bx0) / 2, ez = (bz1 - bz0) / 2;
if (door === "none") boxes.push(["solid", mx, mz, ex, ez, yb, top]);
else {
  const fz = bz1 - T / 2;
  boxes.push(["wall_l", bx0 + T / 2, mz, T / 2, ez, yb, top], ["wall_r", bx1 - T / 2, mz, T / 2, ez, yb, top], ["wall_back", mx, bz0 + T / 2, ex, T / 2, yb, top]);
  const l0 = bx0 + T, l1 = dx - gh, r0 = dx + gh, r1 = bx1 - T; // facade either side of the gap
  if (l1 > l0) boxes.push(["facade_l", (l0 + l1) / 2, fz, (l1 - l0) / 2, T / 2, yb, top]);
  if (r1 > r0) boxes.push(["facade_r", (r0 + r1) / 2, fz, (r1 - r0) / 2, T / 2, yb, top]);
  boxes.push(["lintel", dx, fz, gh, T / 2, WALK_Y + 2.9, top], ["threshold", dx, fz, gh, T / 2, yb, FLOOR_TOP]);
  boxes.push(["stoop", dx, fz + 0.425 + T / 2, gh + 0.45, 0.425, yb, FLOOR_TOP]);
  boxes.push(["floor", mx, mz, ex - T, ez - T, yb, FLOOR_TOP], ["ceiling", mx, mz, ex, ez, ceil, top]);
}
const turn = (p) => toWorld(toLocal(p)), swap = ((SIDE[door] + YAW) / 90) % 2 !== 0;

const col = new Document(); const buf = col.createBuffer(); const sc = col.createScene("col");
const mat = col.createMaterial("col").setBaseColorFactor([0.5, 0.5, 0.5, 1]);
const cube = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
for (const [name, bx, bz, ex, ez, by0, by1] of boxes) {
  const [rx, rz] = turn([bx, bz]), swapE = swap ? [ez, ex] : [ex, ez];
  const c = [PX + rx, (by0 + by1) / 2, PZ + rz], e = [swapE[0], (by1 - by0) / 2, swapE[1]];
  const pos = new Float32Array(cube.flatMap(v => [c[0] + v[0] * e[0], c[1] + v[1] * e[1], c[2] + v[2] * e[2]]));
  const prim = col.createPrimitive().setMaterial(mat)
    .setAttribute("POSITION", col.createAccessor().setType("VEC3").setArray(pos).setBuffer(buf))
    .setIndices(col.createAccessor().setType("SCALAR").setArray(new Uint16Array(idx)).setBuffer(buf));
  sc.addChild(col.createNode(`col_house_${FILE}_${name}`).setMesh(col.createMesh(name).addPrimitive(prim)));
}
await new NodeIO().write(`${OUT}/${FILE}.col.glb`, col);

const half = Math.ceil(Math.max(hx, hz)) + 6;
const def = { id: `house-${id}`, name: id, url: `/assets/houses/${FILE}.glb`, collisionUrl: `/assets/houses/${FILE}.col.glb`, center: [X, Z], half, origin: [X - PX, Z - PZ], theme: "bazaar" };
// upsert into the committed base manifest; tiles_manifest.mjs carries every `house-*` entry into the tile manifest
const mpath = opt.manifest ?? `${OUT}/../districts.json`;
const man = JSON.parse(readFileSync(mpath, "utf8"));
man.districts = [...man.districts.filter(d => d.id !== def.id), def];
writeFileSync(mpath, JSON.stringify(man, null, 1));
// --room: a walkable house (door != none) becomes an enterable room and a go_to place, like a hero shop: interiors/house-<id>.{json,col.json},
// an interiors/index.json row and a city3-places.json shopfront whose stand is 0.9 m outside the door (past the stoop).
if (opt.room !== undefined) {
  if (door === "none") throw new Error("--room needs a door");
  const A = `${OUT}/..`, rid = `house-${id}`, n = turn([0, 1]), dp = turn([dx, bz1]);
  const doorW = [X + dp[0], Z + dp[1]].map((v) => +v.toFixed(3)), stand = [doorW[0] + n[0] * 0.9, doorW[1] + n[1] * 0.9].map((v) => +v.toFixed(3));
  const cw = [[bx0, bz0], [bx1, bz0], [bx0, bz1], [bx1, bz1]].map(turn).map(([a, c]) => [X + a, Z + c]);
  const rect = [Math.min(...cw.map((p) => p[0])), Math.min(...cw.map((p) => p[1])), Math.max(...cw.map((p) => p[0])), Math.max(...cw.map((p) => p[1]))].map((v) => +v.toFixed(3));
  const front = n[0] > 0.5 ? "E" : n[0] < -0.5 ? "W" : n[1] > 0.5 ? "S" : "N";   // N = -z, as the hero shops
  mkdirSync(`${A}/interiors`, { recursive: true });
  writeFileSync(`${A}/interiors/${rid}.json`, JSON.stringify({ id: rid, library: "world-city3-library.glb", props: [] }));
  writeFileSync(`${A}/interiors/${rid}.col.json`, JSON.stringify({ id: rid, units: "m, three.js space: [cx, cz, hx, hz, y0, y1, rotY]", floorY: +FLOOR_TOP.toFixed(3), boxes: [], seats: [] }));
  const row = { id: rid, lot: rid, name: opt.room, template: "house", front, center: [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2], door: doorW, rect,
    cut: { rect: [rect[0] - 0.1, rect[1] - 0.1, rect[2] + 0.1, rect[3] + 0.1], y: +top.toFixed(2) }, layout: `/assets/interiors/${rid}.json`, featured: false, collision: `/assets/interiors/${rid}.col.json` };
  const ip = `${A}/interiors/index.json`, idx = JSON.parse(readFileSync(ip, "utf8"));
  writeFileSync(ip, JSON.stringify([...idx.filter((r) => r.id !== rid), row]));
  const pp = `${A}/city3-places.json`, places = JSON.parse(readFileSync(pp, "utf8"));
  const place = { id: rid, kind: "shopfront", name: opt.room, pos: stand, heading: +Math.atan2(n[0], n[1]).toFixed(5), stand, room: rid, door: doorW };
  writeFileSync(pp, JSON.stringify([...places.filter((p) => p.id !== rid), place], null, 1));
}
console.log(`${id}: ${w.toFixed(1)} x ${d.toFixed(1)} x ${ht.toFixed(1)} m at (${X}, ${Z}) yaw ${YAW}, ${boxes.length} collision boxes, half ${half}`);
