// @vitest-environment node
import { readFileSync } from "node:fs";
import { Texture, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { expect, test } from "vitest";
import { BODY_CIPHER, BODY_EVE, BODY_REMY } from "@aiverse/world-sim/bodies";
import { APPLE_GRIP_POSITION, REMY_HAND_WORLD_SCALE } from "../src/features/world/appleGrip";

// The apple sits the same distance from the wrist on every measured body, whatever the rig's hand units.
test.each([BODY_REMY, BODY_EVE, BODY_CIPHER])("$id grip lands 0.137 m from the wrist", async (body) => {
  const file = readFileSync(new URL(`../public/assets/cast-${body.id}.glb`, import.meta.url));
  const loader = new GLTFLoader();
  loader.register(() => ({ name: "t", loadTexture: async () => new Texture() }));
  const { scene } = await loader.parseAsync(Uint8Array.from(file).buffer, "");
  scene.scale.setScalar(body.scale);
  scene.updateMatrixWorld(true);
  const hand = scene.getObjectByName("mixamorigRightHand")!;
  const scale = REMY_HAND_WORLD_SCALE / hand.getWorldScale(new Vector3()).x;
  const grip = hand.localToWorld(new Vector3(...APPLE_GRIP_POSITION).multiplyScalar(scale));
  expect(grip.distanceTo(hand.getWorldPosition(new Vector3()))).toBeCloseTo(0.1369, 2);
}, 60000);
