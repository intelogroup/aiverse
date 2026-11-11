// node/bakeNavmesh.ts — bake the City 3 navmesh the server sim plans routes on.   usage: bun run packages/world-sim/node/bakeNavmesh.ts
//
// Geometry is the sim's own collision sets (the same meshes the walker collides with, loaded the way the sim loads them), so the mesh
// and the walker cannot disagree about where the world is. Output: packages/world-sim/data/world-city3-navmesh.{bin,json}; the json records
// the sha256 of the collision GLB it was baked from, and a test fails when the GLB changes without a rebake.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { exportNavMesh, init } from "recast-navigation";
import { generateTiledNavMesh } from "@recast-navigation/generators";
import { loadVerseSim } from "./loadWorld";

const ASSETS = new URL("../../../apps/console/public/assets", import.meta.url).pathname;
const OUT = new URL("../data/", import.meta.url).pathname;

/** World values; Recast wants voxels, converted below. */
export const BAKE_PARAMS = {
  /** The walker's body radius (WALK_CONFIG.radius): the mesh is eroded by exactly the radius the walker collides with. */
  agentRadius: 0.4,
  agentHeight: 1.8,
  /**
   * Below the walker's step-up (0.4): with 0.2 m cells Recast rounds a climb up, and a 0.5 m curb read as climbable while the walker
   * could not step onto it (the body stalled in front of it). 0.31 m at 0.1 m cells keeps every real stair (risers <= 0.25) walkable.
   */
  maxClimb: 0.31,
  maxSlopeDeg: 45,
  cellSize: 0.2,
  cellHeight: 0.1,
  tileSizeM: 51.2,
};

export async function bake(): Promise<{ bytes: Uint8Array; manifest: Record<string, unknown> }> {
  const { sim } = await loadVerseSim(ASSETS, { navBin: false });
  // Everything the walker collides with except the Tea House door blocker (the door machine opens it on the way): the Bazaar, every
  // district, and the furniture boxes of the hero rooms. A mesh baked from the Bazaar alone sent bodies through booths and tables.
  const keys = sim.walk.stats().sets.filter((k) => k !== "door:tea");
  const meshes = keys.flatMap((k) => sim.walk.get(k) ?? []);
  if (!sim.walk.has("resident") || !meshes.length) throw new Error("no collision to bake from");
  const pos: number[] = [];
  const idx: number[] = [];
  for (const m of meshes) {
    const p = m.geometry.getAttribute("position");
    const base = pos.length / 3;
    for (let i = 0; i < p.count; i++) pos.push(p.getX(i), p.getY(i), p.getZ(i));
    const ix = m.geometry.index;
    if (ix) for (let i = 0; i < ix.count; i++) idx.push(base + ix.getX(i));
    else for (let i = 0; i < p.count; i++) idx.push(base + i);
  }
  const P = BAKE_PARAMS;
  const config = {
    cs: P.cellSize,
    ch: P.cellHeight,
    walkableSlopeAngle: P.maxSlopeDeg,
    walkableHeight: Math.ceil(P.agentHeight / P.cellHeight),
    walkableClimb: Math.floor(P.maxClimb / P.cellHeight + 1e-6),
    walkableRadius: Math.ceil(P.agentRadius / P.cellSize - 1e-6),
    tileSize: Math.round(P.tileSizeM / P.cellSize),
    maxEdgeLen: 12,
    maxSimplificationError: 0.8, // tight: doorways must not simplify shut
    minRegionArea: 8,
    mergeRegionArea: 20,
    maxVertsPerPoly: 6,
    detailSampleDist: 6,
    detailSampleMaxError: 1,
  };
  await init();
  const gen = generateTiledNavMesh(new Float32Array(pos), new Uint32Array(idx), config);
  if (!gen.success) throw new Error(`navmesh bake failed: ${gen.error}`);
  const bytes = exportNavMesh(gen.navMesh);
  const glb = await readFile(`${ASSETS}/world-city3-collision.glb`);
  return {
    bytes,
    manifest: {
      version: 1,
      artifact: "world-city3-navmesh.bin",
      bytes: bytes.length,
      source: { glb: "world-city3-collision.glb", glbSha256: createHash("sha256").update(glb).digest("hex"), tris: idx.length / 3, sets: keys.length },
      params: { ...P, walkableHeightVoxels: config.walkableHeight, walkableClimbVoxels: config.walkableClimb, walkableRadiusVoxels: config.walkableRadius },
      generator: "recast-navigation 0.44.0 generateTiledNavMesh + exportNavMesh",
      rebake: "bun run packages/world-sim/node/bakeNavmesh.ts",
    },
  };
}

if (import.meta.main) {
  const { bytes, manifest } = await bake();
  await writeFile(`${OUT}world-city3-navmesh.bin`, bytes);
  await writeFile(`${OUT}world-city3-navmesh.json`, JSON.stringify(manifest, null, 1) + "\n");
  console.log(`wrote ${bytes.length} bytes to ${OUT}`, JSON.stringify((manifest as any).source));
}
