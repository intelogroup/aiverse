import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { ArmReach, MAX_REACH_DIP, REACH_IN_S, REACH_OUT_S, dipWithLegs, reachWeight } from "./armReach";

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

  test("a target below the arm's reach asks for a hip drop that makes it reachable", () => {
    const { root, hand, reach } = arm();
    const target = new THREE.Vector3(0.25, 0.78, 0.2);
    expect(reach.dipNeeded(grip, new THREE.Vector3(0.28, 0.95, 0.3))).toBe(0);
    const dip = reach.dipNeeded(grip, target);
    expect(dip).toBeGreaterThan(0.02);
    expect(dip).toBeLessThan(MAX_REACH_DIP);
    root.position.y -= dip; root.updateMatrixWorld(true);
    reach.update(grip, target, 1, pole);
    expect(hand.localToWorld(grip.clone()).distanceTo(target)).toBeLessThan(0.01);
  });

  test("the dip bends the knees and keeps the feet where they were", () => {
    const root = new THREE.Group();
    const thigh = new THREE.Bone(); thigh.position.set(0.1, 0.9, 0);
    const shin = new THREE.Bone(); shin.position.set(0, -0.44, 0.02);
    const foot = new THREE.Bone(); foot.position.set(0, -0.42, -0.02);
    root.add(thigh); thigh.add(shin); shin.add(foot); root.updateMatrixWorld(true);
    const before = foot.getWorldPosition(new THREE.Vector3());
    dipWithLegs(root, [{ thigh, shin, foot }], 0.08, new THREE.Vector3(0, 0, 1));
    expect(root.position.y).toBeCloseTo(-0.08, 6);
    expect(foot.getWorldPosition(new THREE.Vector3()).distanceTo(before)).toBeLessThan(1e-3);
    expect(shin.getWorldPosition(new THREE.Vector3()).z).toBeGreaterThan(0.02); // knee forward
  });
});
