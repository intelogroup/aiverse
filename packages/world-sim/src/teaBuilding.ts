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
/** Standing eye height above a floor, for views that put the visitor in the room (m). */
export const TEA_EYE_HEIGHT = 1.6;
/**
 * Ground-floor click-to-view framing: the camera stands just inside the main
 * entrance at eye height, looking across the seating toward the bar — the
 * visitor's first view of the room. (The elevated cutaway preset the other
 * floors use put this camera ~15 m over its target, which reads as staring
 * down at the floor.) Door/front/centre come from the room index; the door
 * is the graded main entrance (docs/procedural-city/tea-house/plan.json:
 * existingMainDoor centre u=14.5833 → x=-22.92 on the street frontage
 * z=-72.5, interior floor 0.48). The target sits 6 m in and 4.9 m toward
 * the seating side (the visitor's left), just under eye height, so the gaze
 * stays level through the entry opening: the bar with its bottle shelves
 * and tea service centred, the seating zone at frame left. (The direct
 * line to the placed tea tables crosses the ground floor's partitions;
 * from the doorway they sit at the frame's left edge, as they do for a
 * visitor standing there.)
 */
export function teaEntranceView(room: {
  door: [number, number];
  front: "S" | "N" | "E" | "W";
  center: [number, number];
}): { position: [number, number, number]; target: [number, number, number] } {
  const floorY = TEA_FLOORS[0].y;
  const inward: Record<string, [number, number]> = { S: [0, -1], N: [0, 1], E: [-1, 0], W: [1, 0] };
  const [ix, iz] = inward[room.front];
  const [dx, dz] = room.door;
  return {
    position: [dx + ix * 1.1, floorY + TEA_EYE_HEIGHT, dz + iz * 1.1],
    target: [dx + ix * 6 + iz * 4.9, floorY + 1.05, dz + iz * 6 - ix * 4.9],
  };
}
export function teaCutHeight(level: number, walker?: { x?: number; y?: number; z?: number } | null): number {
  if (walker?.x !== undefined && walker.y !== undefined && walker.z !== undefined && inTeaBuilding(walker.x, walker.z)) return walker.y + 2.1;
  return TEA_FLOORS[level]?.y + 2.1 || TEA_FLOORS[0].y + 2.1;
}
