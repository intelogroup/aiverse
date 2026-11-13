#!/usr/bin/env bun
// Split the far shell's `shell_bazaar` massing into one `shell_<tileId>` node per world tile, so the runtime's existing rule
// (a shell group hides once its district id is loaded) hides massing tile by tile instead of carpeting loaded detail.
//   bun tools/city3/split_shell.mjs <world-shell.glb> <tilesDir>     writes <tilesDir>/shell.<hash>.glb
// Other districts' shell nodes pass through untouched.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshoptCompression } from "@gltf-transform/extensions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { makeCellOf, leafOfCell, subset } from "./tile_grid.mjs";
const [IN, DIR] = process.argv.slice(2);
const BIG_TRI = 40, FROM = "shell_bazaar";
const T = JSON.parse(readFileSync(`${DIR}/tiles.json`, "utf8"));
const layoutIds = T.layout.map(t => t.id), core = T.layout.findIndex(t => t.core);
const cellOf = makeCellOf(T.heroes), leaf = leafOfCell(T.layout, T.heroes);
await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });
const doc = await io.read(IN); const scene = doc.getRoot().listScenes()[0];
const node = scene.listChildren().find(n => n.getName() === FROM); if (!node) throw new Error(`${FROM} not found`);
const M = node.getWorldMatrix(); const mesh = node.getMesh();
const byLeaf = new Map(); // leaf index -> [{prim, tris[]}]
for (const prim of mesh.listPrimitives()) {
  const pos = prim.getAttribute("POSITION").getArray(), idx = prim.getIndices()?.getArray(); const nt = (idx ? idx.length : pos.length / 3) / 3; const per = new Map();
  for (let t = 0; t < nt; t++) {
    let cx = 0, cz = 0, x0 = 1e18, x1 = -1e18, z0 = 1e18, z1 = -1e18;
    for (let k = 0; k < 3; k++) { const v = idx ? idx[t * 3 + k] : t * 3 + k; const X = M[0] * pos[v * 3] + M[4] * pos[v * 3 + 1] + M[8] * pos[v * 3 + 2] + M[12], Z = M[2] * pos[v * 3] + M[6] * pos[v * 3 + 1] + M[10] * pos[v * 3 + 2] + M[14]; cx += X; cz += Z; x0 = Math.min(x0, X); x1 = Math.max(x1, X); z0 = Math.min(z0, Z); z1 = Math.max(z1, Z); }
    const li = Math.max(x1 - x0, z1 - z0) > BIG_TRI ? core : leaf[cellOf(cx / 3, cz / 3)];
    (per.get(li) ?? per.set(li, []).get(li)).push(t);
  }
  for (const [li, tris] of per) (byLeaf.get(li) ?? byLeaf.set(li, []).get(li)).push({ prim, tris });
}
let total = 0;
for (const [li, parts] of byLeaf) {
  const m = doc.createMesh(`${FROM}_${layoutIds[li]}`);
  for (const { prim, tris } of parts) { const p = prim.clone(); subset(doc, p, Int32Array.from(tris)); m.addPrimitive(p); total += tris.length; }
  scene.addChild(doc.createNode(`shell_${layoutIds[li]}`).setMesh(m));
}
const before = mesh.listPrimitives().reduce((a, p) => a + (p.getIndices()?.getCount() ?? p.getAttribute("POSITION").getCount()) / 3, 0);
if (total !== before) throw new Error(`triangles lost: ${before} -> ${total}`);
node.dispose(); mesh.listPrimitives().forEach(p => p.dispose()); mesh.dispose();
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE }); // bytes only, no position filter
const out = Buffer.from(await io.writeBinary(doc)); const name = `shell.${createHash("sha1").update(out).digest("hex").slice(0, 10)}.glb`;
writeFileSync(`${DIR}/${name}`, out);
console.log(`${name}: ${byLeaf.size} shell pieces, ${total} tris, ${(out.length / 1024).toFixed(0)} KB`);
