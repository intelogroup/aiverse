// locomotion.ts — Recast/Detour crowd locomotion for one conversation
// platform in the 3D world view.
//
// Why this exists: agent figures used to stand at fixed ring spots. This
// module gives each platform a real navigation crowd — a solo navmesh over
// the platform disc plus a Detour Crowd whose agents wander it — so figures
// walk, turn, stop and avoid each other with library-carried physics
// instead of hand-rolled steering. Proven first as a standalone spike
// (~/workspace/aiverse-recast-spike, all assertions PASS); this is the same
// code pattern, productized.
//
// Deliberately three-free and DOM-free: positions are plain [x, z] pairs in
// platform-local "crowd space", so the module runs headless under vitest
// and the renderer (Scene3D.tsx) only maps frames onto figure groups.
//
// Heading convention: heading = atan2(vx, vz). A three.js object with
// rotation.y = heading faces its velocity direction (three.js objects face
// +Z at rotation.y = 0, and rotating by atan2(vx, vz) around Y turns that
// +Z facing onto the velocity vector). When an agent is idle its last
// non-idle heading is retained so figures don't snap to a default facing.

import { Crowd, NavMeshQuery, init, setRandomSeed } from "recast-navigation";
import { generateSoloNavMesh } from "recast-navigation/generators";
import type { CrowdAgent, NavMesh } from "@recast-navigation/core";
import type { BodyOutput } from "./bodyController";

export const AGENT_RADIUS = 0.35; // m
export const AGENT_MAX_SPEED = 1.4; // m/s

/**
 * Per-agent cruise speed, m/s. A crowd where everyone cruises at the same
 * 1.4 m/s reads as a marching column, so each crowd slot gets a stable
 * pace of its own: roughly a third of slots amble at a working pace
 * (0.55–0.75), the middle band walks (0.75–1.05), the rest hurry
 * (1.05–1.4). Deterministic in the slot index — no RNG state, so runs
 * reproduce and a figure keeps its pace for the life of the crowd. The
 * walk cycle already scales its stride to ground speed, so slow agents
 * stride slow instead of skating. `cap` (the crowd's maxSpeed option)
 * still bounds everyone.
 */
export function cruiseSpeedForIndex(index: number, cap: number = AGENT_MAX_SPEED): number {
  let x = (index + 1) * 2654435761 >>> 0;
  x ^= x >>> 15;
  const h = ((x >>> 0) % 1000) / 1000; // stable scatter in [0, 1)
  const pace = h < 0.3 ? 0.55 + 0.2 * (h / 0.3) : h < 0.75 ? 0.75 + 0.3 * ((h - 0.3) / 0.45) : 1.05 + 0.35 * ((h - 0.75) / 0.25);
  return Math.min(cap, pace);
}

/**
 * Clamp a crowd-space position to a disc of radius maxR centred on the
 * origin — the render backstop that keeps Agora figures on the deck even
 * when separation shoves a centre past the navmesh rim for a frame.
 */
export function clampPositionToRadius(pos: [number, number], maxR: number): [number, number] {
  const r = Math.hypot(pos[0], pos[1]);
  if (r <= maxR || r === 0) return pos;
  const s = maxR / r;
  return [pos[0] * s, pos[1] * s];
}

/**
 * The part of a hips-height deviation (posed minus rest, m) that exceeds
 * the authored-bob band: what a renderer must counter so a baked Walk
 * cycle's vertical ramp cannot sink the figure, while the bob inside
 * ±band passes through untouched.
 */
export function verticalExcess(dy: number, band: number): number {
  return dy - Math.max(-band, Math.min(band, dy));
}
export const MAX_PLATFORM_AGENTS = 32; // Crowd allocation cap; the console renders <= 12 figures per platform

const CELL_SIZE = 0.1; // navmesh voxel size, m
const ARRIVE_DIST = 0.6; // m from target counts as "reached"
const RETARGET_AFTER_S = 8; // pick a fresh wander target at least this often
const SPAWN_MIN_SEPARATION = 1.5; // m between spawn points (best effort)

