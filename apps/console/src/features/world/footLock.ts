// footLock.ts — keep the planted part of a foot fixed in the world while the body travels over it (runtime foot-skate cleanup).
//
// Why: after the pelvis offset (grounding.ts) the foot touches the floor, but it still slides along it: measured with
// harness/gait_full.mjs, Summer's planted sole skates 0.2 m/s walking at 1.3 m/s, ~0.4 running, up to ~0.8 in the
// Walk -> Run blend; Remy 0.3-0.7 walking, ~1 m/s on the Run's left foot (see 10-walker.md "Contact-pose audit").
// No speed removes it: the planted foot of the baked clips does not move back at a constant rate.
//
// How (the standard recipe, Kovar-Schreiner-Gleicher 2002 "Footskate cleanup", and ozz-animation's foot IK), per leg:
//   1. Landmarks on the sole: the heel (a skinned sole vertex, found from the mesh), the ball and the toe tip (the foot's
//      contact joints, grounding.ts). Each one that is within `PLANT_CLEARANCE` of the floor AND travelling back
//      relative to the body is PINNED at its world XZ (the clip supplies the stance every frame, so no per-clip table);
//      a pin lets go when the landmark rises past `RELEASE_CLEARANCE` or stops moving back.
//   2. The foot is translated by the offset that puts its pinned landmarks back on their pins. Pinning the LANDMARK, not
//      the ankle, is what lets the foot roll: at heel strike the heel holds while the forefoot comes down, at toe-off
//      the toe holds while the heel rises (an ankle-only lock measured worse there: the sole pivoted about a fixed ankle).
//   3. The leg is solved with analytic two-bone IK (law of cosines), the knee on the clip's own side (the pole is the
//      original knee direction, so it never flips), the foot keeps its world orientation, and the correction is blended
//      in and out over `BLEND_S` (Kovar et al. blend 5-10 frames with the cubic alpha(t) = 2t^3 - 3t^2 + 1).
//   4. The baked legs run at 0.98-0.999 of full extension all through the stance, so a foot held in place needs slack
//      the clip never gave it: the pelvis dips just far enough (<= `MAX_DIP`) that every locked foot is within
//      `MAX_REACH` of its hip, and every leg is re-aimed at its world target, so the dip bends knees instead of sinking
//      feet. A lock that would need more than that lets go.
// Three.js' CCDIKSolver was not used: no pole vector, MMD-oriented, its demo runs without an AnimationMixer.
//
// Only UpLeg / Leg / Foot rotate (the hips, the camera head bone and the root-motion cancel are untouched), and only
// while the gait drives the figure at walking pace: standing, turning and the sit/tester clips never reach `update`.
import * as THREE from "three";
import type { ContactPoint } from "./grounding";

/** Bone names: Mixamo (`mixamorig:LeftUpLeg`, `mixamorig_LeftLeg`, ...) and KayKit (`upperleg.l`, `lowerleg.l`, `foot.l`). */
export const THIGH_BONE = /(?:Left|Right)UpLeg$|^upperleg\.?[lr]$/;
export const SHIN_BONE = /(?:Left|Right)Leg$|^lowerleg\.?[lr]$/;
export const FOOT_BONE = /(?:Left|Right)Foot$|^foot\.?[lr]$/;

/** A landmark counts as down when it is this close to the floor (m), measured after grounding. */
export const PLANT_CLEARANCE = 0.01;
/** A pinned landmark lets go once it rises this high (m). */
export const RELEASE_CLEARANCE = 0.03;
/** Stance test: the landmark must not be moving FORWARD relative to the body (a swinging foot is), by more than this share... */
export const PLANT_BACK_SHARE = -1;
/** ... and a pinned landmark lets go when it does move forward relative to the body by more than this share (lift-off). */
export const FORWARD_RELEASE_SHARE = 0.5;
/** Below this body speed (m/s) nothing is locked: standing and starting off have no travel to cancel. */
export const MIN_LOCK_SPEED = 0.25;
/** Leg reach a locked foot may demand (share of full extension); the pelvis dips to stay inside it. */
export const MAX_REACH = 0.98;
/** A body that moves further than this (m) in one frame was teleported, not walked: forget the pins. */
const MAX_BODY_STEP = 0.5;
/** Most the pelvis may dip (m) to make room for a locked foot; a lock that needs more lets go. */
export const MAX_DIP = 0.06;
/** A swinging foot keeps at least this clearance (m): the baked toes graze the floor mid-swing (a 5 m/s scrape in Remy's Walk). */
export const SWING_CLEARANCE = 0.015;
/** While standing, the foot may stay turned this far (rad) from where the clip points it before it follows the body. */
export const MAX_HOLD_YAW = 0.6;
/** Seconds to blend the correction in (touchdown: the foot arrives where the pin is, so quick) and out (lift-off). */
export const BLEND_IN_S = 0.04;
export const BLEND_OUT_S = 0.1;
export const BLEND_S = BLEND_IN_S;
/** Time constant (s) of the pelvis dip. */
export const DIP_TAU_S = 0.05;

