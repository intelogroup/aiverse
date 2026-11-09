// Collision-derived local navigation for the browser-owned Scout simulation.
// One reachable surface per XZ cell; this is deliberately not a multi-floor navmesh.
import { WALK_CONFIG, type Vec3, type World } from "./walker";

export interface NavigationOptions {
  cellSize?: number;
  halfExtent?: number;
  maxExpansions?: number;
  radius?: number;
  stepUp?: number;
  stepDown?: number;
  waterY?: number;
}
export interface NavigationPatch {
  origin: Vec3;
  cellSize: number;
  width: number;
  /** Row-major reachable surface heights; null means unknown or unreachable, not a proven wall. */
  heights: (number | null)[];
  radius: number;
  complete: boolean;
}
export interface NavigationRoute {
  status: "found" | "unreachable" | "out_of_bounds" | "budget_exceeded" | "invalid";
  /** Includes the start and exact goal. Every segment has been collision checked. */
  waypoints: Vec3[];
  expanded: number;
  patch: NavigationPatch;
}
interface Config {
  cellSize: number; halfExtent: number; maxExpansions: number;
  radius: number; stepUp: number; stepDown: number; waterY: number;
}
const finitePoint = (p: Vec3) => p.length === 3 && p.every(Number.isFinite);
function config(o: NavigationOptions): Config {
  return {
    cellSize: o.cellSize ?? 0.75, halfExtent: o.halfExtent ?? 24,
    maxExpansions: o.maxExpansions ?? 4096, radius: o.radius ?? WALK_CONFIG.radius,
    stepUp: o.stepUp ?? WALK_CONFIG.stepUp, stepDown: o.stepDown ?? WALK_CONFIG.stepDown,
    waterY: o.waterY ?? WALK_CONFIG.waterY,
  };
}
function valid(c: Config): boolean {
  return Object.values(c).every(Number.isFinite) && c.cellSize >= 0.25 && c.cellSize <= 2 &&
    c.halfExtent >= c.cellSize && c.halfExtent <= 128 &&
    c.maxExpansions >= 1 && c.maxExpansions <= 20000 && Number.isInteger(c.maxExpansions) &&
    c.radius >= 0.05 && c.radius <= 2 && c.stepUp >= 0 && c.stepUp <= 1 &&
    c.stepDown >= 0 && c.stepDown <= 1 &&
    (Math.floor(c.halfExtent / c.cellSize) * 2 + 1) ** 2 <= 100000;
}

/** Validate the entire segment, not just the destination (thin walls, gaps and steps). */
function traverse(world: World, from: Vec3, x: number, z: number, c: Config): Vec3 | null {
  const length = Math.hypot(x - from[0], z - from[2]);
  const steps = Math.max(1, Math.ceil(length / Math.min(c.radius / 2, 0.2)));
  let prev: Vec3 = from;
  for (let i = 1; i <= steps; i++) {
    const px = from[0] + (x - from[0]) * i / steps;
    const pz = from[2] + (z - from[2]) * i / steps;
    const y = world.groundY(px, pz, prev[1] + c.stepUp + 0.05);
    if (y === null || !Number.isFinite(y) || y < c.waterY ||
      y - prev[1] > c.stepUp + 1e-6 || prev[1] - y > c.stepDown + 1e-6) return null;
    const next: Vec3 = [px, y, pz];
    if (world.blocked(prev, [px, prev[1], pz], c.radius) || world.blocked(prev, next, c.radius)) return null;
    prev = next;
  }
  return prev;
}

/** Collision checked segment helper for executor revalidation and experiment assertions. */
export function navigationSegment(world: World, from: Vec3, to: Vec3, options: NavigationOptions = {}): boolean {
  const c = config(options);
  if (!valid(c) || !finitePoint(from) || !finitePoint(to) || Math.hypot(to[0] - from[0], to[2] - from[2]) > 2 * c.halfExtent) return false;
  const end = traverse(world, from, to[0], to[2], c);
  return end !== null && Math.abs(end[1] - to[1]) <= 0.05;
}

