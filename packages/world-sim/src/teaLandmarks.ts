import { bearingDeg } from "./scout";
import { inTeaBuilding, TEA_FLOORS, teaFloorAt } from "./teaBuilding";
import type { Vec3, World } from "./walker";

export const FLOOR_IDS = ["G", "L1", "L2", "L3"] as const;
type FloorId = typeof FLOOR_IDS[number];
type Kind = "stairs" | "elevator" | "restroom";
type Landmark = {
  id: string;
  name: string;
  kind: Kind;
  /** Doorway or entrance marker, in the Tea House plan's u/d coordinates. */
  point: readonly [u: number, d: number];
  access: "unavailable" | "landmark";
};

// Doorway centres from docs/procedural-city/tea-house/plan.json. The markers
// stop just on the public side of each doorway.
const groundStairs: readonly Landmark[] = [
  { id: "stairs-a", name: "West stairs (Stair A)", kind: "stairs", point: [1.2, 5.48], access: "unavailable" },
  { id: "stairs-b", name: "East stairs (Stair B)", kind: "stairs", point: [20.05, 6.6], access: "unavailable" },
];
const upperStairs: readonly Landmark[] = [
  { ...groundStairs[0]!, point: [1.4, 5.48] },
  { ...groundStairs[1]!, point: [21.5, 5.48] },
];
const elevator: Landmark = {
  id: "elevator", name: "Elevator", kind: "elevator", point: [18.35, 8.15], access: "unavailable",
};
const accessibleRestroom: Landmark = {
  id: "accessible-restroom", name: "Accessible restroom", kind: "restroom", point: [13.9, 8.15], access: "landmark",
};
const restroom: Landmark = {
  id: "restroom", name: "Restroom", kind: "restroom", point: [15.8, 8.15], access: "landmark",
};

export type WorldLandmark = {
  id: string;
  kind: Kind;
  name: string;
  floorId: FloorId;
  distanceM: number;
  bearingDeg: number;
  access: Landmark["access"] | "usable";
  actions?: { type: "ride_elevator"; target: string; floor: FloorId }[];
};

export type TeaWayfinding = {
  floor?: { id: FloorId; label: string; elevationM: number };
  landmarks: WorldLandmark[];
};

export function teaLandmarks(
  body: { x: number; y: number; z: number; body: number },
  eye: Vec3,
  world: World,
  viewHeading: number = body.body,
  liftReady = false,
): TeaWayfinding {
  if (!inTeaBuilding(body.x, body.z)) return { landmarks: [] };
  const level = teaFloorAt(body.y);
  const floor = TEA_FLOORS[level]!;
  if (Math.abs(body.y - floor.y) > 0.65) return { landmarks: [] };
  const floorId = FLOOR_IDS[level]!;
  const facilities = level < 2
    ? [accessibleRestroom, restroom]
    : [{ ...accessibleRestroom, name: "Shared restroom and shower" }];
  const authored = [...(level === 0 ? groundStairs : upperStairs), elevator, ...facilities];
  const landmarks: WorldLandmark[] = [];
  for (const marker of authored) {
    const x = marker.point[0] - 37.5;
    const z = -72.5 - marker.point[1];
    const dx = x - body.x, dz = z - body.z;
    const distanceM = Math.hypot(dx, dz);
    if (distanceM > 25 || Math.abs(bearingDeg(viewHeading, dx, dz)) > 65) continue;
    if (world.sightBlocked?.(eye, [x, floor.y + 1.5, z])) continue;
    const id = `tea-${floorId}-${marker.id}`;
    landmarks.push({
      id, name: marker.name, kind: marker.kind, floorId,
      distanceM: Number(distanceM.toFixed(2)), bearingDeg: Number(bearingDeg(body.body, dx, dz).toFixed(1)),
      access: marker.kind === "elevator" && liftReady ? "usable" : marker.access,
      ...(marker.kind === "elevator" && liftReady
        ? { actions: FLOOR_IDS.filter((floor) => floor !== floorId).map((floor) => ({ type: "ride_elevator", target: id, floor })) } : {}),
    });
  }
  landmarks.sort((a, b) => a.distanceM - b.distanceM);
  return { floor: { id: floorId, label: floor.label, elevationM: floor.y }, landmarks };
}