const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const invScene = new THREE.Matrix4();
const Y_UP = new THREE.Vector3(0, 1, 0);

/**
 * Two-bone IK in world space. Hip `a`, knee `b`, ankle `c` as posed; aim the ankle at `t`. The knee stays on the side
 * of the a-c line it was on (`b`'s perpendicular offset is the pole); if the leg is straight, `fallbackPole` decides.
 * An unreachable target is clamped to 0.999 of full extension (or the fold minimum). Writes the new knee and ankle;
 * returns d / (l1 + l2), the reach the UNclamped target asked for.
 */
export function solveTwoBone(
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  t: THREE.Vector3,
  fallbackPole: THREE.Vector3,
  outKnee: THREE.Vector3,
  outAnkle: THREE.Vector3,
): number {
  const l1 = a.distanceTo(b);
  const l2 = b.distanceTo(c);
  const ab = tmpV.copy(b).sub(a);
  const acN = new THREE.Vector3().copy(c).sub(a).normalize();
  const pole = ab.clone().addScaledVector(acN, -ab.dot(acN));
  const at = new THREE.Vector3().copy(t).sub(a);
  const d = at.length();
  const dir = d > 1e-9 ? at.divideScalar(d) : acN.clone();
  if (pole.lengthSq() < 1e-8) pole.copy(fallbackPole);
  pole.addScaledVector(dir, -pole.dot(dir));
  if (pole.lengthSq() < 1e-12) pole.set(0, 0, 1).addScaledVector(dir, -dir.z);
  pole.normalize();
  const dc = Math.min(Math.max(d, Math.abs(l1 - l2) + 1e-4), (l1 + l2) * 0.999);
  const x = (l1 * l1 - l2 * l2 + dc * dc) / (2 * dc);
  const y = Math.sqrt(Math.max(l1 * l1 - x * x, 0));
  outKnee.copy(a).addScaledVector(dir, x).addScaledVector(pole, y);
  outAnkle.copy(a).addScaledVector(dir, dc);
  return d / (l1 + l2);
}

/** Rotate `bone` (world-space shortest arc) so the direction pivot -> `from` points at pivot -> `to`; matrices must be current. */
function aim(bone: THREE.Object3D, pivot: THREE.Vector3, from: THREE.Vector3, to: THREE.Vector3): void {
  const u = tmpV.copy(from).sub(pivot).normalize();
  const v = new THREE.Vector3().copy(to).sub(pivot).normalize();
  tmpQ.setFromUnitVectors(u, v);
  bone.getWorldQuaternion(tmpQ2);
  tmpQ2.premultiply(tmpQ);
  setWorldQuaternion(bone, tmpQ2);
}

function setWorldQuaternion(bone: THREE.Object3D, world: THREE.Quaternion): void {
  const parent = bone.parent;
  if (parent) {
    parent.getWorldQuaternion(tmpQ);
    bone.quaternion.copy(tmpQ.invert()).multiply(world);
  } else {
    bone.quaternion.copy(world);
  }
  bone.updateMatrixWorld(true);
}

/** A point on the sole, fixed in a bone's frame. */
export interface Landmark {
  bone: THREE.Object3D;
  /** Position in the bone's frame. */
  local: THREE.Vector3;
  /** Height in the scene frame in the bind pose (feet flat on the floor), as `ContactPoint.restY`. */
  restY: number;
  pinned: boolean;
  /** Set again once the landmark has been seen up or moving forward; a pin needs it (a release must not re-pin at once). */
  armed: boolean;
  pinX: number;
  pinZ: number;
  /** This frame / last frame: the clip-posed world position, and where it sits with the foot turned to the held orientation. */
  pos: THREE.Vector3;
  held: THREE.Vector3;
  prev: THREE.Vector3;
  hasPrev: boolean;
}

