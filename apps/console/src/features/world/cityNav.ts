// cityNav.ts — L-A runtime: the baked City 3 navmesh (tools/city3/navmesh)
// as a queryable surface for agent movement.
//
// Before L-A, agent movement was greedy: walker.ts's moveToIntent steers in
// a straight line at the target and the collision world slides the body
// along whatever it hits. That wedges on planters, stalls and alcoves —
// the executor's only recovery was a 2.5 s stall detector. This module is
// the other half of the design Jim approved: the MODEL picks the goal,
// Detour computes the route. `route()` returns waypoints + the true travel
// distance along them (not the euclidean lie), and `navMeshWorld()` adapts
// the navmesh to walker.ts's World interface so headless sims can walk on
// exactly the surface production routing uses.
//
// Pure module (three-free, DOM-free): callers fetch the .bin artifact and
// hand the bytes in. The Recast WASM init is shared with locomotion.ts's
// pattern — one init per process.

import { NavMeshQuery, importNavMesh, init } from "recast-navigation";
import type { NavMesh } from "@recast-navigation/core";
import type { Vec3, World } from "./walker";

export interface NavPoint {
  x: number;
  y: number;
  z: number;
}

export interface NavRoute {
  /** String-pulled waypoints from (clamped) start to (clamped) target. */
  waypoints: NavPoint[];
  /** True travel distance along the waypoints, metres (3D). */
  distance: number;
  /** The target snapped onto the navmesh — where the route actually ends. */
  target: NavPoint;
  /** XZ gap between the route's last waypoint and the clamped target.
   *  > 0 on partial corridors (a last-meters pinch): the caller should
   *  finish with greedy steering against the collision world. */
  endGap: number;
}

let initPromise: Promise<void> | null = null;
function ensureInit(): Promise<void> {
  initPromise ??= init();
  return initPromise;
}

const CLAMP_HE = { x: 3, y: 5, z: 3 } as const;

export class CityNav {
  readonly navMesh: NavMesh;
  readonly query: NavMeshQuery;

  private constructor(navMesh: NavMesh) {
    this.navMesh = navMesh;
    this.query = new NavMeshQuery(navMesh);
  }

  /** Build from the exported artifact bytes (world-city3-navmesh.bin). */
  static async create(bytes: Uint8Array): Promise<CityNav> {
    await ensureInit();
    const { navMesh } = importNavMesh(bytes);
    return new CityNav(navMesh);
  }

  /** Snap a point onto the navmesh; null when nothing is within the box. */
  clamp(p: NavPoint, halfExtents: { x: number; y: number; z: number } = CLAMP_HE): NavPoint | null {
    const r = this.query.findClosestPoint(p, { halfExtents });
    return r.success ? { x: r.point.x, y: r.point.y, z: r.point.z } : null;
  }

  /** True when (x, z) at height y sits on a navmesh polygon (within tol in XZ). */
  onMesh(x: number, y: number, z: number, tol = 0.05): boolean {
    const r = this.query.findClosestPoint({ x, y, z }, { halfExtents: { x: 0.5, y: 1.5, z: 0.5 } });
    return r.success && Math.hypot(r.point.x - x, r.point.z - z) <= tol;
  }

  /**
   * Route from `from` to `to`. Both ends are clamped first. Returns null
   * when either end cannot clamp or Detour finds no corridor at all. A
   * corridor that stops short of the target is NOT null — it comes back
   * with endGap > 0 so the caller can finish greedily (the census's two
   * PARTIAL defects are exactly this shape).
   */
  route(from: NavPoint, to: NavPoint): NavRoute | null {
    const s = this.clamp(from);
    const e = this.clamp(to);
    if (!s || !e) return null;
    const res = this.query.computePath(s, e, {
      halfExtents: { x: 1, y: 2, z: 1 },
      maxPathPolys: 2048,
      maxStraightPathPoints: 1024,
    });
    if (!res.success || !res.path || res.path.length === 0) return null;
    const waypoints = res.path.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    let distance = Math.hypot(waypoints[0].x - from.x, waypoints[0].y - from.y, waypoints[0].z - from.z);
    for (let i = 1; i < waypoints.length; i++) {
      const a = waypoints[i - 1];
      const b = waypoints[i];
      distance += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    }
    const last = waypoints[waypoints.length - 1];
    return {
      waypoints,
      distance,
      target: e,
      endGap: Math.hypot(last.x - e.x, last.z - e.z),
    };
  }

