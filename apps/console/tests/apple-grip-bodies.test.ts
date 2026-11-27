// @vitest-environment node
import { readFileSync } from "node:fs";
import { AnimationMixer, LoopOnce, Quaternion, SkinnedMesh, Texture, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { expect, test } from "vitest";
import { BODY_CIPHER, BODY_EVE, BODY_REMY, SCALE_REMY } from "@aiverse/world-sim/bodies";
import { APPLE_GRIPS, APPLE_STANDS, type AppleBody, type AppleStand } from "@aiverse/world-sim/movableProps";
import { APPLE_GRIP_ROTATION, APPLE_SIZE, appleGripOffset } from "../src/features/world/appleGrip";

const load = async (url: URL) => {
  const loader = new GLTFLoader();
  loader.register(() => ({ name: "t", loadTexture: async () => new Texture() }));
  return loader.parseAsync(Uint8Array.from(readFileSync(url)).buffer, "");
};
const CLIPS: Record<AppleStand, string> = { "apple-stand-01": "PickUp", "apple-stand-02": "PuttingDown" };

// At each stand's contact frame, with the body's own grip:
// - the grip lands where APPLE_GRIPS (the sim's stance table) says, so the sim stance and the console grip agree;
// - palm and fingers sit on the apple's skin: none sinks in more than 6 mm, the palm is within 1.5 cm.
test.each([BODY_REMY, BODY_EVE, BODY_CIPHER])("$id grip matches its stance and its fingers wrap the apple", async (body) => {
  const id = body.id as AppleBody;
  const apple = (await load(new URL("../public/assets/props/market-apple.glb", import.meta.url))).scene;
  apple.scale.setScalar(SCALE_REMY * APPLE_SIZE);
  apple.updateMatrixWorld(true);
  const skin: Vector3[] = [];
  apple.traverse((o) => {
    if (!("isMesh" in o)) return;
    const p = (o as SkinnedMesh).geometry.attributes.position;
    for (let i = 0; i < p.count; i += 3) skin.push(new Vector3().fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld));
  });
  const { scene, animations } = await load(new URL(`../public/assets/cast-${id}.glb`, import.meta.url));
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
    scene.traverse((o) => {
      if (!(o instanceof SkinnedMesh)) return;
      o.skeleton.update();
      const { position, skinIndex, skinWeight } = o.geometry.attributes;
      for (let i = 0; i < position.count; i++) {
        let bone = 0;
        for (let k = 1; k < 4; k++) if (skinWeight.getComponent(i, k) > skinWeight.getComponent(i, bone)) bone = k;
        const part = /^mixamorigRightHand(Thumb|Index|Middle|Ring|Pinky)?\d?$/.exec(o.skeleton.bones[skinIndex.getComponent(i, bone)]?.name ?? "");
        if (!part) continue;
        const v = o.applyBoneTransform(i, new Vector3().fromBufferAttribute(position, i)).applyMatrix4(o.matrixWorld);
        let near = placed[0], d = Infinity;
        for (const a of placed) { const da = a.distanceTo(v); if (da < d) { d = da; near = a; } }
        const gap = v.distanceTo(grip) < near.distanceTo(grip) ? -d : d;
        const key = part[1] ?? "Palm";
        gaps[key] = Math.min(gaps[key] ?? Infinity, gap);
      }
    });
    for (const [part, gap] of Object.entries(gaps)) expect(gap, `${stand} ${part}`).toBeGreaterThan(-0.006);
    expect(gaps.Palm, `${stand} palm`).toBeLessThan(0.015);
  }
}, 60000);