export interface Leg {
  thigh: THREE.Object3D;
  shin: THREE.Object3D;
  foot: THREE.Object3D;
  landmarks: Landmark[];
  /** 0..1 strength of the correction (ramps up while any landmark is pinned, down otherwise). */
  w: number;
  /** The raw offset (world XZ) that puts the pinned landmarks back on their pins; held while the strength fades out. */
  offX: number;
  offZ: number;
  /** Smoothed lift (m) that keeps the swinging foot off the floor. */
  lift: number;
  /** Standing hold: the foot's world orientation when the hold began (kept within MAX_HOLD_YAW of the clip's), and its 0..1 blend. */
  holdQ: THREE.Quaternion;
  hold: number;
  /** The orientation the foot gets this frame (the clip's, turned toward holdQ by the hold blend). */
  footQ: THREE.Quaternion;
  /** This frame: the clip-posed ankle (world), the point to hold it at, and whether the lock is (fading) on. */
  clip: THREE.Vector3;
  target: THREE.Vector3;
  on: boolean;
}

function newLandmark(bone: THREE.Object3D, local: THREE.Vector3, restY: number): Landmark {
  return {
    bone,
    local,
    restY,
    pinned: false,
    armed: true,
    pinX: 0,
    pinZ: 0,
    pos: new THREE.Vector3(),
    held: new THREE.Vector3(),
    prev: new THREE.Vector3(),
    hasPrev: false,
  };
}

/** Thigh > shin > foot chains of `scene` by bone name, with a landmark per contact joint below each ankle. Empty without legs. */
export function findLegs(scene: THREE.Object3D, points: readonly ContactPoint[]): Leg[] {
  const legs: Leg[] = [];
  scene.traverse((o) => {
    if (!THIGH_BONE.test(o.name)) return;
    const shin = o.children.find((c) => SHIN_BONE.test(c.name));
    const foot = shin?.children.find((c) => FOOT_BONE.test(c.name));
    if (!shin || !foot) return;
    const below = (n: THREE.Object3D): boolean => {
      for (let p: THREE.Object3D | null = n; p; p = p.parent) if (p === foot) return true;
      return false;
    };
    legs.push({
      thigh: o,
      shin,
      foot,
      landmarks: points.filter((p) => below(p.bone)).map((p) => newLandmark(p.bone, new THREE.Vector3(), p.restY)),
      w: 0,
      offX: 0,
      offZ: 0,
      lift: 0,
      holdQ: new THREE.Quaternion(),
      hold: 0,
      footQ: new THREE.Quaternion(),
      clip: new THREE.Vector3(),
      target: new THREE.Vector3(),
      on: false,
    });
  });
  return legs;
}

/**
 * The rearmost (`dir` -1: heel) or foremost (`dir` +1: toe tip) low sole vertex skinned dominantly to the foot or its
 * toe bones, read from the bind data so it works in any pose: vertex -> bind world through the mesh's bind matrix, ->
 * the frame of the bone that owns it through that bone's inverse bind matrix. Null without a skinned mesh on the foot.
 */
export function findSoleExtreme(scene: THREE.Object3D, leg: Leg, dir: 1 | -1): Landmark | null {
  const footBones = new Set<THREE.Object3D>();
  leg.foot.traverse((o) => footBones.add(o));
  const v = new THREE.Vector3();
  const w = new THREE.Vector3();
  const m4 = new THREE.Matrix4();
  let best: { score: number; local: THREE.Vector3; y: number; bone: THREE.Object3D } | null = null;
  scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    const sk = m.skeleton;
    const fi = sk.bones.indexOf(leg.foot as THREE.Bone);
    if (fi < 0) return;
    // bind-world frame of the foot, its forward direction (ankle -> farthest toe landmark, horizontal)
    const ankle = new THREE.Vector3().setFromMatrixPosition(m4.copy(sk.boneInverses[fi]).invert());
    const fwd = new THREE.Vector3();
    for (const lm of leg.landmarks) {
      const bi = sk.bones.indexOf(lm.bone as THREE.Bone);
      if (bi < 0) continue;
      const p = new THREE.Vector3().setFromMatrixPosition(m4.copy(sk.boneInverses[bi]).invert());
      p.sub(ankle).setY(0);
      if (p.lengthSq() > fwd.lengthSq()) fwd.copy(p);
    }
    if (fwd.lengthSq() < 1e-8) return;
    fwd.normalize();
    const pos = m.geometry.attributes.position;
    const si = m.geometry.attributes.skinIndex;
    const sw = m.geometry.attributes.skinWeight;
    if (!pos || !si || !sw) return;
    for (let i = 0; i < pos.count; i++) {
      let bi = -1;
      let bw = -1;
      for (let k = 0; k < 4; k++) {
        const wk = sw.getComponent(i, k);
        if (wk > bw) {
          bw = wk;
          bi = si.getComponent(i, k);
        }
      }
      if (!footBones.has(sk.bones[bi])) continue;
      v.fromBufferAttribute(pos, i).applyMatrix4(m.bindMatrix); // bind-world
      if (v.y > 0.04) continue; // not the sole
      const along = w.copy(v).sub(ankle).setY(0).dot(fwd);
      const score = dir * along - (0.02 * v.y) / 0.04; // extreme along the foot, nudged toward the floor
      if (!best || score > best.score) {
        best = { score, local: v.clone().applyMatrix4(sk.boneInverses[bi]), y: v.y, bone: sk.bones[bi] };
      }
    }
  });
  if (!best) return null;
  const found = best as { score: number; local: THREE.Vector3; y: number; bone: THREE.Object3D };
  return newLandmark(found.bone, found.local, found.y);
}

