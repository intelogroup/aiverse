#!/usr/bin/env bun
// Compress the placed-house near GLBs with EXT_meshopt_compression.
//
// WHY: place_house.mjs wrote the near <model>-y<yaw>.glb uncompressed while house_lods.mjs
// compresses every .far.glb at level "high". The asymmetry was the whole weight problem:
// near houses weighed 316 MB for 29 files (cabin-y90.glb alone 49.0 MB / 766,467 tris,
// cozy-cottage-y0.glb 37.9 MB / 818,648 tris) against 22.6 MB for the 29 compressed far
// files. meshopt is lossless for geometry here -- it changes the encoding, not the mesh --
// so triangle counts stay identical and the browser decodes them like the bazaar already does.
//
// Idempotent: files that already declare EXT_meshopt_compression are skipped.
//   bun tools/city3/house_compress.mjs [--dry]
// Then re-baseline the gate: bun tools/city3/house_budgets.mjs
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { meshopt } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import { readdirSync, statSync } from "node:fs";

const H = "apps/console/public/assets/houses";
const dry = process.argv.includes("--dry");

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "meshopt.decoder": MeshoptDecoder,
  "meshopt.encoder": MeshoptEncoder,
});
await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);

const tris = (doc) =>
  doc.getRoot().listMeshes().reduce((a, m) => a + m.listPrimitives().reduce((b, p) =>
    b + (p.getIndices()?.getCount() ?? p.getAttribute("POSITION")?.getCount() ?? 0) / 3, 0), 0);

let before = 0, after = 0, n = 0, skipped = 0;
for (const f of readdirSync(H).sort()) {
  if (!f.endsWith(".glb") || f.endsWith(".far.glb") || f.endsWith(".col.glb")) continue;
  const p = `${H}/${f}`;
  const doc = await io.read(p);
  const used = doc.getRoot().listExtensionsUsed().map((e) => e.extensionName);
  if (used.includes("EXT_meshopt_compression")) { skipped++; continue; }
  const t0 = tris(doc);
  const b0 = statSync(p).size;
  let b1, t1;
  if (dry) {
    // measure the real encoded size without touching the file
    await doc.transform(meshopt({ encoder: MeshoptEncoder, level: "high" }));
    b1 = (await io.writeBinary(doc)).byteLength;
    t1 = tris(doc);
  } else {
    await doc.transform(meshopt({ encoder: MeshoptEncoder, level: "high" }));
    await io.write(p, doc);
    b1 = statSync(p).size;
    t1 = tris(await io.read(p));   // re-read: proves the written file still parses
  }
  if (t1 !== t0) throw new Error(`${f}: triangle count changed ${t0} -> ${t1}; refusing`);
  before += b0; after += b1; n++;
  console.log(`${f.padEnd(30)} ${(b0 / 1e6).toFixed(1).padStart(6)} -> ${(b1 / 1e6).toFixed(2).padStart(6)} MB  (${(t0 / 1000).toFixed(0)}k tris, unchanged)`);
}
console.log(`\n${n} compressed, ${skipped} already compressed | total ${(before / 1e6).toFixed(1)} -> ${(after / 1e6).toFixed(1)} MB (${(100 * (before - after) / Math.max(1, before)).toFixed(1)}% smaller)`);
