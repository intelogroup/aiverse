// Hand reach at a prop contact: the clip's right arm is re-aimed (shoulder, elbow) so a hand-local grip point
// meets a world target. The hand keeps the orientation the clip gave it. Same two-bone solve as the foot lock.
import * as THREE from "three";
import { aim, easeBlend, setWorldQuaternion, solveTwoBone } from "./footLock";

/** Seconds of blend before and after contact. */
export const REACH_IN_S = 0.5;
export const REACH_OUT_S = 0.4;

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
}
