// @vitest-environment node
import { AnimationMixer, Vector3 } from "three";
import { expect, test } from "vitest";
import { BODIES } from "@aiverse/world-sim/bodies";
import { STALL_MOUTH_S, STALL_PICKUP_S, STALL_RETURN_S } from "@aiverse/world-sim/stallConsumables";
import { makeStallHandGrip, stallBottleAxis, stallFingerWeight, stallGripOffset } from "../src/features/world/stallHandGrip";
import { assetUrl, handVertices, load } from "../scripts/fit-apple-grips";

test("knuckles close first, all joints hold through contact, and each prop releases on time", () => {
  const nearPickup = STALL_PICKUP_S - 0.12;
  expect(stallFingerWeight("stall-water", nearPickup, 2, 0)).toBeGreaterThan(stallFingerWeight("stall-water", nearPickup, 2, 2));
  expect(stallFingerWeight("stall-water", nearPickup, 2, 0)).toBeGreaterThan(stallFingerWeight("stall-water", nearPickup, 0, 0));
  for (let finger = 0; finger < 5; finger++) for (let joint = 0; joint < 3; joint++) {
    expect(stallFingerWeight("stall-apple", 0, finger, joint)).toBe(0);
    expect(stallFingerWeight("stall-apple", STALL_MOUTH_S, finger, joint)).toBe(1);
    expect(stallFingerWeight("stall-apple", STALL_MOUTH_S + 0.4, finger, joint)).toBe(0);
    expect(stallFingerWeight("stall-water", STALL_RETURN_S, finger, joint)).toBe(1);
    expect(stallFingerWeight("stall-water", STALL_RETURN_S + 0.3, finger, joint)).toBe(0);
  }
});

test.each(["eve", "cipher", "remy"] as const)("%s palm and digits fit both held props", async (id) => {
  const body = BODIES[id];
  const { scene, animations } = await load(assetUrl(body.url));
  scene.scale.setScalar(body.scale);
  const hand = scene.getObjectByName("mixamorigRightHand")!;
  const pose = makeStallHandGrip(scene, animations, id, body.clips.idle)!;
  expect(pose).toBeTypeOf("function");
  const mixer = new AnimationMixer(scene);
  mixer.clipAction(animations.find((clip) => clip.name === body.clips.idle)!).play();

  for (const prop of ["stall-apple", "stall-water"] as const) {
    mixer.setTime(1.1);
    pose(prop, 1.2);
    scene.updateMatrixWorld(true);
    const center = hand.localToWorld(stallGripOffset(prop, id, hand.getWorldScale(new Vector3()).x, new Vector3()));
    const axis = stallBottleAxis(id)!.clone().transformDirection(hand.matrixWorld);
    const gaps: Record<string, number> = {};
    for (const [part, vertex] of handVertices(scene)) {
      vertex.sub(center);
      const y = vertex.dot(axis);
      const radius = y <= 0.036 ? 0.032 : Math.max(0.012, 0.032 - 0.57 * (y - 0.036));
      // Meter-scale sphere/cylinder bounds for the apple and tapered bottle.
      const gap = prop === "stall-apple" ? vertex.length() - 0.03625
        : Math.max(vertex.addScaledVector(axis, -y).length() - radius, -0.10 - y, y - 0.11);
      gaps[part] = Math.min(gaps[part] ?? Infinity, gap);
    }
    expect(Object.keys(gaps)).toHaveLength(6);
    for (const [part, gap] of Object.entries(gaps)) {
      expect(gap, `${prop} ${part} penetration`).toBeGreaterThan(-0.006);
      expect(gap, `${prop} ${part} clearance`).toBeLessThan(0.01);
    }
  }
});