import type { LocomotionState } from "./locomotionState";
export type { LocomotionState };

export interface AnimState {
  state: LocomotionState;
  /** atan2(vx, vz) when moving; null when idle (caller keeps last heading). */
  heading: number | null;
  speed: number;
}

/**
 * The animation-state function the console drives clips from (identical
 * semantics to the spike): speed < 0.1 m/s is "idle", anything above is
 * "walk" with heading = atan2(vx, vz).
 */
export function animState(vx: number, vz: number): AnimState {
  const speed = Math.hypot(vx, vz);
  if (speed < 0.1) return { state: "idle", heading: null, speed };
  return { state: "walk", heading: Math.atan2(vx, vz), speed };
}

export interface AgentFrame {
  /** Platform-local crowd-space position [x, z]. */
  position: [number, number];
  /** Crowd-space velocity [vx, vz], m/s. */
  velocity: [number, number];
  speed: number;
  /** Facing for rotation.y; retains the last walk heading while idle. */
  heading: number;
  state: LocomotionState;
  targetsReached: number;
  /** Set by the renderer's body controller (bodyController.ts): smoothed heading, turn clip, walk blend. */
  body?: BodyOutput;
  /**
   * Set by a gait-aware driver (the City 3 walker, walker.ts): CastFigure blends Idle/Walk/Run from `speed`
   * (gait.ts) and `heading` is the BODY heading (it turns toward the travel direction; the view heading is the
   * driver's own). `reverse` = backpedal: Walk plays backwards. Crowd frames leave it unset (Idle/Walk only).
   */
  gait?: { reverse: boolean };
}

export interface PlatformCrowdOptions {
  /** Seeds Recast's RNG (used for random navmesh points) so runs reproduce. */
  seed?: number;
  agentRadius?: number;
  maxSpeed?: number;
  /**
   * Per-slot cruise cap on top of maxSpeed: slot i cruises at most
   * min(maxSpeed, maxSpeedForIndex(i)) when the callback returns a
   * number. Bodies cruise at different natural paces (bodies.ts
   * walkSpeed); a slot-blind band system had slow bodies skating at
   * hurry pace, so the renderer passes each member's body cap here.
   */
  maxSpeedForIndex?: (index: number) => number | undefined;
  /**
   * Disc crowds only: radius of a central circular keep-out with NO
   * walkable geometry inside it (e.g. the Agora's hologlobe). The navmesh
   * becomes an annulus — the exact setup the spike proved (deck r=12,
   * keep-out r=2.2: zero intrusions over 60 s at 60 Hz).
   */
  keepOutRadius?: number;
  /** Geometry crowds only: navmesh voxel size, m (disc crowds use 0.1). */
  cellSize?: number;
  /**
   * Spawn positions in crowd space, one per agent (extra agents fall back
   * to random points). Lets the renderer spawn figures where its static
   * fallback ring already drew them, so the swap is seamless.
   */
  initialPositions?: [number, number][];
}

export interface PlatformCrowd {
  readonly agentCount: number;
  /** Advance the crowd by dt seconds and return the new per-agent frames. */
  step: (dt: number) => AgentFrame[];
  /**
   * Reconcile the agent set to n (add wanderers / remove from the tail)
   * without rebuilding the navmesh or crowd — call this when the rendered
   * figure count changes instead of recreating the crowd.
   */
  setAgentCount: (n: number) => void;
  /**
   * Embody v0 control surface: a controlled agent leaves the wander loop
   * and only moves under explicit commands (moveAgentTo / stopAgent).
   * Releasing control returns it to wandering. Heading can be set
   * directly for an idle controlled agent (the face skill); a walking
   * agent's velocity heading still wins frame to frame.
   */
  setControlled: (index: number, on: boolean) => void;
  moveAgentTo: (index: number, x: number, z: number) => void;
  stopAgent: (index: number) => void;
  setHeading: (index: number, heading: number) => void;
  /**
   * Body-controller hook: scale this agent's cruise speed (1 = as configured, 0 = stop). The body
   * controller throttles speed by how far the figure is from facing its direction of travel, so a
   * reversal decelerates, turns, then sets off again instead of sliding backwards.
   */
  setSpeedScale: (index: number, scale: number) => void;
  dispose: () => void;
}