/** Cubic ease alpha(t) = 2t^3 - 3t^2 + 1 of Kovar et al., as a 0 -> 1 ramp. */
export function easeBlend(w: number): number {
  const t = Math.min(Math.max(w, 0), 1);
  return 3 * t * t - 2 * t * t * t;
}

export class FootLock {
  readonly legs: Leg[];
  private readonly scene: THREE.Object3D;
  private heelsDone = false;
  private readonly prevBody = new THREE.Vector3();
  private hasBody = false;
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly c = new THREE.Vector3();
  private readonly knee = new THREE.Vector3();
  private readonly ankle = new THREE.Vector3();
  private readonly bodyDisp = new THREE.Vector3();
  private readonly rel = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly clipQ = new THREE.Quaternion();
  private readonly clipInv = new THREE.Quaternion();
  private readonly holdD = new THREE.Quaternion();
  private readonly dEff = new THREE.Quaternion();
  private readonly yawQ = new THREE.Quaternion();
  private readonly pole = new THREE.Vector3();
  /** How many legs were corrected last update (tests / HUD). */
  active = 0;
  /** The pelvis dip applied last update (m). */
  dip = 0;

  constructor(scene: THREE.Object3D, points: readonly ContactPoint[]) {
    this.scene = scene;
    this.legs = findLegs(scene, points);
  }

  get usable(): boolean {
    return this.legs.length > 0;
  }

  /** Forget history (figure teleported, left the gait path). */
  reset(): void {
    this.hasBody = false;
    this.dip = 0;
    for (const l of this.legs) {
      l.w = 0;
      l.lift = 0;
      l.hold = 0;
      l.on = false;
      for (const m of l.landmarks) {
        m.pinned = false;
        m.armed = true;
        m.hasPrev = false;
      }
    }
  }

  /** Add the heel and toe-tip landmarks from the mesh the first time the gait path needs them (crowd figures never do). */
  private ensureHeels(): void {
    if (this.heelsDone) return;
    this.heelsDone = true;
    for (const leg of this.legs) {
      const heel = findSoleExtreme(this.scene, leg, -1);
      if (heel) leg.landmarks.push(heel);
      const tip = findSoleExtreme(this.scene, leg, 1);
      if (tip) leg.landmarks.push(tip);
    }
  }

