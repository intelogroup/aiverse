#!/usr/bin/env bun
// Gate for split_world.mjs: the tiles together must equal the monolith.
//   bun tools/city3/verify_tiles.mjs <monolith.glb> <tilesDir> [--three=<path to a three install>]
// Per material name (three renames sub-meshes by primitive index, so mesh names are not stable across tiles): rendered triangles (instances counted) must match exactly, and the world bbox of that name must match to 1 mm.
// Textures are not decoded (a stub material per node), so external texture uris are only checked to exist on disk.
import { readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
const args = process.argv.slice(2);
const [MONO, DIR] = args.filter(a => !a.startsWith("--"));
const T3 = (args.find(a => a.startsWith("--three=")) ?? "--three=" + new URL("../../apps/console/node_modules/three", import.meta.url).pathname).slice(8);
const THREE = await import(T3 + "/build/three.module.js");
const { GLTFLoader } = await import(T3 + "/examples/jsm/loaders/GLTFLoader.js");
const { MeshoptDecoder } = await import(T3 + "/examples/jsm/libs/meshopt_decoder.module.js");
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
loader.register(parser => ({ name: "stub", loadMaterial: i => { const m = new THREE.MeshBasicMaterial(); m.name = parser.json.materials[i].name ?? "#" + i; return Promise.resolve(m); } }));
async function stats(path) {
  const b = readFileSync(path);
  const scene = (await loader.parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), "")).scene;
  scene.updateMatrixWorld(true);
  const m = new Map(), tmp = new THREE.Box3(), v = new THREE.Vector3(), im = new THREE.Matrix4();
  scene.traverse(o => {
    if (!o.isMesh) return;
    const g = o.geometry, T = (g.index ? g.index.count : g.attributes.position.count) / 3, n = o.isInstancedMesh ? o.count : 1;
    const key = (Array.isArray(o.material) ? o.material.map(x => x.name).join('+') : o.material.name) + (o.isInstancedMesh ? '|inst' : ''); const e = m.get(key) ?? { tris: 0, box: new THREE.Box3() }; m.set(key, e); e.tris += T * n;
    if (!g.__ub) { // bbox of REFERENCED vertices only: the monolith keeps unreferenced vertices from demolished lots, the tiles drop them
      const P = g.attributes.position, I = g.index, b = new THREE.Box3(); const c = I ? I.count : P.count;
      for (let i = 0; i < c; i++) b.expandByPoint(v.fromBufferAttribute(P, I ? I.getX(i) : i)); g.__ub = b; }
    for (let i = 0; i < n; i++) { const w = o.isInstancedMesh ? (o.getMatrixAt(i, im), im.premultiply(o.matrixWorld)) : o.matrixWorld; e.box.union(tmp.copy(g.__ub).applyMatrix4(w)); }
  });
  let lights = 0; scene.traverse(o => { if (o.isLight) lights++; });
  return { m, lights };
}
const tilesJson = JSON.parse(readFileSync(DIR + "/tiles.json", "utf8"));
const mono = await stats(MONO);
const sum = new Map(); let lights = 0, missing = 0;
for (const t of tilesJson.tiles) {
  const f = DIR + "/" + t.url; const j = JSON.parse(readFileSync(f).subarray(20, 20 + readFileSync(f).readUInt32LE(12)).toString());
  for (const im of j.images ?? []) if (!existsSync(DIR + "/" + im.uri)) { missing++; console.log("MISSING texture", im.uri); }
  const s = await stats(f); lights += s.lights;
  for (const [k, e] of s.m) { const a = sum.get(k) ?? { tris: 0, box: new THREE.Box3() }; sum.set(k, a); a.tris += e.tris; a.box.union(e.box); }
}
let bad = 0, tot = 0, totM = 0;
for (const [k, e] of mono.m) {
  const a = sum.get(k); tot += a?.tris ?? 0; totM += e.tris;
  const dbox = a ? Math.max(...["x", "y", "z"].flatMap(c => [Math.abs(a.box.min[c] - e.box.min[c]), Math.abs(a.box.max[c] - e.box.max[c])])) : Infinity;
  if (!a || a.tris !== e.tris || dbox > 1e-3) { if (bad++ < 12) console.log("DIFF", k, "mono", e.tris, "tiles", a?.tris, "bbox delta", dbox); }
}
for (const k of sum.keys()) if (!mono.m.has(k)) { bad++; console.log("EXTRA material in tiles:", k); }
console.log(`materials ${mono.m.size}; tris mono ${totM} tiles ${tot}; lights mono ${mono.lights} tiles ${lights}; missing textures ${missing}; diffs ${bad}`);
const ok = bad === 0 && tot === totM && lights === mono.lights && missing === 0;
console.log(ok ? "PASS" : "FAIL"); process.exit(ok ? 0 : 1);