// The Recast WASM module initializes once per page/test process.
let initPromise: Promise<void> | null = null;
function ensureInit(): Promise<void> {
  initPromise ??= init();
  return initPromise;
}

// Navmeshes are shared per radius: every console platform walks the same
// disc, so the first crowd pays generation and the rest reuse it. Cached
// entries live for the page lifetime (a 2.4 m disc navmesh is ~100 polys);
// dispose() therefore destroys only the Crowd, never the shared navmesh.
const navMeshCache = new Map<string, Promise<{ navMesh: NavMesh; query: NavMeshQuery }>>();

function discNavMesh(radius: number, agentRadius: number, keepOutRadius = 0) {
  const key = `${radius}|${keepOutRadius}`;
  let entry = navMeshCache.get(key);
  if (!entry) {
    entry = (async () => {
      await ensureInit();
      const { positions, indices } =
        keepOutRadius > 0 ? buildAnnulusGeometry(radius, keepOutRadius) : buildDiscGeometry(radius);
      const gen = generateSoloNavMesh(positions, indices, {
        cs: CELL_SIZE,
        // GOTCHA (found by the spike, do not "fix"): walkableRadius is in
        // VOXEL units, not meters — the Recast convention. Passing the raw
        // agent radius (0.35) erodes almost nothing and agent centers can
        // slip past the disc edge / into a keep-out. Ceil(radius / cs)
        // erodes by the full agent radius so centers keep the margin.
        walkableRadius: Math.ceil(agentRadius / CELL_SIZE),
      });
      if (!gen.success) {
        throw new Error(`locomotion: navmesh generation failed for radius ${radius}: ${gen.error}`);
      }
      return { navMesh: gen.navMesh, query: new NavMeshQuery(gen.navMesh) };
    })();
    navMeshCache.set(key, entry);
  }
  return entry;
}

/** Flat disc of the given radius at y=0, +Y-up winding (fan from center). */
function buildDiscGeometry(radius: number, segments = 128): { positions: number[]; indices: number[] } {
  const positions: number[] = [0, 0, 0];
  const indices: number[] = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    positions.push(Math.cos(t) * radius, 0, Math.sin(t) * radius);
  }
  for (let i = 0; i < segments; i++) {
    const cur = 1 + i;
    const nxt = 1 + ((i + 1) % segments);
    indices.push(0, nxt, cur);
  }
  return { positions, indices };
}

/**
 * Annulus (disc with a central hole) at y=0: interleaved inner/outer ring
 * vertices. The hole IS the keep-out — no walkable geometry exists inside
 * the inner radius. Winding matches buildDiscGeometry (+Y up). This is
 * the spike's proven geometry, carried over unchanged.
 */
export function buildAnnulusGeometry(
  radius: number,
  keepOutRadius: number,
  segments = 128,
): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    positions.push(Math.cos(t) * keepOutRadius, 0, Math.sin(t) * keepOutRadius); // inner i
    positions.push(Math.cos(t) * radius, 0, Math.sin(t) * radius); // outer i
  }
  for (let i = 0; i < segments; i++) {
    const innerI = i * 2;
    const outerI = innerI + 1;
    const innerN = ((i + 1) % segments) * 2;
    const outerN = innerN + 1;
    indices.push(innerI, innerN, outerI, outerI, innerN, outerN);
  }
  return { positions, indices };
}

/**
 * Flat subdivided rectangle in world XZ at height y (for crowds whose
 * navmesh should live directly in world coordinates, e.g. a city street
 * block). +Y-up winding, same as the disc builders.
 */