  /**
   * Call after the mixer update, root-motion cancel and grounding, once per frame, only while the gait drives the
   * figure. `group` is the figure's group (its world position is the body's travel), `scene` the skinned scene,
   * `drop` how far grounding lowered the figure (m): landmark clearance is measured in the scene frame, so the
   * height above the floor is that clearance minus the drop.
   */
  update(group: THREE.Object3D, scene: THREE.Object3D, speed: number, delta: number, drop = 0): void {
    this.active = 0;
    if (this.legs.length === 0) return;
    this.ensureHeels();
    group.updateWorldMatrix(true, true);
    invScene.copy(scene.matrixWorld).invert();
    group.getWorldPosition(tmpV);
    this.bodyDisp.copy(tmpV).sub(this.prevBody);
    this.bodyDisp.y = 0;
    const hadBody = this.hasBody;
    this.prevBody.copy(tmpV);
    if (hadBody && this.bodyDisp.length() > MAX_BODY_STEP) {
      // Teleported (respawn, debug jump, door hand-over): the pins belong to the old place. Start over, clip pose only.
      this.reset();
      return;
    }
    this.hasBody = true;
    const bodyLen = this.bodyDisp.length();
    const moving = hadBody && speed >= MIN_LOCK_SPEED && bodyLen > 1e-5;
    // Standing: the stance is held, not tracked. Both feet stay where they are, position and yaw (the idle clip sways a
    // centimetre or two and the walker turns the body toward the view on the spot; either one made the soles skate).
    const standing = hadBody && speed < MIN_LOCK_SPEED;
    const dt = Math.min(delta, 0.1);
    const stepIn = dt / BLEND_IN_S;
    const stepOut = dt / BLEND_OUT_S;
    this.fwd.copy(this.bodyDisp).divideScalar(bodyLen > 1e-9 ? bodyLen : 1);

    // ---- pass 1: clip pose, pins, targets, required dip ----
    let need = 0;
    let any = false;
    for (const leg of this.legs) {
      leg.foot.getWorldPosition(leg.clip);
      leg.foot.getWorldQuaternion(this.clipQ);
      const curX = leg.offX * easeBlend(leg.w);
      const curZ = leg.offZ * easeBlend(leg.w);
      // Standing hold: keep the foot's world orientation from when the hold began, but never more than MAX_HOLD_YAW away
      // from the clip's (past that the foot follows the body round: a slow pivot instead of a stuck leg).
      this.holdD.copy(leg.holdQ).multiply(this.clipInv.copy(this.clipQ).invert());
      if (leg.hold > 0 || standing) {
        const yaw = 2 * Math.atan2(this.holdD.y, this.holdD.w);
        const wrapped = Math.atan2(Math.sin(yaw), Math.cos(yaw));
        if (Math.abs(wrapped) > MAX_HOLD_YAW) {
          const over = wrapped - Math.sign(wrapped) * MAX_HOLD_YAW;
          leg.holdQ.premultiply(this.yawQ.setFromAxisAngle(Y_UP, -over));
          this.holdD.copy(leg.holdQ).multiply(this.clipInv);
        }
      }
      // D turns the clip's foot into the held one (about the ankle); identity when nothing is held.
      this.dEff.identity().slerp(this.holdD, easeBlend(leg.hold));
      leg.footQ.copy(this.dEff).multiply(this.clipQ);
      let changed = false;
      let lowest = Infinity;
      for (const m of leg.landmarks) {
        m.pos.copy(m.local).applyMatrix4(m.bone.matrixWorld);
        let back = 0;
        if (m.hasPrev && moving) {
          this.rel.copy(m.pos).sub(m.prev).sub(this.bodyDisp);
          back = -this.rel.dot(this.fwd) / bodyLen; // share of the body's travel it goes back by
        }
        m.prev.copy(m.pos);
        m.hasPrev = true;
        // Where this point sits with the foot turned to the held orientation (about the ankle).
        m.held.copy(m.pos).sub(leg.clip).applyQuaternion(this.dEff).add(leg.clip);
        const clearance = tmpV.copy(m.pos).applyMatrix4(invScene).y - m.restY - drop;
        lowest = Math.min(lowest, clearance);
        const up = standing
          ? clearance > RELEASE_CLEARANCE
          : !moving || clearance > RELEASE_CLEARANCE || back < -FORWARD_RELEASE_SHARE;
        if (m.pinned) {
          if (up) {
            m.pinned = false;
            changed = true;
          }
        } else {
          if (up) m.armed = true;
          const ready = standing || (moving && m.armed && back > PLANT_BACK_SHARE);
          if (ready && clearance < PLANT_CLEARANCE) {
            m.pinned = true;
            changed = true;
          }
        }
      }
      // Whenever the pinned set changes, re-base every pin on the offset in force, so the offset stays continuous.
      if (changed) {
        for (const m of leg.landmarks) {
          if (!m.pinned) continue;
          m.pinX = m.held.x + curX;
          m.pinZ = m.held.z + curZ;
        }
      }
      let n = 0;
      let sx = 0;
      let sz = 0;
      for (const m of leg.landmarks) {
        if (!m.pinned) continue;
        n++;
        sx += m.pinX - m.held.x;
        sz += m.pinZ - m.held.z;
      }
      // The orientation hold starts with the first pin while standing and ends when the lock does (or the bot moves off).
      if (n > 0 && standing) {
        if (leg.hold <= 0) leg.holdQ.copy(this.clipQ);
        leg.hold = Math.min(1, leg.hold + stepIn);
      } else {
        leg.hold = Math.max(0, leg.hold - stepOut);
      }
      if (n > 0) {
        leg.offX = sx / n;
        leg.offZ = sz / n;
        leg.w = Math.min(1, leg.w + stepIn);
      } else {
        leg.w = Math.max(0, leg.w - stepOut);
      }
      // A foot with no pin is in swing: keep its lowest landmark above SWING_CLEARANCE (raise fast, relax slower).
      const wantLift = n === 0 && moving && Number.isFinite(lowest) ? Math.max(0, SWING_CLEARANCE - lowest) : 0;
      leg.lift += (wantLift - leg.lift) * Math.min(1, dt / (wantLift > leg.lift ? 0.03 : 0.06));
      if (leg.lift < 1e-4) leg.lift = 0;
      leg.on = leg.w > 0 || leg.lift > 0;
      if (!leg.on) continue;
      any = true;
      const k = easeBlend(leg.w);
      leg.target.set(leg.clip.x + leg.offX * k, leg.clip.y + leg.lift, leg.clip.z + leg.offZ * k);
      if (leg.w <= 0) continue; // lift only: no pin to make room for
      leg.thigh.getWorldPosition(this.a);
      leg.shin.getWorldPosition(this.b);
      const full = this.a.distanceTo(this.b) + this.b.distanceTo(leg.clip);
      const dx = leg.target.x - this.a.x;
      const dz = leg.target.z - this.a.z;
      const r2 = (MAX_REACH * full) ** 2 - dx * dx - dz * dz;
      // Hip height that puts the ankle target at MAX_REACH, vs where the hip is now: the dip this leg asks for.
      const ask = r2 > 0 ? this.a.y - leg.target.y - Math.sqrt(r2) : Infinity;
      if (ask > MAX_DIP) {
        // Out of reach even with the pelvis down: let go (fades out; re-pins after the landmark has been up).
        for (const m of leg.landmarks) {
          if (m.pinned) {
            m.pinned = false;
            m.armed = false;
          }
        }
        // The lock cannot hold this stance: drop the offset too, or a standing re-pin re-bases onto the stale one.
        leg.offX = 0;
        leg.offZ = 0;
        leg.w = 0;
        leg.hold = 0;
        continue;
      }
      need = Math.max(need, ask);
    }
    // Smooth the dip so it never pops when a plant starts or ends.
    this.dip += (Math.max(need, 0) - this.dip) * Math.min(1, dt / DIP_TAU_S);
    if (!any && this.dip < 1e-4) {
      this.dip = 0;
      return;
    }

    // ---- pass 2: lower the pelvis, then re-aim every leg at its world target ----
    group.position.y -= this.dip;
    // updateMatrixWorld, not updateWorldMatrix: a SkinnedMesh refreshes its bindMatrixInverse only in the former.
    group.updateMatrixWorld(true);
    for (const leg of this.legs) {
      if (!leg.on && this.dip < 1e-4) continue;
      const t = leg.on ? leg.target : leg.clip; // a swing leg keeps the clip's world position: the dip bends its knee
      leg.thigh.getWorldPosition(this.a);
      leg.shin.getWorldPosition(this.b);
      leg.foot.getWorldPosition(this.c);
      solveTwoBone(this.a, this.b, this.c, t, this.fwdPole(group), this.knee, this.ankle);
      aim(leg.thigh, this.a, this.b, this.knee);
      leg.shin.getWorldPosition(this.b); // == knee now
      leg.foot.getWorldPosition(this.c); // moved with the thigh
      aim(leg.shin, this.b, this.c, this.ankle);
      setWorldQuaternion(leg.foot, leg.footQ); // the foot keeps the orientation the clip gave it (or the held one while standing)
      this.active++;
    }
  }

  /** A straight leg bends forward: the group's +Z in world space. */
  private fwdPole(group: THREE.Object3D): THREE.Vector3 {
    return this.pole.set(0, 0, 1).applyQuaternion(group.getWorldQuaternion(tmpQ2));
  }
}

/** `?footlock=0` (or `window.__footlock(false)`) turns the runtime lock off for A/B checks in the real console. */
let enabled = true;
if (typeof window !== "undefined") {
  try {
    if (new URLSearchParams(window.location.search).get("footlock") === "0") enabled = false;
  } catch {
    /* no location (tests) */
  }
  (window as unknown as { __footlock?: (on?: boolean) => boolean }).__footlock = (on?: boolean) => {
    if (on !== undefined) enabled = on;
    return enabled;
  };
}
export const footLockEnabled = (): boolean => enabled;
export const setFootLockEnabled = (on: boolean): void => {
  enabled = on;
};
