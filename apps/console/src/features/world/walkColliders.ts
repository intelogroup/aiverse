// walkColliders.ts — the walker's collider list, SEPARATE from the camera's (DistrictWorld.colliderSets stays as is).
//
// Keyed sets of world-space collider meshes (capsuleWorld.ts): "resident" (the Bazaar collision GLB), one per streamed
// district, "interior:<id>" boxes per streamed hero room. The registry owns what it is given: `drop` frees the BVH and
// geometry. Collision meshes are never added to a scene. Three-only, no React: unit-testable.

import type { TeaElevatorController } from "./teaElevator";
import * as THREE from "three";
import { disposeCollider } from "./capsuleWorld";

export type CollisionStatus = "loading" | "ready" | "failed";

export interface WalkCollidersStats {
  status: CollisionStatus;
  sets: string[];
  meshes: number;
  triangles: number;
  loads: number;
  drops: number;
  buildMs: Record<string, number>;
}

export class WalkColliders {
  elevator?: TeaElevatorController;
  private sets = new Map<string, THREE.Mesh[]>();
  private flat: THREE.Mesh[] | null = null;
  private loads = 0;
  private drops = 0;
  private buildMs: Record<string, number> = {};
  /** Resident (Bazaar) collision state: the walker waits while "loading" and falls back to visual meshes on "failed". */
  status: CollisionStatus = "loading";

  /** Replace the set under `key` (freeing the old one). */
  set(key: string, meshes: THREE.Mesh[], ms = 0): void {
    this.drop(key, false);
    if (!meshes.length) return;
    this.sets.set(key, meshes);
    this.flat = null;
    this.loads++;
    this.buildMs[key] = Math.round(ms);
  }

  has(key: string): boolean { return this.sets.has(key); }

  drop(key: string, count = true): void {
    const old = this.sets.get(key);
    if (!old) return;
    for (const m of old) disposeCollider(m);
    this.sets.delete(key);
    delete this.buildMs[key];
    this.flat = null;
    if (count) this.drops++;
  }

  dropAll(): void { for (const k of [...this.sets.keys()]) this.drop(k); }

  /** Stable between mutations (the capsule world calls this every probe). */
  list = (): THREE.Mesh[] => (this.flat ??= [...this.sets.values()].flat());

  stats(): WalkCollidersStats {
    let triangles = 0;
    const all = this.list();
    for (const m of all) {
      const g = m.geometry;
      triangles += (g.index ? g.index.count : g.getAttribute("position").count) / 3;
    }
    return { status: this.status, sets: [...this.sets.keys()], meshes: all.length, triangles, loads: this.loads, drops: this.drops, buildMs: { ...this.buildMs } };
  }
}