export function buildRectGeometry(
  cx: number,
  cz: number,
  y: number,
  width: number,
  depth: number,
  cells = 8,
): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j <= cells; j++) {
    for (let i = 0; i <= cells; i++) {
      positions.push(cx - width / 2 + (i / cells) * width, y, cz - depth / 2 + (j / cells) * depth);
    }
  }
  const row = cells + 1;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const a = j * row + i;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  return { positions, indices };
}

/**
 * Street geometry for the city crowd: the same subdivided rectangle as
 * buildRectGeometry, but at metre-scale steps and with every quad whose
 * centre falls inside a building footprint left out — the navmesh built
 * from it covers streets and plazas only, so the crowd can never path
 * through a building. Footprints are [minX, minZ, maxX, maxZ] in the
 * same world space as the rectangle.
 */
export function buildStreetGeometry(
  cx: number,
  cz: number,
  y: number,
  width: number,
  depth: number,
  footprints: readonly (readonly [number, number, number, number])[],
  step = 2,
): { positions: number[]; indices: number[] } {
  const nx = Math.max(1, Math.round(width / step));
  const nz = Math.max(1, Math.round(depth / step));
  const positions: number[] = [];
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      positions.push(cx - width / 2 + (i / nx) * width, y, cz - depth / 2 + (j / nz) * depth);
    }
  }
  const row = nx + 1;
  const indices: number[] = [];
  const carved = (x: number, z: number): boolean =>
    footprints.some(([x0, z0, x1, z1]) => x >= x0 && x <= x1 && z >= z0 && z <= z1);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const mx = cx - width / 2 + ((i + 0.5) / nx) * width;
      const mz = cz - depth / 2 + ((j + 0.5) / nz) * depth;
      if (carved(mx, mz)) continue;
      const a = j * row + i;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  return { positions, indices };
}

/** A rotated rectangular obstacle in plan view (a bench, a crate). */
export interface PlanObstacle {
  x: number;
  z: number;
  /** Heading of the obstacle's local +Z (its depth axis), locomotion convention. */
  heading: number;
  /** Local X extent (width), m. */
  w: number;
  /** Local Z extent (depth), m. */
  d: number;
}

/** True when (x, z) lies inside the rotated obstacle, inflated by margin. */
export function insideObstacle(x: number, z: number, o: PlanObstacle, margin = 0): boolean {
  const dx = x - o.x;
  const dz = z - o.z;
  const c = Math.cos(o.heading);
  const s = Math.sin(o.heading);
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.abs(lx) <= o.w / 2 + margin && Math.abs(lz) <= o.d / 2 + margin;
}

/**
 * Deck geometry for the Agora crowd: a metre-grid over the deck disc,
 * keeping only quads whose centre sits in the annulus band (outside the
 * keep-out, inside the rim) and outside every plan obstacle. The navmesh
 * built from it makes obstacles physically solid — the crowd paths
 * around benches instead of through them. (The exact-annulus builder
 * above cannot punch holes; this grid can.)
 */
export function buildDeckGeometry(
  radius: number,
  keepOutRadius: number,
  obstacles: readonly PlanObstacle[],
  step = 0.5,
): { positions: number[]; indices: number[] } {
  const n = Math.max(2, Math.round((radius * 2) / step));
  const positions: number[] = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      positions.push(-radius + (i / n) * radius * 2, 0, -radius + (j / n) * radius * 2);
    }
  }
  const row = n + 1;
  const indices: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const mx = -radius + ((i + 0.5) / n) * radius * 2;
      const mz = -radius + ((j + 0.5) / n) * radius * 2;
      const r = Math.hypot(mx, mz);
      if (r < keepOutRadius || r > radius) continue;
      if (obstacles.some((o) => insideObstacle(mx, mz, o))) continue;
      const a = j * row + i;
      const b = a + 1;
      const c2 = a + row;
      const d = c2 + 1;
      indices.push(a, c2, b, b, c2, d);
    }
  }
  return { positions, indices };
}

