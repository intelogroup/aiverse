// @vitest-environment node
import { readFileSync } from "node:fs";
import { AnimationMixer, Box3, LoopOnce, Matrix4, Texture, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { expect, it } from "vitest";

const prototypeDir = new URL(
  "../../../tools/city3/interaction-prototypes/cipher-casting-focus/",
  import.meta.url,
);

it("matches the Blender glove mount throughout Cipher's CastSpell", async () => {
  const calibration = JSON.parse(readFileSync(new URL("calibration.json", prototypeDir), "utf8")) as {
    clip: string;
    durationSeconds: number;
    propFile: string;
    propSizeMeters: [number, number, number];
    socket: string;
    socketFromProp: number[];
    blenderReference: Array<{ time: number; worldFromProp: number[] }>;
  };
  const loader = new GLTFLoader();
  // Geometry and skeletal motion do not require decoding cast textures in Node.
  loader.register(() => ({ name: "test-textures", loadTexture: async () => new Texture() }));
  const cast = await loader.parseAsync(Uint8Array.from(readFileSync(
    new URL("../public/assets/cast-cipher.glb", import.meta.url),
  )).buffer, "");
  const prop = await loader.parseAsync(Uint8Array.from(readFileSync(
    new URL(calibration.propFile, prototypeDir),
  )).buffer, "");

  const bounds = new Box3().setFromObject(prop.scene);
  expect(bounds.getSize(new Vector3()).distanceTo(new Vector3(...calibration.propSizeMeters)))
    .toBeLessThan(0.0001);
  expect(prop.animations).toHaveLength(0);

  const socket = cast.scene.getObjectByName(calibration.socket);
  const clip = cast.animations.find(({ name }) => name === calibration.clip);
  if (!socket || !clip) throw new Error("Cipher's CastSpell clip or wrist socket is missing");
  expect(clip.duration).toBeCloseTo(calibration.durationSeconds, 3);
  socket.add(prop.scene);
  prop.scene.matrixAutoUpdate = false;
  prop.scene.matrix.fromArray(calibration.socketFromProp);
  const mixer = new AnimationMixer(cast.scene);
  mixer.clipAction(clip).setLoop(LoopOnce, 1).play();

  const checkpoints = [
    new Vector3(), bounds.min, bounds.max,
    new Vector3(bounds.max.x, bounds.min.y, bounds.max.z),
  ];
  for (const { time, worldFromProp } of calibration.blenderReference) {
    mixer.setTime(time);
    cast.scene.updateMatrixWorld(true);
    const reference = new Matrix4().fromArray(worldFromProp);
    for (const point of checkpoints) {
      const actual = point.clone().applyMatrix4(prop.scene.matrixWorld);
      const expected = point.clone().applyMatrix4(reference);
      expect(actual.distanceTo(expected), `wrist mount at ${time}s`).toBeLessThan(0.001);
    }
  }
});
