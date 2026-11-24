#!/usr/bin/env bun
// Far versions of the placed houses, so a house is seen from across the city (the opening aerial) before its detailed GLB streams in.
// For every houses/<name>.glb: weld + sloppy meshopt simplify to ~4% of the triangles (unused vertices compacted away) -> houses/<name>.far.glb (textures then capped at 256 px by
// slim_textures.py), and every house-* district in districts.json gets farUrl. The console keeps each far house up until its detail mounts.
// Run after tools/city3/houses.sh (place_house rewrites the district rows without farUrl).
//   bun tools/city3/house_lods.mjs
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { compactPrimitive, prune, weld } from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

const A = "apps/console/public/assets", H = `${A}/houses`;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
await MeshoptSimplifier.ready;
for (const f of readdirSync(H).filter((f) => f.endsWith(".glb") && !f.endsWith(".col.glb") && !f.endsWith(".far.glb")).sort()) {
  const out = `${H}/${f.replace(/\.glb$/, ".far.glb")}`;
  const doc = await io.read(`${H}/${f}`);
  // topology-blind (sloppy) simplification: UV and normal seams stop the regular simplifier near 35%, and from far a silhouette is enough
  await doc.transform(weld());
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
    const idx = p.getIndices(); if (!idx || p.getMode() !== 4 || idx.getCount() < 300) continue;
    const pos = p.getAttribute("POSITION").getArray(), src = Uint32Array.from(idx.getArray());
    const [ni] = MeshoptSimplifier.simplifySloppy(src, pos, 3, null, Math.max(30, Math.floor(src.length * 0.04 / 3) * 3), 0.05);
    idx.setArray(Uint32Array.from(ni));
    compactPrimitive(p);   // drop the vertices no triangle uses any more (prune keeps whole attribute arrays)
  }
  await doc.transform(prune());
  await io.write(out, doc);
  execFileSync("python3", ["tools/city3/slim_textures.py", out, out, "--max", "256"], { stdio: "ignore" });
  console.log(`${f}: ${(statSync(`${H}/${f}`).size / 1e6).toFixed(1)} MB -> far ${(statSync(out).size / 1e6).toFixed(2)} MB`);
}
const mp = `${A}/districts.json`, man = JSON.parse(readFileSync(mp, "utf8"));
for (const d of man.districts) if (d.id.startsWith("house-")) d.farUrl = d.url.replace(/\.glb$/, ".far.glb");
writeFileSync(mp, JSON.stringify(man, null, 1));