interface AgentRec {
  agent: CrowdAgent;
  target: { x: number; z: number };
  sinceTarget: number;
  targetsReached: number;
  heading: number;
  /** Embody v0: true while a skill layer owns this agent (no wandering). */
  controlled: boolean;
  /** Configured cruise speed and the scale last applied to the crowd agent. */
  baseSpeed: number;
  speedScale: number;
}

/**
 * Build a wandering crowd for one platform disc of the given radius
 * (crowd-space meters). Async because the Recast WASM module initializes
 * lazily on first use; subsequent calls resolve immediately.
 */
export async function createPlatformCrowd(
  radius: number,
  agentCount: number,
  opts: PlatformCrowdOptions = {},
): Promise<PlatformCrowd> {
  await ensureInit();
  if (opts.seed !== undefined) setRandomSeed(opts.seed);

  const agentRadius = opts.agentRadius ?? AGENT_RADIUS;
  const { navMesh, query } = await discNavMesh(radius, agentRadius, opts.keepOutRadius ?? 0);
  return driveCrowd(navMesh, query, agentCount, opts);
}

/**
 * Build a wandering crowd over caller-supplied navmesh geometry (positions
 * / indices in whatever coordinate space the caller renders in — the
 * frames come back in that same space). Used for the city world, whose
 * walkable area is a street rectangle in world coordinates. The navmesh
 * is one-off (not cached like the discs) and is destroyed on dispose.
 */
export async function createGeometryCrowd(
  positions: number[],
  indices: number[],
  agentCount: number,
  opts: PlatformCrowdOptions = {},
): Promise<PlatformCrowd> {
  await ensureInit();
  if (opts.seed !== undefined) setRandomSeed(opts.seed);

  const agentRadius = opts.agentRadius ?? AGENT_RADIUS;
  const cs = opts.cellSize ?? 0.3;
  const gen = generateSoloNavMesh(positions, indices, {
    cs,
    // Same voxel-units rule as the disc path (see discNavMesh).
    walkableRadius: Math.ceil(agentRadius / cs),
  });
  if (!gen.success) {
    throw new Error(`locomotion: navmesh generation failed for geometry crowd: ${gen.error}`);
  }
  const navMesh = gen.navMesh;
  return driveCrowd(navMesh, new NavMeshQuery(navMesh), agentCount, opts, () => {
    (navMesh as { destroy?: () => void }).destroy?.();
  });
}

