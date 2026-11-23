// Top-down footprint of City 3 from the collision GLB (the latest file in the repo), world space, for the replay map.
// Output: {walls: [x0,z0,x1,z1, ...] (vertical faces seen from above: building outlines), tris: [x0,z0,x1,z1,x2,z2, ...] (small horizontal faces:
// roofs, benches, stalls; huge ground planes are skipped), bounds}. NOTE: imports `three`, so run it from packages/world-sim
// (e.g. copy it to packages/world-sim/node/ and `bun run` it there).
import { readFile, writeFile } from "node:fs/promises";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

const [glb, out] = [process.argv[2], process.argv[3]];
const buf = await readFile(glb);
const scene = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, "")).scene;
scene.updateMatrixWorld(true);
const tris: number[] = [];
const walls: number[] = [];
const v = new THREE.Vector3();
let meshes = 0, minY = Infinity, maxY = -Infinity;
scene.traverse((o) => {
  const m = o as THREE.Mesh;
  if (!m.isMesh) return;
  meshes++;
  const pos = m.geometry.getAttribute("position"); const idx = m.geometry.getIndex();
  const get = (i: number) => { v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld); minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y); return [v.x, v.z]; };
  const n = idx ? idx.count : pos.count;
  for (let i = 0; i < n; i += 3) {
    const a = get(idx ? idx.getX(i) : i), b = get(idx ? idx.getX(i + 1) : i + 1), c = get(idx ? idx.getX(i + 2) : i + 2);
    const area2 = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
    if (area2 < 1e-4) {
      // a vertical face: from above it is a line; keep its two farthest-apart points
      const pts = [a, b, c]; let best = [a, b], bd = -1;
      for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) { const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]); if (d > bd) { bd = d; best = [pts[i], pts[j]]; } }
      if (bd > 0.05) walls.push(+best[0][0].toFixed(2), +best[0][1].toFixed(2), +best[1][0].toFixed(2), +best[1][1].toFixed(2));
      continue;
    }
    if (area2 / 2 > 300) continue; // ground planes
    tris.push(+a[0].toFixed(2), +a[1].toFixed(2), +b[0].toFixed(2), +b[1].toFixed(2), +c[0].toFixed(2), +c[1].toFixed(2));
  }
});
const all = [...tris, ...walls]; const xs = all.filter((_, i) => i % 2 === 0), zs = all.filter((_, i) => i % 2 === 1);
const bounds = { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs), minY, maxY };
await writeFile(out, JSON.stringify({ walls, tris, bounds }));
console.log(`${meshes} meshes, ${walls.length / 4} wall segments, ${tris.length / 6} small triangles, bounds`, JSON.stringify(bounds));
