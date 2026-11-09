#!/usr/bin/env node
// bake_navmesh.mjs — bake the City 3 (Sunstone Bazaar) tiled navmesh from the
// extracted collision triangle soup (collision-geom.bin, produced by
// extract_collision.py from world-city3-collision.glb — the walkable truth).
//
// Library: recast-navigation (Recast/Detour WASM), the same stack
// locomotion.ts runs in the console. Build is TILED (51.2 m tiles at cs 0.2)
// so districts stream and rebake independently.
//
// Recast config convention (proven by locomotion.ts's spike): walkableHeight
// / walkableClimb / walkableRadius / tileSize are in VOXEL units; the world
// values they encode are recorded in the manifest both ways.
//
// Usage: node bake_navmesh.mjs [--out <dir>]   (defaults: repo public/assets)
// Run from apps/console (needs its node_modules) or with NODE_PATH set.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { init, NavMeshQuery, exportNavMesh, getNavMeshPositionsAndIndices } from "recast-navigation";
import { generateTiledNavMesh } from "recast-navigation/generators";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, "..", "..", "..", "apps", "console", "public", "assets");
const outDir = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : ASSETS;

// ---- agent + bake parameters (world values; voxel conversions below) ----
const PARAMS = {
  agentRadius: 0.35, // m — same constant as locomotion.ts AGENT_RADIUS
  agentHeight: 1.8, // m
  maxClimb: 0.4, // m — matches walker.ts stepUp
  maxSlopeDeg: 45, // stairs must bake walkable
  cellSize: 0.2, // m — 1 m doorways must survive voxelization
  cellHeight: 0.2, // m
  tileSizeM: 51.2, // m per tile edge (256 voxels)
};

const cs = PARAMS.cellSize;
const ch = PARAMS.cellHeight;
const config = {
  cs,
  ch,
  walkableSlopeAngle: PARAMS.maxSlopeDeg,
  walkableHeight: Math.ceil(PARAMS.agentHeight / ch), // voxels
  walkableClimb: Math.floor(PARAMS.maxClimb / ch), // voxels
  walkableRadius: Math.ceil(PARAMS.agentRadius / cs), // voxels
  tileSize: Math.round(PARAMS.tileSizeM / cs), // voxels
  maxEdgeLen: 12,
  maxSimplificationError: 0.8, // tight: doorways must not simplify shut
  minRegionArea: 8,
  mergeRegionArea: 20,
  maxVertsPerPoly: 6,
  detailSampleDist: 6,
  detailSampleMaxError: 1,
};

// ---- input geometry ----
const geomBin = readFileSync(join(HERE, "collision-geom.bin"));
const geomMeta = JSON.parse(readFileSync(join(HERE, "collision-geom.bin.json"), "utf8"));
const nVerts = geomBin.readUInt32LE(0);
const positions = new Float32Array(geomBin.buffer, geomBin.byteOffset + 4, nVerts * 3);
const idxOff = 4 + nVerts * 3 * 4;
const nIdx = geomBin.readUInt32LE(idxOff);
const indices = new Uint32Array(geomBin.buffer, geomBin.byteOffset + idxOff + 4, nIdx);
console.log(`geometry: ${nVerts} verts, ${nIdx / 3} tris`);

await init();
const t0 = Date.now();
const gen = generateTiledNavMesh(positions, indices, config);
if (!gen.success) {
  console.error("BAKE FAILED:", gen.error);
  process.exit(1);
}
const navMesh = gen.navMesh;
console.log(`bake: ${Date.now() - t0} ms`);

// ---- stats: polys, tiles, walkable area (from the detail geometry) ----
let polyCount = 0;
let tileCount = 0;
const maxTiles = navMesh.getMaxTiles?.() ?? 0;
for (let i = 0; i < maxTiles; i++) {
  const tile = navMesh.getTile(i);
  if (tile?.data?.header && tile.data.header.polyCount > 0) {
    tileCount++;
    polyCount += tile.data.header.polyCount;
  }
}
const dbg = getNavMeshPositionsAndIndices(navMesh);
let walkableArea = 0;
for (let i = 0; i < dbg.indices.length; i += 3) {
  const a = dbg.indices[i] * 3, b = dbg.indices[i + 1] * 3, c = dbg.indices[i + 2] * 3;
  const ux = dbg.positions[b] - dbg.positions[a], uz = dbg.positions[b + 2] - dbg.positions[a + 2];
  const vx = dbg.positions[c] - dbg.positions[a], vz = dbg.positions[c + 2] - dbg.positions[a + 2];
  walkableArea += 0.5 * Math.abs(ux * vz - vx * uz);
}

// Sanity: the query must answer on the plaza before we ship the artifact.
const query = new NavMeshQuery(navMesh);
const probe = query.findClosestPoint({ x: 0, y: 0.2, z: 0 }, { halfExtents: { x: 6, y: 4, z: 6 } });
if (!probe.success) {
  console.error("BAKE FAILED sanity probe: no navmesh near plaza origin");
  process.exit(1);
}

// ---- write artifact + manifest ----
const bytes = exportNavMesh(navMesh);
const binPath = join(outDir, "world-city3-navmesh.bin");
writeFileSync(binPath, bytes);
const glbPath = join(ASSETS, "world-city3-collision.glb");
const glbBytes = readFileSync(glbPath);
const manifest = {
  version: 1,
  district: "bazaar",
  artifact: "world-city3-navmesh.bin",
  bytes: bytes.length,
  source: {
    glb: "world-city3-collision.glb",
    glbBytes: glbBytes.length,
    glbSha256: createHash("sha256").update(glbBytes).digest("hex"),
    geomVerts: geomMeta.verts,
    geomTris: geomMeta.tris,
  },
  params: {
    ...PARAMS,
    walkableHeightVoxels: config.walkableHeight,
    walkableClimbVoxels: config.walkableClimb,
    walkableRadiusVoxels: config.walkableRadius,
    tileSizeVoxels: config.tileSize,
    maxSimplificationError: config.maxSimplificationError,
  },
  result: {
    polyCount,
    tileCount,
    walkableAreaM2: Math.round(walkableArea * 10) / 10,
    bounds: geomMeta.bounds,
    plazaProbe: { x: probe.point.x, y: probe.point.y, z: probe.point.z },
  },
  generator: "recast-navigation 0.44.0 (generateTiledNavMesh + exportNavMesh)",
  rebake: "tools/city3/navmesh/extract_collision.py && node tools/city3/navmesh/bake_navmesh.mjs",
};
writeFileSync(join(outDir, "world-city3-navmesh.json"), JSON.stringify(manifest, null, 1) + "\n");
console.log(`wrote ${binPath} (${bytes.length} bytes)`);
console.log(`polys: ${polyCount}, tiles: ${tileCount}, walkable: ${manifest.result.walkableAreaM2} m^2`);
console.log(`plaza probe -> (${probe.point.x.toFixed(2)}, ${probe.point.y.toFixed(2)}, ${probe.point.z.toFixed(2)})`);