interface Node { id: number; p: Vec3; g: number; f: number; parent: number | null }
const directions = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]] as const;
function search(world: World, start: Vec3, goal: Vec3 | null, options: NavigationOptions): NavigationRoute {
  const c = config(options);
  const safe = valid(c) && finitePoint(start) && (!goal || finitePoint(goal));
  const n = safe ? Math.floor(c.halfExtent / c.cellSize) : 0;
  const width = 2 * n + 1;
  const patch: NavigationPatch = {
    origin: safe ? [start[0] - n * c.cellSize, start[1], start[2] - n * c.cellSize] : [0, 0, 0],
    cellSize: safe ? c.cellSize : 0.75, width, heights: Array(width * width).fill(null),
    radius: safe ? c.radius : WALK_CONFIG.radius, complete: false,
  };
  const result = (status: NavigationRoute["status"], expanded: number, waypoints: Vec3[] = []): NavigationRoute => ({ status, expanded, waypoints, patch });
  if (!safe) return result("invalid", 0);
  if (goal && (Math.abs(goal[0] - start[0]) > n * c.cellSize || Math.abs(goal[2] - start[2]) > n * c.cellSize)) {
    return result("out_of_bounds", 0);
  }
  const grounded = traverse(world, start, start[0], start[2], c);
  if (!grounded || Math.abs(grounded[1] - start[1]) > 0.05) return result("invalid", 0);
  const heuristic = (p: Vec3) => goal ? Math.hypot(goal[0] - p[0], goal[2] - p[2]) : 0;
  const first: Node = { id: n * width + n, p: [...start], g: 0, f: heuristic(start), parent: null };
  const nodes = new Map<number, Node>([[first.id, first]]);
  const open = new Set<number>([first.id]);
  const closed = new Set<number>();
  patch.heights[first.id] = start[1];
  let expanded = 0;
  while (open.size && expanded < c.maxExpansions) {
    // Bound is small and fixed; deterministic tie breaking makes experiments reproducible.
    let current = nodes.get(open.values().next().value!)!;
    for (const id of open) {
      const candidate = nodes.get(id)!;
      if (candidate.f < current.f || (candidate.f === current.f && candidate.id < current.id)) current = candidate;
    }
    open.delete(current.id); closed.add(current.id); expanded++;
    if (goal && heuristic(current.p) <= c.cellSize * Math.SQRT2 &&
      (Math.abs(goal[0] - current.p[0]) < 1e-6 || Math.abs(goal[2] - current.p[2]) < 1e-6 ||
        (traverse(world, current.p, goal[0], current.p[2], c) && traverse(world, current.p, current.p[0], goal[2], c))) &&
      navigationSegment(world, current.p, goal, c)) {
      const route: Vec3[] = [[...goal]];
      let node: Node | undefined = current;
      while (node) { route.push(node.p); node = node.parent === null ? undefined : nodes.get(node.parent); }
      route.reverse();
      if (route.length > 1 && Math.hypot(...route[0].map((v, i) => v - route[1][i])) < 1e-6) route.splice(0, 1);
      return result("found", expanded, route);
    }
    const ix = current.id % width, iz = Math.floor(current.id / width);
    for (const [dx, dz] of directions) {
      const nx = ix + dx, nz = iz + dz;
      if (nx < 0 || nz < 0 || nx >= width || nz >= width) continue;
      const id = nz * width + nx;
      if (closed.has(id)) continue;
      const x = patch.origin[0] + nx * c.cellSize, z = patch.origin[2] + nz * c.cellSize;
      // Never squeeze diagonally through the corner of two blocked cells.
      if (dx && dz && (!traverse(world, current.p, x, current.p[2], c) || !traverse(world, current.p, current.p[0], z, c))) continue;
      const p = traverse(world, current.p, x, z, c);
      if (!p) continue;
      const g = current.g + Math.hypot(p[0] - current.p[0], p[2] - current.p[2]);
      const existing = nodes.get(id);
      if (existing && existing.g <= g) continue;
      nodes.set(id, { id, p, g, f: g + heuristic(p), parent: current.id });
      open.add(id); patch.heights[id] = p[1];
    }
  }
  patch.complete = open.size === 0;
  return result(open.size ? "budget_exceeded" : "unreachable", expanded);
}

/** Local route only: a goal outside the bounded patch is explicitly rejected, never silently clamped. */
export function planRoute(world: World, start: Vec3, goal: Vec3, options: NavigationOptions = {}): NavigationRoute {
  return search(world, start, goal, options);
}

/** Flood the reachable local surface; complete=false means the exploration budget was exhausted. */
export function sampleNavigationPatch(world: World, origin: Vec3, options: NavigationOptions = {}): NavigationPatch {
  return search(world, origin, null, options).patch;
}
