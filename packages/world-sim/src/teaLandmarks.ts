import { bearingDeg } from "./scout";
import { inTeaBuilding, TEA_FLOORS, TEA_RECT, teaFloorAt } from "./teaBuilding";
import { TEA_DOOR_ORIGIN, type TeaDoorState } from "./teaDoor";
import { LIFT, type TeaElevatorController } from "./teaElevator";
import type { Vec3, World } from "./walker";

export const FLOOR_IDS = ["G", "L1", "L2", "L3"] as const;
type FloorId = typeof FLOOR_IDS[number];
type Kind = "stairs" | "elevator" | "restroom";
export type TeaFloorPlan = {
  rooms: { id: string; label: string; kind: string; rect: [number, number, number, number] }[];
  doors: {
    a: string; b: string; axis: "u" | "d"; at: number; center: number;
    mode: "existing-double" | "lift" | "passage" | "hinged" | "external" | "hatch";
  }[];
};

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
  teaRoom?: { id: string; name: string; kind: string };
  teaDoors: TeaDoorObservation[];
};

type TeaDoorObservation = {
  id: string;
  name: string;
  kind: "entrance" | "elevator" | "door" | "passage";
  floorId: FloorId;
  connects: [string, string];
  distanceM: number;
  bearingDeg: number;
  state: TeaDoorState | "blocked" | "unknown";
};

function landingDoorState(lift: TeaElevatorController, level: number): TeaDoorObservation["state"] {
  if (!lift.ready) return "unknown";
  if (lift.floor !== level || !lift.aligned()) return "closed";
  if (lift.phase === "opening" || lift.phase === "closing") return lift.phase;
  if (lift.door === 0) return "closed";
  return lift.canPass(level) ? "open" : "unknown";
}

export function teaLandmarks(
  body: { x: number; y: number; z: number; body: number },
  eye: Vec3,
  world: World,
  viewHeading: number,
  entranceState: TeaDoorState,
  lift: TeaElevatorController,
  levels: readonly TeaFloorPlan[],
): TeaWayfinding {
  const inside = inTeaBuilding(body.x, body.z);
  const level = teaFloorAt(body.y);
  const floor = TEA_FLOORS[level]!;
  if (Math.abs(body.y - floor.y) > 0.65 || (!inside && level !== 0)) return { landmarks: [], teaDoors: [] };
  const floorId = FLOOR_IDS[level]!;
  const floorPlan = levels[level];
  const u = body.x - TEA_RECT[0], d = TEA_RECT[3] - body.z;
  const room = inside
    ? floorPlan?.rooms.find(({ rect: [u0, d0, u1, d1] }) => u >= u0 && u <= u1 && d >= d0 && d <= d1)
    : undefined;
  const label = (id: string) => id === "street" ? "Street" : floorPlan?.rooms.find((candidate) => candidate.id === id)?.label ?? id;
  const relative = (x: number, z: number) => {
    const dx = x - body.x, dz = z - body.z;
    const distanceM = Math.hypot(dx, dz);
    if (distanceM > 25 || Math.abs(bearingDeg(viewHeading, dx, dz)) > 65) return undefined;
    return { distanceM: Number(distanceM.toFixed(2)), bearingDeg: Number(bearingDeg(body.body, dx, dz).toFixed(1)) };
  };
  const teaDoors: TeaDoorObservation[] = [];
  const y = floor.y + 1.5;
  for (const door of floorPlan?.doors ?? []) {
    const entrance = door.mode === "existing-double";
    if (door.mode === "hatch" || (!inside && !entrance)) continue;
    const isLift = door.mode === "lift";
    const x = entrance ? TEA_DOOR_ORIGIN.x : isLift ? LIFT.x : TEA_RECT[0] + (door.axis === "d" ? door.center : door.at);
    const z = entrance ? TEA_DOOR_ORIGIN.z : isLift ? LIFT.doorZ : TEA_RECT[3] - (door.axis === "d" ? door.at : door.center);
    const position = relative(x, z);
    if (!position) continue;
    const nx = door.axis === "u" ? 1 : 0, nz = door.axis === "d" ? 1 : 0;
    const side = Math.sign((body.x - x) * nx + (body.z - z) * nz) || 1;
    // Aim at the near face so a closed door does not hide its own label.
    if (world.sightBlocked?.(eye, [x + side * nx * .28, y, z + side * nz * .28])) continue;
    const kind = entrance ? "entrance" : isLift ? "elevator" : door.mode === "passage" ? "passage" : "door";
    // Other doors are fixed geometry. Test the opening instead of inventing a live hinge state.
    const state = entrance ? entranceState : isLift ? landingDoorState(lift, level)
      : world.sightBlocked?.([x - nx * .55, y, z - nz * .55], [x + nx * .55, y, z + nz * .55]) ? "blocked" : "open";
    teaDoors.push({
      id: entrance ? "tea" : `tea-${floorId}-door-${door.a}-${door.b}`,
      name: entrance ? "Main entrance" : label(door.b), kind, floorId,
      connects: [label(door.a), label(door.b)], ...position, state,
    });
  }
  teaDoors.sort((a, b) => a.distanceM - b.distanceM);
  if (!inside) return { landmarks: [], teaDoors };

  const liftReady = lift.ready && lift.phase !== "unavailable";
  const facilities = level < 2
    ? [accessibleRestroom, restroom]
    : [{ ...accessibleRestroom, name: "Shared restroom and shower" }];
  const authored = [...(level === 0 ? groundStairs : upperStairs), elevator, ...facilities];
  const landmarks: WorldLandmark[] = [];
  for (const marker of authored) {
    const x = TEA_RECT[0] + marker.point[0], z = TEA_RECT[3] - marker.point[1];
    const position = relative(x, z);
    if (!position) continue;
    if (world.sightBlocked?.(eye, [x, floor.y + 1.5, z])) continue;
    const id = `tea-${floorId}-${marker.id}`;
    landmarks.push({
      id, name: marker.name, kind: marker.kind, floorId, ...position,
      access: marker.kind === "elevator" && liftReady ? "usable" : marker.access,
      ...(marker.kind === "elevator" && liftReady
        ? { actions: FLOOR_IDS.filter((floor) => floor !== floorId).map((floor) => ({ type: "ride_elevator", target: id, floor })) } : {}),
    });
  }
  landmarks.sort((a, b) => a.distanceM - b.distanceM);
  return {
    floor: { id: floorId, label: floor.label, elevationM: floor.y }, landmarks, teaDoors,
    ...(room ? { teaRoom: { id: `tea-${floorId}-room-${room.id}`, name: room.label, kind: room.kind } } : {}),
  };
}
