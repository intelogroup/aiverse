// Physical bodies are owned by a mounted world, not by the social-agent roster.
// This registry is physics truth; callers must apply visibility before exposing it to agents.
import type { Hit, Vec3, WalkerState, WalkInput, World } from "./walker";

export interface ActorBody {
  id: string;
  position: Vec3;
  velocity: [number, number];
  radius: number;
  height: number;
  updatedAtMs: number;
  /** False for anchored residents; a mobile actor remains mobile while yielding or paused. */
  mobile?: boolean;
}
export interface CrossingThreat {
  id: string;
  timeToClosest: number;
  clearance: number;
  /** Stable priority prevents both moving bodies yielding to each other. Static bodies always have priority. */
  shouldYield: boolean;
  /** Relative to travel, both head-on actors choose their own right-hand side. */
  preferredSide: "right";
}
const clock = () => performance.now();
const EPS = 1e-6;

/** Predicted closest separation under constant velocities; advisory only, swept collision stays authoritative. */
export function crossingThreat(self: ActorBody, other: ActorBody, horizon = 2, margin = 0.2): CrossingThreat | null {
  if (self.id === other.id || !verticalOverlap(self.position[1], self.height, other)) return null;
  const dx = other.position[0] - self.position[0], dz = other.position[2] - self.position[2];
  const vx = other.velocity[0] - self.velocity[0], vz = other.velocity[1] - self.velocity[1];
  const vv = vx * vx + vz * vz;
  const t = vv > EPS ? Math.max(0, Math.min(horizon, -(dx * vx + dz * vz) / vv)) : 0;
  const clearance = Math.hypot(dx + vx * t, dz + vz * t) - self.radius - other.radius;
  if (clearance > margin) return null;
  return { id: other.id, timeToClosest: t, clearance,
    shouldYield: other.mobile === false || self.id > other.id, preferredSide: "right" };
}
/** Shared fast avoidance policy. Physics still checks the sidestep against walls and bodies.
 * Use a stable mobile/static flag: yielding must not accidentally grant the other agent higher priority.
 */
export function avoidActorInput(self: ActorBody, others: ActorBody[], wanted: WalkInput): WalkInput {
  if (wanted.forward <= 0 && wanted.strafe === 0) return wanted;
  const heading = wanted.faceHeading ?? Math.atan2(self.velocity[0], self.velocity[1]);
  const desired = { ...self, velocity: [Math.sin(heading) * 1.3 * wanted.forward, Math.cos(heading) * 1.3 * wanted.forward] as [number, number] };
  const threats = others.map(other => crossingThreat(desired, other)).filter(t => t?.shouldYield);
  if (!threats.length) return wanted;
  // Move clear early rather than park on the narrow centre line. Collision and route revalidation
  // retain authority; this advisory never teleports or overrides blocked movement.
  return { ...wanted, forward: 0, strafe: .7, run: false };
}
function verticalOverlap(y: number, height: number, other: ActorBody): boolean {
  return y < other.position[1] + other.height - EPS && y + height > other.position[1] + EPS;
}

/** Swept horizontal discs with vertical bounds. A fast move cannot jump across another body. */
export function actorHit(from: Vec3, to: Vec3, radius: number, height: number, other: ActorBody): Hit | null {
  if (!verticalOverlap(from[1], height, other) && !verticalOverlap(to[1], height, other)) return null;
  const x = from[0] - other.position[0], z = from[2] - other.position[2];
  const dx = to[0] - from[0], dz = to[2] - from[2], r = radius + other.radius;
  const startDist = Math.hypot(x, z), endDist = Math.hypot(x + dx, z + dz);
  if (startDist < r - EPS) {
    if (endDist >= r && endDist > startDist) return null;
    const nx = startDist > EPS ? x / startDist : (Math.hypot(dx, dz) > EPS ? -dx / Math.hypot(dx, dz) : 1);
    const nz = startDist > EPS ? z / startDist : (Math.hypot(dx, dz) > EPS ? -dz / Math.hypot(dx, dz) : 0);
    return { nx, nz, depth: Math.max(0, r - endDist) };
  }
  const a = dx * dx + dz * dz;
  if (a < EPS) return null;
  const b = 2 * (x * dx + z * dz), c = x * x + z * z - r * r;
  const disc = b * b - 4 * a * c;
  if (disc <= 0 || b >= 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t < -EPS || t > 1) return null;
  const cx = x + dx * Math.max(0, t), cz = z + dz * Math.max(0, t);
  const d = Math.hypot(cx, cz);
  return { nx: cx / d, nz: cz / d, depth: Math.max(0, r - endDist) };
}

export class ActorRegistry {
  private bodies = new Map<string, ActorBody>();
  readonly ttlMs: number;
  private readonly now: () => number;
  constructor(ttlMs = 2000, now = clock) { this.ttlMs = ttlMs; this.now = now; }
  publish(body: ActorBody): void {
    if (!body.id || ![...body.position, ...body.velocity, body.radius, body.height, body.updatedAtMs].every(Number.isFinite)
      || body.radius <= 0 || body.height <= 0) throw new Error("invalid actor body");
    const previous = this.bodies.get(body.id);
    if (previous && body.updatedAtMs < previous.updatedAtMs) return;
    this.bodies.set(body.id, { ...body, position: [...body.position], velocity: [...body.velocity] });
  }
  publishWalker(id: string, state: Pick<WalkerState, "x" | "y" | "z" | "vx" | "vz">, radius = 0.4, height = 1.7, mobile = true): void {
    this.publish({ id, position: [state.x, state.y, state.z], velocity: [state.vx, state.vz], radius, height, mobile, updatedAtMs: this.now() });
  }
  remove(id: string): void { this.bodies.delete(id); }
  clear(): void { this.bodies.clear(); }
  list(now = this.now()): ActorBody[] {
    for (const [id, body] of this.bodies) if (now - body.updatedAtMs > this.ttlMs) this.bodies.delete(id);
    return [...this.bodies.values()].map(b => ({ ...b, position: [...b.position], velocity: [...b.velocity] }));
  }
  nearby(selfId: string, position: Vec3, range: number, now = this.now()): ActorBody[] {
    return this.list(now).filter(b => b.id !== selfId && Math.hypot(b.position[0] - position[0], b.position[1] - position[1], b.position[2] - position[2]) <= range)
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  wrapWorld<T extends World>(world: T, selfId: string, height = 1.7): T {
    return Object.assign({}, world, { blocked: (from: Vec3, to: Vec3, radius: number): Hit | null => {
      const staticHit = world.blocked(from, to, radius);
      if (staticHit) return staticHit;
      for (const body of this.list()) {
        if (body.id === selfId) continue;
        const hit = actorHit(from, to, radius, height, body);
        if (hit) return hit;
      }
      return null;
    } });
  }
}
