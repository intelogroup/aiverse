// @vitest-environment node
import { readFileSync } from "node:fs";
import { Box3, Quaternion, Texture } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { expect, test } from "vitest";
import { SCALE_REMY } from "@aiverse/world-sim/bodies";
import { APPLE_GROUND, APPLE_STANDS, appleCenter, type AppleStand } from "@aiverse/world-sim/movableProps";
import { APPLE_HALF_HEIGHT, APPLE_SIZE } from "../src/features/world/appleGrip";

// RemoteApple's stand top must meet the (resized) apple's lowest point: no float, no sinking.
test.each(Object.keys(APPLE_STANDS) as AppleStand[])("%s top touches the apple's bottom", async (stand) => {
  const loader = new GLTFLoader();
  loader.register(() => ({ name: "t", loadTexture: async () => new Texture() }));
  const { scene } = await loader.parseAsync(Uint8Array.from(readFileSync(new URL("../public/assets/props/market-apple.glb", import.meta.url))).buffer, "");
  scene.scale.setScalar(SCALE_REMY * APPLE_SIZE);
  scene.position.set(...appleCenter(stand));
  scene.quaternion.copy(new Quaternion(...APPLE_STANDS[stand].rotation));
  scene.updateMatrixWorld(true);
  const bottom = new Box3().setFromObject(scene).min.y;
  const top = APPLE_GROUND + (APPLE_STANDS[stand].height - APPLE_HALF_HEIGHT * (APPLE_SIZE - 1)) * SCALE_REMY;
  expect(Math.abs(bottom - top)).toBeLessThan(0.002);
});
