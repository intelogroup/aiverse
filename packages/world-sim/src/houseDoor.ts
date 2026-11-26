// A hinged house front door that opens when a body comes near (or on request) and blocks the doorway until it is fully open.
// One per room that carries a `doorLeaf` spec in interiors/index.json (tools/city3/house_doors.mjs writes them). The Tea House
// door is a different machine (teaDoor.ts: grasp clips, sessions); this one only swings.

/** Leaf placement, three.js world space. (x, y, z) is the bottom centre of the closed leaf; the door's local frame is the house
 * model's: +z out to the street, +x along the opening. `yaw` is the house's rotationY in degrees (same convention as boxesMesh:
 * x' = x cos + z sin, z' = -x sin + z cos). `hinge` names the jamb the leaf turns on, seen from the street. `leaf` is a GLB authored
 * with its hinge at the origin, spanning x 0..width, y 0..height; without one the console draws a plain slab. */
export interface DoorLeafSpec {
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  thick?: number;
  yaw: number;
  hinge?: "left" | "right";
  leaf?: string;
}

export const DOOR_KEY_PREFIX = "door:";
export const doorKey = (room: string): string => `${DOOR_KEY_PREFIX}${room}`;
/** Seconds from shut to fully open (and back). */
export const DOOR_SWING_S = 0.55;
/** Seconds the door stays open after the last body leaves its zone. */
export const DOOR_HOLD_S = 2;

const rad = (d: DoorLeafSpec) => (d.yaw * Math.PI) / 180;

/** The closed leaf as a capsule-world box: [cx, cz, hx, hz, y0, y1, rotY]. */
export function doorBox(d: DoorLeafSpec): [number, number, number, number, number, number, number] {
  return [d.x, d.z, d.width / 2, 0.045, d.y, d.y + d.height, rad(d)];
}

/** World (x, z) to the door's local frame (inverse of the yaw rotation). */
export function doorLocal(d: DoorLeafSpec, x: number, z: number): [number, number] {
  const wx = x - d.x, wz = z - d.z, c = Math.cos(rad(d)), s = Math.sin(rad(d));
  return [wx * c - wz * s, wx * s + wz * c];
}

/** The hinge pivot in world space and the sign the leaf turns by so it swings into the house (local -z). */
export function doorHinge(d: DoorLeafSpec): { x: number; z: number; sign: 1 | -1 } {
  const lx = d.hinge === "right" ? d.width / 2 : -d.width / 2, c = Math.cos(rad(d)), s = Math.sin(rad(d));
  return { x: d.x + lx * c, z: d.z - lx * s, sign: d.hinge === "right" ? -1 : 1 };
}

type Position = { x?: number; y?: number; z?: number };

export class HouseDoor {
  openness = 0;
  private hold = 0;
  readonly spec: DoorLeafSpec;
  private readonly setBlocked: (blocked: boolean) => void;

  constructor(spec: DoorLeafSpec, setBlocked: (blocked: boolean) => void) {
    this.spec = spec;
    this.setBlocked = setBlocked;
    setBlocked(true);
  }

  requestOpen(): void {
    this.hold = DOOR_HOLD_S;
  }

  /** A body inside this box (door frame: across the opening plus 0.2 m, 1.6 m either side of the leaf, within a step of the sill) opens the door. */
  near(p: Position): boolean {
    if (p.x === undefined || p.y === undefined || p.z === undefined) return false;
    const [lx, lz] = doorLocal(this.spec, p.x, p.z);
    return Math.abs(lx) <= this.spec.width / 2 + 0.2 && Math.abs(p.y - this.spec.y) <= 0.45 && Math.abs(lz) <= 1.6;
  }

  tick(dt: number, occupants: Iterable<Position>): void {
    for (const actor of occupants) {
      if (this.near(actor)) {
        this.requestOpen();
        break;
      }
    }
    const wasBlocked = this.openness < 1;
    this.openness = Math.max(0, Math.min(1, this.openness + (this.hold > 0 ? dt : -dt) / DOOR_SWING_S));
    this.hold = Math.max(0, this.hold - dt);
    const blocked = this.openness < 1;
    if (blocked !== wasBlocked) this.setBlocked(blocked);
  }
}