  /**
   * Slide a proposed position along the navmesh surface from a known-good
   * position (Detour moveAlongSurface): the result is the farthest point
   * toward `to` that stays on walkable polygons. Used to clamp bodies
   * that separation pushed off the mesh. Null when `from` cannot clamp.
   *
   * The start snap uses a TIGHT vertical window on purpose: `from` is
   * on-mesh by construction (the caller's invariant), and a generous
   * window lets findClosestPoint snap the start onto a different floor —
   * in the crowd sim a ±5 m box teleported bodies onto the fountain
   * platform and the Tea House upper floor, stranding them mid-air. The
   * floor-jump guard is the second line of defence: a result more than
   * 1 m above/below the start's height is rejected outright.
   */
  slideAlong(from: NavPoint, to: NavPoint): NavPoint | null {
    let s = this.query.findClosestPoint(from, { halfExtents: { x: 1, y: 1.25, z: 1 } });
    if (!s.success) s = this.query.findClosestPoint(from, { halfExtents: CLAMP_HE });
    if (!s.success) return null;
    const r = this.query.moveAlongSurface(s.polyRef, s.point, to, { maxVisitedSize: 64 });
    if (!r.success) return null;
    const out = { x: r.resultPosition.x, y: r.resultPosition.y, z: r.resultPosition.z };
    if (Math.abs(out.y - s.point.y) > 1.0) return { x: s.point.x, y: s.point.y, z: s.point.z };
    return out;
  }

  /**
   * Walker-World ground probe: the navmesh height at (x, z) at or below
   * fromY. Approximates "highest surface at or below" with the closest
   * surface in a narrow column — storey gaps in City 3 are >= 3.4 m, far
   * wider than the probe's vertical slack.
   */
  groundY(x: number, z: number, fromY: number): number | null {
    // Vertical window 4.5 m: enough to find the floor below when stepping
    // down a storey (Tea House gaps are 3.5–3.9 m) without letting an
    // upper floor's surface win the closest-point race from below.
    const r = this.query.findClosestPoint({ x, y: fromY, z }, { halfExtents: { x: 0.9, y: 4.5, z: 0.9 } });
    if (!r.success) return null;
    // The ground must be under the body's centre, not merely nearby: a
    // 0.9 m sideways reach "finds" the terrace across the unwalkable
    // planter band beside it and lets bodies stand in the gap.
    if (Math.hypot(r.point.x - x, r.point.z - z) > 0.3) return null;
    if (r.point.y > fromY + 0.05) return null;
    return r.point.y;
  }
}

/**
 * walker.ts World backed by the navmesh alone (headless sims, tests).
 * Walls are the navmesh boundary: a move whose endpoint leaves the mesh
 * is blocked, with the normal pointing from the stray endpoint toward
 * its closest mesh point, so walker.ts's slide() keeps the tangential
 * component and bodies creep along boundaries. The production console
 * keeps its BVH world; this adapter exists so sims and tests walk the
 * same surface the router plans over.
 */
export function navMeshWorld(nav: CityNav): World {
  return {
    groundY: (x, z, fromY) => nav.groundY(x, z, fromY),
    blocked: (from: Vec3, to: Vec3) => {
      // The mesh is pre-eroded by the agent radius at bake time, so the
      // CENTRE point is the collision primitive (the radius argument the
      // BVH world needs is already baked in here).
      const near = nav.clamp({ x: to[0], y: to[1], z: to[2] }, { x: 0.75, y: 1.5, z: 0.75 });
      if (near && Math.hypot(near.x - to[0], near.z - to[2]) <= 0.08) return null;
      // Off-mesh: the wall normal points from the stray endpoint back
      // toward its closest mesh point — walker.slide() projects the move
      // against it and keeps the tangential component, so a body creeps
      // along a mesh boundary instead of freezing. (A normal faked as
      // "back along the move" annihilates the whole move under that
      // projection — the crowd sim froze solid on it.)
      if (near) {
        const dx = near.x - to[0];
        const dz = near.z - to[2];
        const len = Math.hypot(dx, dz);
        if (len > 1e-9) return { nx: dx / len, nz: dz / len, depth: len };
      }
      // Nothing walkable anywhere near: hard stop, back along the move.
      const dx = to[0] - from[0];
      const dz = to[2] - from[2];
      const len = Math.hypot(dx, dz);
      if (len < 1e-9) return null;
      return { nx: -dx / len, nz: -dz / len, depth: 0 };
    },
  };
}
