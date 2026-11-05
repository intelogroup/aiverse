// cityFootprints.ts — building footprints over the City crowd rectangle,
// measured from the shipped world-city.glb (Blender world-bounds pass,
// 2026-11-05): every mesh that is tall (>= 2.2 m), ground-based and at
// least 2 m in both plan axes, merged where footprints touch. One entry
// per city BLOCK — block interiors (courtyards, alleys) are carved too;
// that is the conservative side and it keeps bots out of buildings for
// good. Three.js XZ space: [minX, minZ, maxX, maxZ], metres.
//
// The crowd navmesh is built from the street rectangle MINUS these
// footprints (buildStreetGeometry in locomotion.ts), so the cast walks
// streets and plazas instead of passing through buildings.

export type Footprint = [number, number, number, number];

export const CITY_FOOTPRINTS: Footprint[] = [
  [-224.3, -117.4, -151.6, -80.0],
  [-205.2, -133.0, -152.8, -117.9],
  [-134.1, -116.7, -115.7, -98.2],
  [-133.6, -134.1, -118.3, -116.8],
  [-133.5, -98.0, -121.5, -87.3],
];

/** True when (x, z) falls inside a footprint inflated by `margin`. */
export function insideFootprint(x: number, z: number, margin = 0): boolean {
  for (const [x0, z0, x1, z1] of CITY_FOOTPRINTS) {
    if (x >= x0 - margin && x <= x1 + margin && z >= z0 - margin && z <= z1 + margin) return true;
  }
  return false;
}
