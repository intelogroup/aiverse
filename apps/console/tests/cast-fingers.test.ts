// @vitest-environment node
import { readFileSync } from "node:fs";
import { AnimationMixer, LoopOnce, SkinnedMesh, Texture } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { expect, it } from "vitest";

it.each(["remy", "cipher", "eve"])("%s binds its face and neck and plays the Texting finger bake", async (name) => {
  const file = readFileSync(new URL(`../public/assets/cast-${name}.glb`, import.meta.url));
  const bytes = Uint8Array.from(file).buffer;
  const loader = new GLTFLoader();
  // Exercise Three's real skin/animation binding with no browser JPEG decoder.
  loader.register(() => ({ name: "test-textures", loadTexture: async () => new Texture() }));
  const { scene, animations } = await loader.parseAsync(bytes, "");
  const clip = animations.find((clip) => clip.name === "Texting");
  if (!clip) throw new Error("Missing Texting clip");
  const mixer = new AnimationMixer(scene);
  mixer.clipAction(clip).setLoop(LoopOnce, 1).play();
  const skins = scene.getObjectsByProperty("isSkinnedMesh", true)
    .filter((object): object is SkinnedMesh => object instanceof SkinnedMesh);

  for (const [joint, parent] of [
    ["Neck1", "Neck"], ["Head", "Neck1"], ["Jaw", "Head"],
    ["LeftEye", "Head"], ["RightEye", "Head"],
  ]) {
    const bone = scene.getObjectByName(`mixamorig${joint}`);
    expect(bone?.parent?.name).toBe(`mixamorig${parent}`);
    expect(skins.some((skin) => skin.skeleton.bones.some((candidate) => candidate === bone))).toBe(true);
  }

  for (const side of ["Left", "Right"]) {
    const bone = scene.getObjectByName(`mixamorig${side}HandPinky2`);
    if (!bone) throw new Error(`Missing ${side} pinky bone`);
    expect(skins.some((skin) => skin.skeleton.bones.some((joint) => joint === bone))).toBe(true);
    mixer.setTime(0);
    const start = bone.quaternion.clone();
    mixer.setTime(clip.duration * 0.5);
    expect(bone.quaternion.angleTo(start)).toBeGreaterThan(0.2);
    mixer.setTime(clip.duration * 0.999);
    expect(bone.quaternion.angleTo(start)).toBeLessThan(0.01);
  }
});