/** Shared crowd driver: spawn/retarget/step bookkeeping over any navmesh. */
function driveCrowd(
  navMesh: NavMesh,
  query: NavMeshQuery,
  agentCount: number,
  opts: PlatformCrowdOptions,
  onDispose?: () => void,
): PlatformCrowd {
  const agentRadius = opts.agentRadius ?? AGENT_RADIUS;
  const maxSpeed = opts.maxSpeed ?? AGENT_MAX_SPEED;
  const crowd = new Crowd(navMesh, { maxAgents: MAX_PLATFORM_AGENTS, maxAgentRadius: agentRadius });

  const randomPoint = (): { x: number; z: number } => {
    const r = query.findRandomPoint();
    if (!r.success) throw new Error("locomotion: findRandomPoint failed");
    return { x: r.randomPoint.x, z: r.randomPoint.z };
  };

  const recs: AgentRec[] = [];
  let disposed = false;

  // Spawn spread out: retry until >= SPAWN_MIN_SEPARATION from every
  // already-spawned agent (best effort, mirrors the spike).
  const pickSpawn = (): { x: number; z: number } => {
    let spawn = randomPoint();
    for (let tries = 0; tries < 50; tries++) {
      if (recs.every((r) => Math.hypot(r.agent.position().x - spawn.x, r.agent.position().z - spawn.z) >= SPAWN_MIN_SEPARATION)) break;
      spawn = randomPoint();
    }
    return spawn;
  };

  const addAgent = (): void => {
    const initial = opts.initialPositions?.[recs.length];
    const spawn = initial ? { x: initial[0], z: initial[1] } : pickSpawn();
    const perSlot = opts.maxSpeedForIndex?.(recs.length);
    const cap = perSlot === undefined ? maxSpeed : Math.min(maxSpeed, perSlot);
    const baseSpeed = cruiseSpeedForIndex(recs.length, cap);
    const agent = crowd.addAgent(
      { x: spawn.x, y: 0, z: spawn.z },
      {
        radius: agentRadius,
        height: 1.6,
        maxSpeed: baseSpeed,
        maxAcceleration: 8,
        collisionQueryRange: 2.5,
        separationWeight: 2.0,
      },
    );
    const rec: AgentRec = { agent, target: randomPoint(), sinceTarget: 0, targetsReached: 0, heading: 0, controlled: false, baseSpeed, speedScale: 1 };
    agent.requestMoveTarget({ x: rec.target.x, y: 0, z: rec.target.z });
    recs.push(rec);
  };

  const retarget = (rec: AgentRec): void => {
    rec.target = randomPoint();
    rec.agent.requestMoveTarget({ x: rec.target.x, y: 0, z: rec.target.z });
    rec.sinceTarget = 0;
  };

  const setAgentCount = (n: number): void => {
    const want = Math.max(0, Math.min(MAX_PLATFORM_AGENTS, Math.floor(n)));
    while (recs.length < want) addAgent();
    while (recs.length > want) {
      const rec = recs.pop();
      if (rec) crowd.removeAgent(rec.agent);
    }
  };

  setAgentCount(agentCount);

  const haltAgent = (rec: AgentRec): void => {
    const p = rec.agent.position();
    rec.target = { x: p.x, z: p.z };
    rec.agent.requestMoveTarget({ x: p.x, y: 0, z: p.z });
    rec.sinceTarget = 0;
  };

  return {
    get agentCount() {
      return recs.length;
    },
    setAgentCount,
    setControlled(index: number, on: boolean): void {
      const rec = recs[index];
      if (!rec || rec.controlled === on) return;
      rec.controlled = on;
      if (on) haltAgent(rec);
      else retarget(rec);
    },
    moveAgentTo(index: number, x: number, z: number): void {
      const rec = recs[index];
      if (!rec) return;
      rec.target = { x, z };
      rec.agent.requestMoveTarget({ x, y: 0, z });
      rec.sinceTarget = 0;
    },
    stopAgent(index: number): void {
      const rec = recs[index];
      if (rec) haltAgent(rec);
    },
    setHeading(index: number, heading: number): void {
      const rec = recs[index];
      if (rec) rec.heading = heading;
    },
    setSpeedScale(index: number, scale: number): void {
      const rec = recs[index];
      if (!rec) return;
      const s = Math.min(1, Math.max(0.02, scale)); // never exactly 0: Detour treats a zero max speed as degenerate
      // updateParameters crosses into WASM: only call it when the scale moved enough to matter.
      if (Math.abs(s - rec.speedScale) < 0.03 && !(s === 1 && rec.speedScale !== 1)) return;
      rec.speedScale = s;
      rec.agent.updateParameters({ maxSpeed: rec.baseSpeed * s });
    },
    step(dt: number): AgentFrame[] {
      if (disposed) return [];
      crowd.update(dt);
      return recs.map((rec) => {
        const p = rec.agent.position();
        const v = rec.agent.velocity();
        const a = animState(v.x, v.z);
        if (a.heading !== null) rec.heading = a.heading;

        rec.sinceTarget += dt;
        if (!rec.controlled) {
          const dTarget = Math.hypot(p.x - rec.target.x, p.z - rec.target.z);
          if (dTarget < ARRIVE_DIST) {
            rec.targetsReached++;
            retarget(rec);
          } else if (rec.sinceTarget >= RETARGET_AFTER_S) {
            retarget(rec);
          }
        }

        return {
          position: [p.x, p.z],
          velocity: [v.x, v.z],
          speed: a.speed,
          heading: rec.heading,
          state: a.state,
          targetsReached: rec.targetsReached,
        };
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      recs.length = 0;
      crowd.destroy();
      onDispose?.();
    },
  };
}
