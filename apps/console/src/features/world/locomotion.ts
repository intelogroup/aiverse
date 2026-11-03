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

export const AGENT_RADIUS = 0.35; // m
export const AGENT_MAX_SPEED = 1.4; // m/s
export const MAX_PLATFORM_AGENTS = 32; // Crowd allocation cap; the console renders <= 12 figures per platform

const CELL_SIZE = 0.1; // navmesh voxel size, m
const ARRIVE_DIST = 0.6; // m from target counts as "reached"
const RETARGET_AFTER_S = 8; // pick a fresh wander target at least this often
const SPAWN_MIN_SEPARATION = 1.5; // m between spawn points (best effort)

export type LocomotionState = "idle" | "walk";

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
}

export interface PlatformCrowdOptions {
  /** Seeds Recast's RNG (used for random navmesh points) so runs reproduce. */
  seed?: number;
  agentRadius?: number;
  maxSpeed?: number;
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

interface AgentRec {
  agent: CrowdAgent;
  target: { x: number; z: number };
  sinceTarget: number;
  targetsReached: number;
  heading: number;
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
    const agent = crowd.addAgent(
      { x: spawn.x, y: 0, z: spawn.z },
      {
        radius: agentRadius,
        height: 1.6,
        maxSpeed,
        maxAcceleration: 8,
        collisionQueryRange: 2.5,
        separationWeight: 2.0,
      },
    );
    const rec: AgentRec = { agent, target: randomPoint(), sinceTarget: 0, targetsReached: 0, heading: 0 };
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

  return {
    get agentCount() {
      return recs.length;
    },
    setAgentCount,
    step(dt: number): AgentFrame[] {
      if (disposed) return [];
      crowd.update(dt);
      return recs.map((rec) => {
        const p = rec.agent.position();
        const v = rec.agent.velocity();
        const a = animState(v.x, v.z);
        if (a.heading !== null) rec.heading = a.heading;

        rec.sinceTarget += dt;
        const dTarget = Math.hypot(p.x - rec.target.x, p.z - rec.target.z);
        if (dTarget < ARRIVE_DIST) {
          rec.targetsReached++;
          retarget(rec);
        } else if (rec.sinceTarget >= RETARGET_AFTER_S) {
          retarget(rec);
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
