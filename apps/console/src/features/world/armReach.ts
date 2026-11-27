// Hand reach at a prop contact: the clip's right arm is re-aimed (shoulder, elbow) so a hand-local grip point
// meets a world target. The hand keeps the orientation the clip gave it. Same two-bone solve as the foot lock.
import * as THREE from "three";
import { aim, easeBlend, setWorldQuaternion, solveTwoBone } from "./footLock";

/** Seconds of blend before and after contact. */
export const REACH_IN_S = 0.5;
export const REACH_OUT_S = 0.4;
/** Deepest knee bend (m of hip drop) a reach may add when the clip's arm is too short for the target. */
export const MAX_REACH_DIP = 0.15;
/** Share of the arm's length the solve may use: a locked-straight elbow reads as stiff. */
const REACH_SHARE = 0.97;

type LegBones = { thigh: THREE.Object3D; shin: THREE.Object3D; foot: THREE.Object3D };
const la = new THREE.Vector3(), lb = new THREE.Vector3(), lc = new THREE.Vector3(), lk = new THREE.Vector3(), lt = new THREE.Vector3();
const lq = new THREE.Quaternion();

/**
 * Lower `group` by `dip` (m), shift it forward by `lean`, and keep the clip’s feet planted (two-bone solve per leg,
 * knee toward `pole`). World matrices must be current.
 */
export function dipWithLegs(group: THREE.Object3D, legs: readonly LegBones[], dip: number, pole: THREE.Vector3, lean = 0): void {
  if (dip <= 0) return;
  const feet = legs.map((l) => ({ p: l.foot.getWorldPosition(new THREE.Vector3()), q: l.foot.getWorldQuaternion(new THREE.Quaternion()) }));
  group.position.y -= dip;
  group.translateZ(lean);
  group.updateMatrixWorld(true);
  legs.forEach((l, i) => {
    l.thigh.getWorldPosition(la); l.shin.getWorldPosition(lb); l.foot.getWorldPosition(lc);
    solveTwoBone(la, lb, lc, feet[i].p, pole, lk, lt);
    aim(l.thigh, la, lb, lk);
    l.shin.getWorldPosition(lb); l.foot.getWorldPosition(lc);
    aim(l.shin, lb, lc, lt);
    setWorldQuaternion(l.foot, lq.copy(feet[i].q));
  });
}

/** IK weight around a contact time: eases 0 to 1 over REACH_IN_S before it, back to 0 over REACH_OUT_S after. */
export function reachWeight(time: number, contact: number): number {
  return time <= contact
    ? easeBlend(1 - (contact - time) / REACH_IN_S)
    : easeBlend(1 - (time - contact) / REACH_OUT_S);
}

export class ArmReach {
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly c = new THREE.Vector3();
  private readonly t = new THREE.Vector3();
  private readonly grip = new THREE.Vector3();
  private readonly elbow = new THREE.Vector3();
  private readonly wrist = new THREE.Vector3();
  private readonly pole = new THREE.Vector3();
  private readonly handQ = new THREE.Quaternion();
  private readonly swing = new THREE.Quaternion();
  private readonly upperRest = new THREE.Quaternion();
  private readonly foreRest = new THREE.Quaternion();
  private readonly handRest = new THREE.Quaternion();
  private readonly rollFrom = new THREE.Vector3();
  private readonly rollTo = new THREE.Vector3();

  private readonly upper: THREE.Object3D;
  private readonly fore: THREE.Object3D;
  private readonly hand: THREE.Object3D;
  constructor(upper: THREE.Object3D, fore: THREE.Object3D, hand: THREE.Object3D) {
    this.upper = upper; this.fore = fore; this.hand = hand;
  }

  static find(scene: THREE.Object3D): ArmReach | null {
    const [upper, fore, hand] = ["mixamorigRightArm", "mixamorigRightForeArm", "mixamorigRightHand"].map((n) => scene.getObjectByName(n));
    return upper && fore && hand ? new ArmReach(upper, fore, hand) : null;
  }

  private readonly s = new THREE.Vector3();

  /** Hip drop (m, 0..MAX_REACH_DIP) that brings the target inside the arm's reach; 0 when the arm already reaches. */
  dipNeeded(gripLocal: THREE.Vector3, target: THREE.Vector3): number {
    this.upper.getWorldPosition(this.a);
    this.fore.getWorldPosition(this.b);
    this.hand.getWorldPosition(this.c);
    const reach = (this.a.distanceTo(this.b) + this.b.distanceTo(this.c)) * REACH_SHARE;
    this.hand.localToWorld(this.grip.copy(gripLocal)).sub(this.c);
    this.t.copy(target).sub(this.grip); // where the wrist must go
    const dy = this.a.y - this.t.y, dxz = Math.hypot(this.a.x - this.t.x, this.a.z - this.t.z);
    if (Math.hypot(dxz, dy) <= reach || dxz >= reach) return 0;
    return THREE.MathUtils.clamp(dy - Math.sqrt(reach * reach - dxz * dxz), 0, MAX_REACH_DIP);
  }
  handWorldScale(): number { return this.hand.getWorldScale(this.s).x; }

