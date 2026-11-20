import * as THREE from "three";
import { RIM_RADIUS, RIM_TUBE } from "./car";

type Joint = { bone: THREE.Object3D; next: THREE.Object3D };

// The wrist stays on the driver side of the rim. Finger links follow its cross section from
// the outer edge toward the back, with enough clearance for Remy's skinned finger thickness.
export class SteeringGrip {
  private readonly hand: THREE.Object3D;
  private readonly middle: THREE.Object3D;
  private readonly fingers: Joint[];
  private readonly gripCenter = new THREE.Vector3();
  private readonly palmForward = new THREE.Vector3();
  private readonly palmRotation: THREE.Quaternion;
  private readonly start = new THREE.Vector3();
  private readonly end = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly radial = new THREE.Vector3();
  private readonly inverse = new THREE.Quaternion();
  private readonly rotation = new THREE.Quaternion();

  constructor(side: "Left" | "Right", bone: (name: string) => THREE.Object3D) {
    this.hand = bone(`${side}Hand`);
    this.middle = bone(`${side}HandMiddle1`);
    this.fingers = ["Index", "Middle", "Ring", "Pinky"].flatMap((finger) => {
      const name = `${side}Hand${finger}`;
      return [1, 2, 3].map((joint) => ({ bone: bone(name + joint), next: bone(name + (joint + 1)) }));
    });
    const radial = new THREE.Vector3(side === "Left" ? 1 : -1, 0, 0.1).normalize();
    this.gripCenter.copy(radial).multiplyScalar(RIM_RADIUS + 0.021).setY(0.021);
    this.palmForward.copy(radial).multiplyScalar(0.68).setY(-0.73).normalize();
    const palmNormal = radial.multiplyScalar(-0.73).setY(-0.68).normalize();
    const across = new THREE.Vector3().crossVectors(this.palmForward, palmNormal);
    this.palmRotation = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(across, this.palmForward, palmNormal),
    );
  }

  wristTarget(wheel: THREE.Object3D) {
    this.hand.getWorldPosition(this.start);
    const palmLength = this.middle.getWorldPosition(this.end).distanceTo(this.start);
    return wheel.localToWorld(this.target.copy(this.gripCenter).addScaledVector(this.palmForward, -palmLength));
  }

  pose(wheel: THREE.Object3D, weight: number) {
    this.hand.parent!.getWorldQuaternion(this.inverse).invert();
    wheel.getWorldQuaternion(this.rotation).multiply(this.palmRotation).premultiply(this.inverse);
    this.hand.quaternion.slerp(this.rotation, weight);
    this.hand.updateWorldMatrix(false, true);

    for (const { bone, next } of this.fingers) {
      bone.getWorldPosition(this.start);
      const length = next.getWorldPosition(this.end).distanceTo(this.start);
      const point = wheel.worldToLocal(this.target.copy(this.start));
      const planarDistance = this.radial.set(point.x, 0, point.z).length();
      this.radial.divideScalar(planarDistance || 1);
      const offset = planarDistance - RIM_RADIUS;
      const angle = Math.atan2(point.y, offset);
      const radius = Math.max(RIM_TUBE + 0.015, Math.hypot(offset, point.y));
      const curl = 2 * Math.asin(Math.min(0.9, length / (2 * radius)));
      const around = angle - curl;
      point.copy(this.radial).multiplyScalar(RIM_RADIUS + Math.cos(around) * radius).setY(Math.sin(around) * radius);
      wheel.localToWorld(point);

      bone.parent!.getWorldQuaternion(this.inverse).invert();
      this.end.sub(this.start).normalize().applyQuaternion(this.inverse);
      point.sub(this.start).normalize().applyQuaternion(this.inverse);
      this.rotation.setFromUnitVectors(this.end, point).multiply(bone.quaternion);
      bone.quaternion.slerp(this.rotation, weight);
      bone.updateWorldMatrix(false, true);
    }
  }
}
