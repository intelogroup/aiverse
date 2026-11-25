// Surveyed inner jamb and threshold of Scandi Hawk's south-facing ground floor.
export const HAWK_ROOM = "house-ring-35-0";
export const HAWK_DOOR_KEY = "door:scandi-hawk";
export const HAWK_DOOR = { x: 22.925, y: 0.53, z: -142.086, width: 1.6, height: 2.04 };
const { x, y, z, width, height } = HAWK_DOOR;
export const HAWK_DOOR_BOX: [number, number, number, number, number, number, number] =
  [x, z, width / 2, 0.045, y, y + height, 0];

type Position = { x?: number; y?: number; z?: number };

export class HawkDoor {
  openness = 0;
  private hold = 0;

  constructor(private readonly setBlocked: (blocked: boolean) => void) {
    setBlocked(true);
  }

  requestOpen(): void {
    this.hold = 2;
  }

  tick(dt: number, occupants: Iterable<Position>): void {
    for (const actor of occupants) {
      if (actor.x === undefined || actor.y === undefined || actor.z === undefined) continue;
      if (Math.abs(actor.x - x) <= 1.0 && Math.abs(actor.y - y) <= 0.45 && Math.abs(actor.z - z) <= 1.6) {
        this.requestOpen();
        break;
      }
    }
    const wasBlocked = this.openness < 1;
    this.openness = Math.max(0, Math.min(1, this.openness + (this.hold > 0 ? dt : -dt) / 0.55));
    this.hold = Math.max(0, this.hold - dt);
    const blocked = this.openness < 1;
    if (blocked !== wasBlocked) this.setBlocked(blocked);
  }
}
