/** The authored four-floor Tea House, in the same world coordinates as its old entrance. */
export const TEA_FLOORS = [
  { label: "Ground", y: 0.48, name: "Tea House" },
  { label: "First", y: 4.4, name: "Tea salon & community" },
  { label: "Second", y: 7.9, name: "Homes 201–203" },
  { label: "Third", y: 11.4, name: "Homes 301–303" },
] as const;
export const TEA_RECT = [-37.5, -84.5, -12.5, -72.5] as const;
export function inTeaBuilding(x: number, z: number): boolean {
  return x >= TEA_RECT[0] && x <= TEA_RECT[2] && z >= TEA_RECT[1] && z <= TEA_RECT[3];
}
export function teaFloorAt(y: number): number {
  let level = 0;
  for (let i = 1; i < TEA_FLOORS.length; i++) if (y >= TEA_FLOORS[i].y - 0.1) level = i;
  return level;
}
/** Above the cut wall caps, including the camera near-plane footprint. */
export function teaViewTargetHeight(level: number): number { return (TEA_FLOORS[level]?.y ?? .48) + 2.6; }
export function teaCutHeight(level: number, walker?: { x?: number; y?: number; z?: number } | null): number {
  if (walker?.x !== undefined && walker.y !== undefined && walker.z !== undefined && inTeaBuilding(walker.x, walker.z)) return walker.y + 2.1;
  return TEA_FLOORS[level]?.y + 2.1 || TEA_FLOORS[0].y + 2.1;
}
