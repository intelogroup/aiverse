#!/usr/bin/env bun
// Collapse per-yaw house GLB duplicates: keep ONE detail + ONE far file per model and record the
// lot's yaw in the manifest as `rotationY`, which DistrictWorld applies at load.
//
// place_house.mjs bakes the yaw into the vertices (flatten()), so a model placed at two angles
// shipped two full GLBs. Across 10 models that duplication is 70.7 MB of detail and ~8 MB of far
// stand-ins. Collision is left alone on purpose: those files are already baked per lot, so
// rotating them again would double the yaw and put walls in the wrong place.
//
//   bun tools/city3/collapse_yaw_variants.mjs            # dry: report only
//   bun tools/city3/collapse_yaw_variants.mjs --delete   # rewrite manifest, drop unreferenced files
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";

const A = "apps/console/public/assets";
const APPLY = process.argv.includes("--delete");
const manPath = `${A}/districts.json`;
const man = JSON.parse(readFileSync(manPath, "utf8"));

const re = /^(.*)-y(0|90|180|270)\.glb$/;
/** Parse the model and yaw from the BASENAME: the url carries /assets/houses/ in front, and
 *  using it whole built `/assets/houses//assets/houses/cabin-y0.glb`, which matched no file and
 *  made every real GLB look unreferenced (caught by a dry run before anything was deleted). */
const parse = (url) => { const m = re.exec(url.split("/").pop() ?? ""); return m ? { model: m[1], yaw: Number(m[2]) } : null; };
const houses = man.districts.filter((d) => d.id.startsWith("house-") && parse(d.url));
const byModel = new Map();
for (const d of houses) {
  const { model, yaw } = parse(d.url);
  if (!byModel.has(model)) byModel.set(model, []);
  byModel.get(model).push({ d, yaw });
}

let changed = 0, savedDetail = 0, savedFar = 0;
for (const [model, lots] of byModel) {
  // keep the biggest detail file (so the deleted copies are the small ones); ties prefer yaw 0
  const candidates = [...new Set(lots.map((l) => l.yaw))].sort();
  let canon = candidates[0];
  try {
    canon = candidates.sort((a, b) => {
      const sa = statSync(`${A}/houses/${model}-y${a}.glb`).size;
      const sb = statSync(`${A}/houses/${model}-y${b}.glb`).size;
      return sb - sa || a - b;
    })[0];
  } catch { /* keep candidates[0] */ }

  for (const { d, yaw } of lots) {
    const delta = (yaw - canon + 360) % 360;
    const near = `/assets/houses/${model}-y${canon}.glb`;
    const far = `/assets/houses/${model}-y${canon}.far.glb`;
    const before = `${d.url}|${d.farUrl ?? ""}|${d.rotationY ?? 0}`;
    d.url = near;
    if (d.farUrl) d.farUrl = far;
    if (delta === 0) delete d.rotationY; else d.rotationY = delta;
    const after = `${d.url}|${d.farUrl ?? ""}|${d.rotationY ?? 0}`;
    if (before !== after) { changed++; console.log(`  ${d.id.padEnd(22)} y${yaw} -> ${model}-y${canon} rotationY=${delta}`); }
  }
  for (const y of candidates) if (y !== canon) {
    for (const suffix of [".glb", ".far.glb"]) {
      const p = `${A}/houses/${model}-y${y}${suffix}`;
      if (!existsSync(p)) continue;
      const sz = statSync(p).size;
      if (suffix === ".glb") savedDetail += sz; else savedFar += sz;
      console.log(`    drop ${model}-y${y}${suffix} (${(sz / 1e6).toFixed(1)} MB)`);
      if (APPLY) unlinkSync(p);
    }
  }
}

// any house file no district references any more (col files stay: they are baked per lot)
const referenced = new Set(man.districts.flatMap((d) => [d.url, d.collisionUrl, d.farUrl].filter(Boolean)));
const stray = readdirSync(`${A}/houses`)
  .filter((f) => f.endsWith(".glb"))
  .filter((f) => !referenced.has(`/assets/houses/${f}`));
if (stray.length) {
  console.log(`\n  ${stray.length} file(s) no district references:`);
  for (const f of stray) {
    const p = `${A}/houses/${f}`;
    if (!existsSync(p)) continue;                      // already dropped by the per-model loop above
    console.log(`    ${APPLY ? "delete" : "would delete"} ${f} (${(statSync(p).size / 1e6).toFixed(1)} MB)`);
    if (APPLY) unlinkSync(p);
  }
}

console.log(`\n${changed} district(s) rewritten; redundant detail ${(savedDetail / 1e6).toFixed(1)} MB, far ${(savedFar / 1e6).toFixed(1)} MB`);
if (!APPLY) { console.log("dry run — rerun with --delete"); process.exit(0); }
writeFileSync(manPath, JSON.stringify(man, null, 1));
console.log("wrote", manPath);

// the CDN staging map must not advertise files that no longer exist
const stagedPath = "apps/console/src/lib/staged-assets.json";
const staged = JSON.parse(readFileSync(stagedPath, "utf8"));
const gone = Object.entries(staged).filter(([, key]) => !existsSync(`${A}/houses/${key.split("/").pop()}`) && key.includes("/houses/"));
if (gone.length) {
  for (const [k] of gone) delete staged[k];
  writeFileSync(stagedPath, JSON.stringify(staged, null, 2) + "\n");
  console.log(`pruned ${gone.length} stale staged-assets key(s)`);
}
