import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { ArmReach, REACH_IN_S, REACH_OUT_S, reachWeight } from "./armReach";

function arm() {
  const root = new THREE.Group();
  const upper = new THREE.Bone(); upper.name = "mixamorigRightArm"; upper.position.set(0.2, 1.4, 0);
  const fore = new THREE.Bone(); fore.name = "mixamorigRightForeArm"; fore.position.set(0, -0.28, 0.03);
  const hand = new THREE.Bone(); hand.name = "mixamorigRightHand"; hand.position.set(0, -0.26, 0.04);
  hand.quaternion.setFromEuler(new THREE.Euler(0.4, 0.2, -0.3));
  root.add(upper); upper.add(fore); fore.add(hand);
  root.updateMatrixWorld(true);
  return { root, hand, reach: ArmReach.find(root)! };
}
const grip = new THREE.Vector3(0.02, -0.08, 0.05);
const pole = new THREE.Vector3(0, 0, -1);

describe("arm reach", () => {
  test("puts the grip point on a reachable target and keeps the hand orientation", () => {
    const { hand, reach } = arm();
    const before = hand.getWorldQuaternion(new THREE.Quaternion());
    const target = new THREE.Vector3(0.28, 0.95, 0.3);
    reach.update(grip, target, 1, pole);
    expect(hand.localToWorld(grip.clone()).distanceTo(target)).toBeLessThan(0.01);
    expect(hand.getWorldQuaternion(new THREE.Quaternion()).angleTo(before)).toBeLessThan(1e-4);
  });

  test("weight 0 leaves the clip pose alone", () => {
    const { hand, reach } = arm();
    const at = hand.localToWorld(grip.clone());
    reach.update(grip, new THREE.Vector3(0.28, 0.95, 0.3), 0, pole);
    expect(hand.localToWorld(grip.clone()).distanceTo(at)).toBe(0);
  });

  test("weight eases in before contact, peaks at contact, eases out after", () => {
    expect(reachWeight(2 - REACH_IN_S - 0.1, 2)).toBe(0);
    expect(reachWeight(2, 2)).toBe(1);
    expect(reachWeight(2 - REACH_IN_S / 2, 2)).toBeCloseTo(0.5, 5);
    expect(reachWeight(2 + REACH_OUT_S + 0.1, 2)).toBe(0);
  });
});
