#!/usr/bin/env bun
// Far versions of the placed houses, so a house is seen from across the city (the opening aerial) before its detailed GLB streams in.
// Preserve surface borders, folds and texture seams during simplification. Texture maps are capped at 256 px.
// Run after tools/city3/houses.sh (place_house rewrites the district rows without farUrl).
//   bun tools/city3/house_lods.mjs
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { compactPrimitive, dedup, flatten, join, meshopt, prune, weld } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";

const A = "apps/console/public/assets", H = `${A}/houses`;
const only = process.argv[2];
const mp = `${A}/districts.json`;
const man = JSON.parse(readFileSync(mp, "utf8"));
const houses = man.districts.filter(d => d.id.startsWith("house-"));
const files = [...new Set(houses.map(d => d.url.split("/").at(-1)))].sort();
if (only && !files.includes(only)) throw new Error(`No placed house uses ${only}`);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "meshopt.decoder": MeshoptDecoder,
  "meshopt.encoder": MeshoptEncoder,
});
await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
for (const f of only ? [only] : files) {
  const out = `${H}/${f.replace(/\.glb$/, ".far.glb")}`;
  const doc = await io.read(`${H}/${f}`);
  await doc.transform(weld());
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
    const idx = p.getIndices(); if (!idx || p.getMode() !== 4 || idx.getCount() < 300) continue;
    const positions = p.getAttribute("POSITION");
    const src = Uint32Array.from(idx.getArray());
    const pos = Float32Array.from(positions.getArray());
    const norm = p.getAttribute("NORMAL");
    const uv = p.getAttribute("TEXCOORD_0");
    const target = Math.max(90, Math.floor(src.length * 0.14 / 3) * 3);
    const flags = ["Permissive", "PreserveFolds"];
    const attributes = [norm, uv].filter(Boolean);
    let ni;
    if (attributes.length) {
      const weights = [...(norm ? [0.25, 0.25, 0.25] : []), ...(uv ? [0.5, 0.5] : [])];
      const values = new Float32Array(positions.getCount() * weights.length);
      for (let i = 0; i < positions.getCount(); i++) {
        let offset = i * weights.length;
        for (const attribute of attributes) {
          const element = attribute.getElement(i, []);
          values.set(element, offset);
          offset += element.length;
        }
      }
      [ni] = MeshoptSimplifier.simplifyWithAttributes(src, pos, 3, values, weights.length, weights, null, target, 0.018, flags);
    } else {
      [ni] = MeshoptSimplifier.simplify(src, pos, 3, target, 0.018, flags);
    }
    if (!ni.length || ni.length === src.length) continue;
    idx.setArray(Uint32Array.from(ni));
    compactPrimitive(p);   // drop the vertices no triangle uses any more (prune keeps whole attribute arrays)
  }
  // one draw call per material, not per source object (the pool villa has 1345 objects; far houses are all up at once)
  await doc.transform(prune(), dedup(), flatten(), join({ keepNamed: false }), prune());
  // place_house.mjs now ships meshopt-compressed GLBs: write this intermediate plain, slim_textures.py rewrites buffer views it cannot decode
  doc.getRoot().listExtensionsUsed().find((e) => e.extensionName === "EXT_meshopt_compression")?.dispose();
  await io.write(out, doc);
  execFileSync("python3", ["tools/city3/slim_textures.py", out, out, "--max", "256"], { stdio: "ignore" });
  const slim = await io.read(out);
  await slim.transform(meshopt({ encoder: MeshoptEncoder, level: "high" }));
  await io.write(out, slim);
  console.log(`${f}: ${(statSync(`${H}/${f}`).size / 1e6).toFixed(1)} MB -> far ${(statSync(out).size / 1e6).toFixed(2)} MB`);
}
for (const d of houses) if (!only || d.url.endsWith(`/${only}`)) d.farUrl = d.url.replace(/\.glb$/, ".far.glb");
writeFileSync(mp, JSON.stringify(man, null, 1));
