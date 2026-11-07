import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { clipMinClearance, contactPoints, FOOT_JOINT, groundingOffset, rootMotionDelta, soleClearance } from "./grounding";

/** scene -> Armature(scale s, -90 deg X like a Mixamo FBX) -> Hips -> {LeftFoot -> LeftToeBase, RightFoot} */
function rig(armatureScale = 1) {
  const scene = new THREE.Group();
  const arm = new THREE.Object3D();
  arm.name = "Armature";
  arm.scale.setScalar(armatureScale);
  scene.add(arm);
  const hips = new THREE.Bone();
  hips.name = "mixamorigHips";
  hips.position.set(0, 0.9 / armatureScale, 0);
  arm.add(hips);
  const mk = (name: string, parent: THREE.Object3D, x: number, y: number) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x / armatureScale, y / armatureScale, 0);
    parent.add(b);
    return b;
  };
  const lf = mk("mixamorigLeftFoot", hips, 0.1, -0.83); // ankle 7 cm above the floor
  const lt = mk("mixamorigLeftToeBase", lf, 0, -0.065);
  const rf = mk("mixamorigRightFoot", hips, -0.1, -0.83);
  mk("IK-footl", scene, 0, 0.5); // control helper: must not count as a contact
  return { scene, arm, hips, lf, lt, rf };
}

describe("FOOT_JOINT", () => {
  it("matches Mixamo and sanitized KayKit foot joints, not IK helpers", () => {
    for (const n of ["mixamorig:LeftFoot", "mixamorigRightToeBase", "mixamorig_LeftToe_End", "footl", "toesr", "foot.l"])
      expect(FOOT_JOINT.test(n), n).toBe(true);
    for (const n of ["IK-footl", "heelIKl", "control-foot-rolll", "LeftFootIndex", "mixamorigLeftLeg"])
      expect(FOOT_JOINT.test(n), n).toBe(false);
  });
});

describe("soleClearance", () => {
  it("is 0 in the bind pose, the float height when the body rises, negative when a foot sinks", () => {
    const { scene, hips, lt, rf } = rig();
    const pts = contactPoints(scene);
    expect(pts).toHaveLength(3);
    expect(soleClearance(pts, scene)).toBeCloseTo(0, 6);
    hips.position.y += 0.05; // whole body up: floating 5 cm
    expect(soleClearance(pts, scene)).toBeCloseTo(0.05, 6);
    rf.position.y -= 0.08; // right foot 3 cm under the floor
    expect(soleClearance(pts, scene)).toBeCloseTo(-0.03, 6);
    void lt;
  });

  it("is measured in the scene frame: moving or lifting the group does not change it", () => {
    const { scene, hips } = rig();
    const grp = new THREE.Group();
    grp.add(scene);
    scene.position.y = 0.3; // floor lift inside the figure group
    const pts = contactPoints(scene);
    grp.position.set(5, 2, -3);
    grp.rotation.y = 1.1;
    hips.position.y += 0.02;
    expect(soleClearance(pts, scene)).toBeCloseTo(0.02, 6);
  });

  it("works under a scaled (centimetre) Armature", () => {
    const { scene, hips } = rig(0.01);
    const pts = contactPoints(scene);
    hips.position.y += 4; // 4 armature units = 4 cm
    expect(soleClearance(pts, scene)).toBeCloseTo(0.04, 6);
  });
});

describe("groundingOffset", () => {
  it("uses the live clearance with no Run, the Run cycle minimum at full Run", () => {
    expect(groundingOffset(0.06, 0.1, 0)).toBeCloseTo(0.06, 9);
    expect(groundingOffset(0.25, 0.1, 1)).toBeCloseTo(0.1, 9); // flight phase keeps its height
  });
  it("never lowers the body past its live contact (no sinking in the blend)", () => {
    expect(groundingOffset(0.04, 0.1, 0.5)).toBeCloseTo(0.04, 9);
    expect(groundingOffset(-0.02, 0.1, 0.3)).toBeCloseTo(-0.02, 9); // a sunk pose is lifted, not sunk further
  });
});

describe("clipMinClearance", () => {
  it("finds the clip's lowest contact over a cycle and restores the pose", () => {
    const { scene, hips } = rig();
    const pts = contactPoints(scene);
    const y0 = hips.position.y;
    // Hips bob between +0.02 and +0.12 m over 1 s (a run with no foot ever reaching the bind floor).
    const times = [0, 0.25, 0.5, 0.75, 1];
    const ys = [0.12, 0.02, 0.12, 0.02, 0.12].map((d) => y0 + d);
    const values = ys.flatMap((y) => [0, y, 0]);
    const clip = new THREE.AnimationClip("Run", 1, [new THREE.VectorKeyframeTrack("mixamorigHips.position", times, values)]);
    expect(clipMinClearance(scene, clip, pts, 48)).toBeCloseTo(0.02, 3);
    expect(hips.position.y).toBeCloseTo(y0, 9);
    expect(soleClearance(pts, scene)).toBeCloseTo(0, 6);
  });
});

describe("rootMotionDelta", () => {
  it("scales the hips delta by the parent's scale (Mixamo centimetre Armature)", () => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    const out = new THREE.Vector3();
    // 8.3 cm sideways in a 0.003-scaled Armature (Remy's numbers) must be 0.0249 m, not 8.3 m.
    rootMotionDelta(new THREE.Vector3(8.3, 0, 0), new THREE.Vector3(), new THREE.Vector3(0.003, 0.003, 0.003), q, out);
    expect(out.x).toBeCloseTo(0.0249, 6);
    expect(out.y).toBe(0);
  });
  it("cancels the true travel: parent moved by -delta keeps the hips over the same world point", () => {
    const { scene, arm, hips } = rig(0.01);
    arm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7);
    scene.updateMatrixWorld(true);
    const before = hips.getWorldPosition(new THREE.Vector3());
    const rest = hips.position.clone();
    const armRest = arm.position.clone();
    hips.position.add(new THREE.Vector3(12, 0, -5)); // the clip's travel, armature units
    const d = rootMotionDelta(hips.position, rest, arm.scale, arm.quaternion, new THREE.Vector3());
    arm.position.copy(armRest).sub(d);
    scene.updateMatrixWorld(true);
    const after = hips.getWorldPosition(new THREE.Vector3());
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.z).toBeCloseTo(before.z, 6);
  });
});
