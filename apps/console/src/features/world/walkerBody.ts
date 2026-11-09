// walkerBody.ts — the pieces every walker-driven body in City 3 shares (the player's bot in CityWalker, the Bazaar
// keeper/patrol in BazaarLife, Scout in ScoutAgent). Each of them owns its own update loop (keys, a patrol route, an
// agent API), so this is not one big hook: it is the collision world they all step against and the walker-state ->
// AgentFrame translation CastFigure animates from. Before this file the two blocks were copy-pasted three times.
import { useMemo } from "react";
import type * as THREE from "three";
import { createBvhWorld } from "./bvhWorld";
import { createCapsuleWorld } from "./capsuleWorld";
import type { AgentFrame } from "./locomotion";
import { clipFor, type WalkerState, type World } from "./walker";
import type { WalkColliders } from "./walkColliders";

export type WalkWorldKind = "capsule" | "raycast" | "pending";
export type WalkWorld = World & { kind: () => WalkWorldKind };

/**
 * Capsule shapecast over the collision GLBs; the old raycast world over the visual meshes only if collision failed to
 * load (or the host passed no collider list at all). Collision status is read per call, so the world switches over by
 * itself when the collision GLB finishes loading.
 */
export function makeWalkWorld(getMeshes: () => THREE.Mesh[], walk?: WalkColliders): WalkWorld {
  const ray = createBvhWorld(getMeshes);
  if (!walk) return Object.assign(ray, { kind: () => "raycast" as const });
  const cap = createCapsuleWorld(walk.list);
  const pick = (): World => (walk.status === "failed" ? ray : cap);
  return {
    prepareStep: (s) => walk.elevator?.prepare(s),
    finishStep: (s) => walk.elevator?.observe(s),
    groundY: (x, z, fromY) => pick().groundY(x, z, fromY),
    blocked: (a, b, r) => pick().blocked(a, b, r),
    kind: () => (walk.status === "ready" ? "capsule" : walk.status === "failed" ? "raycast" : "pending"),
  };
}

/** `makeWalkWorld`, memoised on its inputs (one world per collider list). */
export function useWalkWorld(getMeshes: () => THREE.Mesh[], walk?: WalkColliders): WalkWorld {
  return useMemo(() => makeWalkWorld(getMeshes, walk), [getMeshes, walk]);
}

/** A fresh, idle frame at (x, z) facing `heading`. */
export function newWalkerFrame(x = 0, z = 0, heading = 0): AgentFrame {
  return { position: [x, z], velocity: [0, 0], speed: 0, heading, state: "idle", targetsReached: 0 };
}

/** A pose that replaces the walker's for the figure (Scout seated on a chair): position and facing, standing still. */
export interface FramePose {
  x: number;
  z: number;
  heading: number;
}

/**
 * Write the walker state into the frame CastFigure reads (in place: the figure holds the same object). The figure faces
 * the BODY heading (it turns toward travel; a backpedal reverses Walk), never the view heading. Height is not part of the
 * frame: callers set the figure group's y themselves.
 */
export function writeWalkerFrame(f: AgentFrame, s: WalkerState, pose?: FramePose | null): AgentFrame {
  f.position[0] = pose ? pose.x : s.x;
  f.position[1] = pose ? pose.z : s.z;
  f.velocity[0] = s.vx;
  f.velocity[1] = s.vz;
  f.speed = pose ? 0 : s.speed;
  f.heading = pose ? pose.heading : s.body;
  f.state = pose ? "idle" : clipFor(s.speed);
  (f.gait ??= { reverse: false }).reverse = s.backward;
  return f;
}