  /** Pull the arm so `gripLocal` (hand-local) lands on `target` (world) at weight `w`. World matrices must be current. */
  update(gripLocal: THREE.Vector3, target: THREE.Vector3, w: number, fallbackPole: THREE.Vector3): void {
    if (w <= 0) return;
    this.upper.getWorldPosition(this.a);
    this.fore.getWorldPosition(this.b);
    this.hand.getWorldPosition(this.c);
    this.hand.getWorldQuaternion(this.handQ);
    // With the hand's orientation held, the grip rides a fixed world offset from the wrist.
    this.hand.localToWorld(this.grip.copy(gripLocal)).sub(this.c);
    this.t.copy(target).sub(this.grip).sub(this.c).multiplyScalar(Math.min(w, 1)).add(this.c);
    solveTwoBone(this.a, this.b, this.c, this.t, this.pole.copy(fallbackPole), this.elbow, this.wrist);
    aim(this.upper, this.a, this.b, this.elbow);
    this.fore.getWorldPosition(this.b);
    this.hand.getWorldPosition(this.c);
    aim(this.fore, this.b, this.c, this.wrist);
    setWorldQuaternion(this.hand, this.handQ);
  }

  /**
   * Follow a held prop without hinging the wrist. Solve to the grip point
   * with the hand as an extension of the forearm, then place the wrist
   * back along that segment at its own bone length.
   */
  followGrip(
    gripLocal: THREE.Vector3, target: THREE.Vector3, weight: number, elbowPole: THREE.Vector3,
    orientation?: { localAxis: THREE.Vector3; worldAxis: THREE.Vector3 },
  ): void {
    if (weight <= 0) return;
    this.upper.getWorldPosition(this.a);
    this.fore.getWorldPosition(this.b);
    this.hand.getWorldPosition(this.c);
    const foreLength = this.b.distanceTo(this.c);
    const handLength = this.hand.localToWorld(this.grip.copy(gripLocal)).distanceTo(this.c);
    if (!foreLength || !handLength) return;
    this.upperRest.copy(this.upper.quaternion);
    this.foreRest.copy(this.fore.quaternion);
    this.handRest.copy(this.hand.quaternion);

    const reach = foreLength + handLength;
    this.t.copy(this.c).sub(this.b).normalize().multiplyScalar(reach).add(this.b);
    solveTwoBone(this.a, this.b, this.t, target, elbowPole, this.elbow, this.wrist, 1);
    this.wrist.lerp(this.elbow, handLength / reach);
    aim(this.upper, this.a, this.b, this.elbow);
    this.fore.getWorldPosition(this.b);
    this.hand.getWorldPosition(this.c);
    aim(this.fore, this.b, this.c, this.wrist);

    // Aim the grip along the solved forearm, keeping the roll carried by
    // the forearm itself as the hand lifts and lowers.
    this.hand.getWorldQuaternion(this.handQ);
    this.grip.copy(gripLocal).normalize().applyQuaternion(this.handQ);
    this.t.copy(this.wrist).sub(this.elbow).normalize();
    this.swing.setFromUnitVectors(this.grip, this.t);
    this.handQ.premultiply(this.swing);

    if (orientation) {
      const { localAxis, worldAxis } = orientation;
      // Roll around the solved forearm first, then use the shortest wrist
      // adjustment to meet the prop axis. Re-solve position with that wrist.
      this.grip.copy(localAxis).applyQuaternion(this.handQ);
      this.rollFrom.copy(this.grip).projectOnPlane(this.t).normalize();
      this.rollTo.copy(worldAxis).projectOnPlane(this.t).normalize();
      const cosine = this.rollFrom.dot(this.rollTo);
      const angle = Math.atan2(this.rollFrom.cross(this.rollTo).dot(this.t), cosine);
      this.handQ.premultiply(this.swing.setFromAxisAngle(this.t, angle));
      this.grip.copy(localAxis).applyQuaternion(this.handQ);
      this.handQ.premultiply(this.swing.setFromUnitVectors(this.grip, worldAxis));
    }
    setWorldQuaternion(this.hand, this.handQ);
    if (orientation) this.update(gripLocal, target, 1, elbowPole);

    if (weight < 1) {
      this.upper.quaternion.slerp(this.upperRest, 1 - weight);
      this.fore.quaternion.slerp(this.foreRest, 1 - weight);
      this.hand.quaternion.slerp(this.handRest, 1 - weight);
      this.upper.updateMatrixWorld(true);
    }
  }
}
