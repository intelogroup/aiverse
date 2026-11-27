// @vitest-environment node
import { AnimationMixer, LoopOnce, Quaternion, SkinnedMesh, Vector3 } from "three";
import { expect, test } from "vitest";
import { agentBodies, BODIES, SCALE_REMY } from "@aiverse/world-sim/bodies";
import { APPLE_GRIPS, APPLE_STANDS, type AppleBody, type AppleStand } from "@aiverse/world-sim/movableProps";
import { APPLE_GRIP_ROTATION, APPLE_SIZE, appleGripOffset } from "../src/features/world/appleGrip";
import { assetUrl, CLIPS, handVertices, load } from "../scripts/fit-apple-grips";

// A new agent body must be fitted (bun scripts/fit-apple-grips.ts) before it ships.
test("every agent body has an apple fit", () => {
  expect(Object.keys(APPLE_GRIPS).sort()).toEqual(agentBodies().map((b) => b.id).sort());
});

// At each stand's contact frame, with the body's own grip:
// - the grip lands where APPLE_GRIPS (the sim's stance table) says, so the sim stance and the console grip agree;
// - palm and fingers sit on the apple's skin: none sinks in more than 6 mm, the palm is within 1.5 cm.
test.each(Object.keys(APPLE_GRIPS) as AppleBody[])("%s grip matches its stance and its fingers wrap the apple", async (id) => {
  const body = BODIES[id];
  const apple = (await load(assetUrl("/assets/props/market-apple.glb"))).scene;
  apple.scale.setScalar(SCALE_REMY * APPLE_SIZE);
  apple.updateMatrixWorld(true);
  const skin: Vector3[] = [];
  apple.traverse((o) => {
    if (!("isMesh" in o)) return;
    const p = (o as SkinnedMesh).geometry.attributes.position;
    for (let i = 0; i < p.count; i += 3) skin.push(new Vector3().fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld));
  });
  const { scene, animations } = await load(assetUrl(body.url));
  scene.scale.setScalar(body.scale);
  const hand = scene.getObjectByName("mixamorigRightHand")!;
  let mixer: AnimationMixer | undefined;
  for (const stand of Object.keys(APPLE_STANDS) as AppleStand[]) {
    mixer?.stopAllAction();
    mixer = new AnimationMixer(scene);
    mixer.clipAction(animations.find((a) => a.name === CLIPS[stand])!).setLoop(LoopOnce, 1).play();
    mixer.setTime(APPLE_STANDS[stand].contact);
    scene.updateMatrixWorld(true);
    const grip = hand.localToWorld(appleGripOffset(id, hand.getWorldScale(new Vector3()).x, new Vector3()));
    expect(grip.x / body.scale).toBeCloseTo(APPLE_GRIPS[id][stand][0], 3);
    expect(grip.z / body.scale).toBeCloseTo(APPLE_GRIPS[id][stand][1], 3);

    const turn = hand.getWorldQuaternion(new Quaternion()).multiply(new Quaternion(...APPLE_GRIP_ROTATION));
    const placed = skin.map((v) => v.clone().applyQuaternion(turn).add(grip));
    const gaps: Record<string, number> = {};
    for (const [part, v] of handVertices(scene)) {
      let near = placed[0], d = Infinity;
      for (const a of placed) { const da = a.distanceTo(v); if (da < d) { d = da; near = a; } }
      const gap = v.distanceTo(grip) < near.distanceTo(grip) ? -d : d;
      gaps[part] = Math.min(gaps[part] ?? Infinity, gap);
    }
    for (const [part, gap] of Object.entries(gaps)) expect(gap, `${stand} ${part}`).toBeGreaterThan(-0.006);
    expect(gaps.Palm, `${stand} palm`).toBeLessThan(0.015);
  }
}, 60000);
