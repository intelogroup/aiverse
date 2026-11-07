// grounding.ts — keep a posed figure's planted foot on the floor (the "pelvis offset" of engine foot placement).
//
// Why: the baked Walk/Run clips do not hold a foot at the floor through the cycle. Measured on the shipped GLBs
// with docs/procedural-city/harness/gait_full.mjs (skinned vertices within 1 cm of the floor): before this,
// Summer's Walk had a sole on the floor in only 6 % of frames (floating up to 8.8 cm), Remy's in 5-13 %; a walk
// always has a foot down. With this offset both are in contact 100 % of the Walk cycle (lowest vertex within
// ±4 mm). Idle floated 1.3 cm (Summer) and sank 1.8 cm (Body Block); the same offset grounds both.
//
// How: contact points are the foot joints (ankle, toe base, toe tip). In the bind pose the feet stand flat on the
// floor, so a joint's clearance on any pose is simply its height now minus its bind height, measured in the
// figure scene's own frame (independent of where the group stands or the floor lift). The lowest clearance over
// both feet is how far the figure floats (> 0) or sinks (< 0). It is taken on the live, blended pose, so it holds
// for Idle, Walk, reversed Walk, the Walk -> Run blend and turn clips without per-clip tables. A Run has a flight
// phase (both feet up on purpose), so its share is grounded by the Run clip's own minimum over a cycle, sampled
// once at load (`clipMinClearance`), not per frame.
import * as THREE from "three";

/**
 * Contact joints: Mixamo (`mixamorig:LeftFoot`, `mixamorig_LeftToe_End`, ...) and KayKit (`foot.l` / `toes.r`,
 * which GLTFLoader sanitizes to `footl` / `toesr`). IK/control helpers (`IK-foot.l`, `heelIK.l`) do not match.
 */
export const FOOT_JOINT = /(?:Left|Right)(?:Foot|ToeBase|Toe_End)$|^(?:foot|toes)\.?[lr]$/;

export interface ContactPoint {
  bone: THREE.Object3D;
  /** The joint's height in the scene frame in the bind pose (feet flat on the floor). */
  restY: number;
}

const tmp = new THREE.Vector3();
const inv = new THREE.Matrix4();

/** Height of `bone` in the scene frame; `inv` must hold the inverse of the scene's world matrix. */
function sceneY(bone: THREE.Object3D): number {
  return tmp.setFromMatrixPosition(bone.matrixWorld).applyMatrix4(inv).y;
}

/** Contact points of `scene`, read in its current pose, which must be the bind pose (call before animating). */
export function contactPoints(scene: THREE.Object3D): ContactPoint[] {
  scene.updateMatrixWorld(true);
  inv.copy(scene.matrixWorld).invert();
  const out: ContactPoint[] = [];
  scene.traverse((o) => {
    if (FOOT_JOINT.test(o.name)) out.push({ bone: o, restY: sceneY(o) });
  });
  return out;
}

/**
 * Lowest clearance of the contact points on the current pose: > 0 the figure floats by that much, < 0 a foot is
 * under the floor; 0 without points. Call after the mixer update and any root-motion edits.
 */
export function soleClearance(points: readonly ContactPoint[], scene: THREE.Object3D): number {
  if (points.length === 0) return 0;
  scene.updateMatrixWorld(true);
  inv.copy(scene.matrixWorld).invert();
  let lo = Infinity;
  for (const c of points) lo = Math.min(lo, sceneY(c.bone) - c.restY);
  return lo;
}

/**
 * Minimum `soleClearance` over one cycle of `clip` played alone (n samples). Uses a throwaway mixer that restores
 * the bones' previous state when it stops, so the figure's own mixer is untouched.
 */
export function clipMinClearance(
  scene: THREE.Object3D,
  clip: THREE.AnimationClip,
  points: readonly ContactPoint[],
  n = 48,
): number {
  if (points.length === 0) return 0;
  const m = new THREE.AnimationMixer(scene);
  const a = m.clipAction(clip);
  a.play();
  let lo = Infinity;
  for (let i = 0; i < n; i++) {
    a.time = (i / n) * clip.duration;
    m.update(0);
    lo = Math.min(lo, soleClearance(points, scene));
  }
  m.stopAllAction(); // restores every bound property's state from before the sampling
  m.uncacheRoot(scene);
  scene.updateMatrixWorld(true); // the world matrices still hold the last sampled pose
  return lo;
}

/**
 * Downward offset that grounds the figure: the live clearance for the non-Run share of the pose, the Run clip's
 * cycle minimum for its share (`runEff` 0..1), never more than the live clearance itself, so no blend weighting
 * pushes the lowest contact under the floor (measured: without the cap the Walk -> Run blend at 1.9 m/s sank 3 cm
 * for a third of the cycle).
 */
export function groundingOffset(live: number, runMin: number, runEff: number): number {
  const r = Math.max(0, Math.min(1, runEff));
  return Math.min(live, (1 - r) * live + r * runMin);
}

/**
 * Root-motion delta of the posed hips, expressed in the frame of the hips' PARENT's parent, i.e. the offset to
 * subtract from the parent's position so the hips stay put. The parent's scale matters: Mixamo FBX rigs keep
 * centimetres under a scaled Armature (Remy: 0.003), and an unscaled delta shoved Remy up to 8 m sideways per
 * Walk cycle (measured 20-70 m/s "slip"). Vertical is dropped (the bob stays in the pose; grounding owns height).
 */
export function rootMotionDelta(
  hipsPos: THREE.Vector3,
  hipsRest: THREE.Vector3,
  parentScale: THREE.Vector3,
  parentQuat: THREE.Quaternion,
  out: THREE.Vector3,
): THREE.Vector3 {
  out.copy(hipsPos).sub(hipsRest).multiply(parentScale).applyQuaternion(parentQuat);
  out.y = 0;
  return out;
}
