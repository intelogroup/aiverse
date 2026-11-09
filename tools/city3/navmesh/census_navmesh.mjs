#!/usr/bin/env node
// census_navmesh.mjs — reachability census for the baked City 3 navmesh:
// the acceptance test for L-A. From the plaza spawn, a path must exist to
// every target a bot may legitimately need to reach. Every failure is a
// named defect with coordinates.
//
// Verdict rule (mirrors gameplay): a target is REACHABLE when
//   (a) it clamps onto the navmesh within 2.0 m in XZ (stand-next-to-it
//       distance: the egg claim radius is 1.5 m), and
//   (b) a computed path from the origin ends within 0.75 m of the
//       clamped point.
// Clamp distance is reported for every target so borderline cases show.
//
// Usage: node census_navmesh.mjs [eggs-ground-truth.json]
// Output: census-results.json next to this script + a summary table.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const NM = join(ROOT, "apps", "console", "node_modules");
const ASSETS = join(ROOT, "apps", "console", "public", "assets");
const { init, NavMeshQuery, importNavMesh } = await import(join(NM, "recast-navigation", "index.mjs"));

const EGGS = process.argv[2] ??
  "/home/hatch/workspace/.build-tmp/experiments/egg-hunt/prep/ground_truth.json";

await init();
const bytes = readFileSync(join(ASSETS, "world-city3-navmesh.bin"));
const { navMesh } = importNavMesh(new Uint8Array(bytes));
const query = new NavMeshQuery(navMesh);

const CLAMP_HE = { x: 3, y: 5, z: 3 };
const clamp = (x, y, z) => {
  const r = query.findClosestPoint({ x, y, z }, { halfExtents: CLAMP_HE });
  return r.success ? r.point : null;
};

// Origin: the plaza ring next to the fountain (production findSpawn lands
// on ground 0.1–0.3 within 40 m of the origin; the ring point at (12, 12)
// is the same surface).
const originRaw = { x: 12, y: 0.2, z: 12 };
const origin = clamp(originRaw.x, originRaw.y, originRaw.z);
if (!origin) {
  console.error("census: origin does not clamp onto the navmesh");
  process.exit(1);
}
console.log(`origin: (${origin.x.toFixed(2)}, ${origin.y.toFixed(2)}, ${origin.z.toFixed(2)})`);

const targets = [];
// 30 eggs (experiment ground truth, all staged in the Bazaar)
const gt = JSON.parse(readFileSync(EGGS, "utf8"));
for (const e of gt.eggs) targets.push({ group: "egg", id: e.id, x: e.pos[0], y: 0.7, z: e.pos[1] });
// 158 places: stand points (where a visitor arrives)
const places = JSON.parse(readFileSync(join(ASSETS, "city3-places.json"), "utf8"));
for (const p of places) targets.push({ group: "place-stand", id: p.id, x: p.stand[0], y: 0.7, z: p.stand[1] });
// 77 rooms: door point (street side) and centre (through the doorway)
const rooms = JSON.parse(readFileSync(join(ASSETS, "interiors", "index.json"), "utf8"));
for (const r of rooms) {
  targets.push({ group: "room-door", id: r.id, x: r.door[0], y: 0.7, z: r.door[1] });
  targets.push({ group: "room-centre", id: r.id, x: r.center[0], y: 0.7, z: r.center[1] });
}
// Named spots
targets.push({ group: "named", id: "mira-patio", x: -26.6, y: 0.2, z: -70.4 });
targets.push({ group: "named", id: "tea-street", x: -22.9167, y: 0.2, z: -71.0 });
targets.push({ group: "named", id: "tea-door", x: -22.9167, y: 0.2, z: -72.5 });
targets.push({ group: "named", id: "tea-interior", x: -22.9167, y: 0.48, z: -75.5 });

const results = [];
for (const t of targets) {
  const c = clamp(t.x, t.y, t.z);
  if (!c) {
    results.push({ ...t, verdict: "NO-CLAMP", clampDist: null, pathLen: null });
    continue;
  }
  const clampDist = Math.hypot(c.x - t.x, c.z - t.z);
  const res = query.computePath(origin, c, {
    halfExtents: { x: 1, y: 2, z: 1 },
    maxPathPolys: 2048,
    maxStraightPathPoints: 1024,
  });
  let pathLen = null;
  let endGap = null;
  if (res.success && res.path && res.path.length > 0) {
    pathLen = 0;
    for (let i = 1; i < res.path.length; i++) {
      const a = res.path[i - 1], b = res.path[i];
      pathLen += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    }
    const end = res.path[res.path.length - 1];
    endGap = Math.hypot(end.x - c.x, end.z - c.z);
  }
  const verdict =
    clampDist > 2.0 ? "FAR-CLAMP" : endGap === null ? "NO-PATH" : endGap > 0.75 ? "PARTIAL" : "OK";
  results.push({
    ...t, verdict,
    clampDist: Math.round(clampDist * 100) / 100,
    clamped: [Math.round(c.x * 100) / 100, Math.round(c.y * 100) / 100, Math.round(c.z * 100) / 100],
    pathLen: pathLen === null ? null : Math.round(pathLen * 10) / 10,
    endGap: endGap === null ? null : Math.round(endGap * 100) / 100,
  });
}

const byGroup = {};
for (const r of results) {
  byGroup[r.group] ??= { total: 0, ok: 0, defects: [] };
  byGroup[r.group].total++;
  if (r.verdict === "OK") byGroup[r.group].ok++;
  else byGroup[r.group].defects.push(r);
}
console.log("\n=== CENSUS ===");
for (const [g, s] of Object.entries(byGroup)) {
  console.log(`${g}: ${s.ok}/${s.total} reachable`);
  for (const d of s.defects) {
    console.log(`  DEFECT ${d.id} (${d.x}, ${d.z}) ${d.verdict} clampDist=${d.clampDist} pathLen=${d.pathLen} endGap=${d.endGap}`);
  }
}
const totalOk = results.filter((r) => r.verdict === "OK").length;
console.log(`TOTAL: ${totalOk}/${results.length}`);
writeFileSync(join(HERE, "census-results.json"), JSON.stringify({ origin, results }, null, 1) + "\n");
