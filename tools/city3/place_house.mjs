#!/usr/bin/env bun
// Place one prebuilt house GLB in world coordinates and write its collision GLB, as a stand-alone streamed district (no splice into the 100 MB monolith).
//   bun tools/city3/place_house.mjs SRC.glb ID X Z YAW_DEG [--door=front|none] [--scale=1] [--out=apps/console/public/assets/houses]
// Frame: GLB x, z = -plan y, y up, walk slab y=0.2. The house footprint is centred on (X, Z); YAW_DEG must be a multiple of 90 so the collision
// stays axis-aligned. The house front faces local +z before the yaw. Output: <out>/<ID>.glb, <out>/<ID>.col.glb, <out>/<ID>.json (the DistrictDef rect).
import { NodeIO, Document, getBounds } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const [src, id, X, Z, YAW] = process.argv.slice(2, 7).map((v, i) => (i < 2 ? v : Number(v)));
const opt = Object.fromEntries(process.argv.slice(7).filter(a => a.startsWith("--")).map(a => a.slice(2).split("=")));
if (!src || !id || [X, Z, YAW].some(Number.isNaN)) throw new Error("usage: place_house.mjs SRC.glb ID X Z YAW_DEG [--door=front|none] [--scale=1] [--out=dir]");
if (YAW % 90) throw new Error("YAW_DEG must be a multiple of 90");
const S = Number(opt.scale ?? 1), OUT = opt.out ?? "apps/console/public/assets/houses", WALK_Y = 0.2, T = 0.3;
mkdirSync(OUT, { recursive: true });

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(src);
const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
const b = getBounds(scene); // world bbox through the node matrices
const [cx, cz] = [(b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2];
const inner = doc.createNode("house_inner").setTranslation([-cx * S, -b.min[1] * S, -cz * S]).setScale([S, S, S]);
const outer = doc.createNode(`house_${id}`).setTranslation([X, WALK_Y, Z]);
const h = (YAW * Math.PI) / 360; outer.setRotation([0, Math.sin(h), 0, Math.cos(h)]);
for (const n of scene.listChildren()) { scene.removeChild(n); inner.addChild(n); }
outer.addChild(inner); scene.addChild(outer);
await io.write(`${OUT}/${id}.glb`, doc);

// collision: closed boxes in the placed frame. Local footprint half-sizes, rotated by the yaw (90-degree steps swap x/z).
const w = (b.max[0] - b.min[0]) * S, d = (b.max[2] - b.min[2]) * S, ht = (b.max[1] - b.min[1]) * S;
const swap = (YAW / 90) % 2 !== 0, [hx, hz] = swap ? [d / 2, w / 2] : [w / 2, d / 2];
const rad = (YAW * Math.PI) / 180, rot = ([x, z]) => [x * Math.cos(rad) + z * Math.sin(rad), -x * Math.sin(rad) + z * Math.cos(rad)];
const boxes = []; // [name, cx, cz, hx, hz, y0, y1] in local (unrotated) footprint space, rotated below
const lw = w / 2, ld = d / 2, y0 = WALK_Y, y1 = WALK_Y + Math.min(ht, 6);
const door = (opt.door ?? "front") === "front", gapHalf = 0.85;
boxes.push(["wall_back", 0, -ld + T / 2, lw, T / 2, y0, y1], ["wall_l", -lw + T / 2, 0, T / 2, ld, y0, y1], ["wall_r", lw - T / 2, 0, T / 2, ld, y0, y1]);
if (door) boxes.push(["wall_front_l", -(lw + gapHalf) / 2, ld - T / 2, (lw - gapHalf) / 2, T / 2, y0, y1], ["wall_front_r", (lw + gapHalf) / 2, ld - T / 2, (lw - gapHalf) / 2, T / 2, y0, y1], ["lintel", 0, ld - T / 2, gapHalf, T / 2, y0 + 2.9, y1]);
else boxes.push(["wall_front", 0, ld - T / 2, lw, T / 2, y0, y1]);

const col = new Document(); const buf = col.createBuffer(); const sc = col.createScene("col");
const mat = col.createMaterial("col").setBaseColorFactor([0.5, 0.5, 0.5, 1]);
const cube = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
for (const [name, bx, bz, ex, ez, by0, by1] of boxes) {
  const [rx, rz] = rot([bx, bz]), swapE = swap ? [ez, ex] : [ex, ez];
  const c = [X + rx, (by0 + by1) / 2, Z + rz], e = [swapE[0], (by1 - by0) / 2, swapE[1]];
  const pos = new Float32Array(cube.flatMap(v => [c[0] + v[0] * e[0], c[1] + v[1] * e[1], c[2] + v[2] * e[2]]));
  const prim = col.createPrimitive().setMaterial(mat)
    .setAttribute("POSITION", col.createAccessor().setType("VEC3").setArray(pos).setBuffer(buf))
    .setIndices(col.createAccessor().setType("SCALAR").setArray(new Uint16Array(idx)).setBuffer(buf));
  sc.addChild(col.createNode(`col_house_${id}_${name}`).setMesh(col.createMesh(name).addPrimitive(prim)));
}
await new NodeIO().write(`${OUT}/${id}.col.glb`, col);

const half = Math.ceil(Math.max(hx, hz)) + 6;
const def = { id: `house-${id}`, name: id, url: `/assets/houses/${id}.glb`, collisionUrl: `/assets/houses/${id}.col.glb`, center: [X, Z], half, origin: [0, 0], theme: "bazaar" };
// upsert into the committed base manifest; tiles_manifest.mjs carries every `house-*` entry into the tile manifest
const mpath = opt.manifest ?? `${OUT}/../districts.json`;
const man = JSON.parse(readFileSync(mpath, "utf8"));
man.districts = [...man.districts.filter(d => d.id !== def.id), def];
writeFileSync(mpath, JSON.stringify(man, null, 1));
console.log(`${id}: ${w.toFixed(1)} x ${d.toFixed(1)} x ${ht.toFixed(1)} m at (${X}, ${Z}) yaw ${YAW}, ${boxes.length} collision boxes, half ${half}`);
