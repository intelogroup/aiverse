import { expect, test } from "bun:test";
import { Mesh, MeshStandardMaterial, SpotLight, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CarView, RIM_RADIUS, RIM_TUBE } from "./car";
import { DriverView } from "./render";
import { DrivingSimulation } from "./simulation";

// Load the same geometry, skeleton and clips as the browser without decoding textures in Bun.
async function untextured(path: string) {
  const source = Buffer.from(await Bun.file(new URL(path, import.meta.url)).arrayBuffer());
  const jsonSize = source.readUInt32LE(12);
  const gltf = JSON.parse(source.subarray(20, 20 + jsonSize).toString());
  gltf.materials = gltf.materials.map(({ name }: { name?: string }) => ({ name }));
  delete gltf.textures;
  delete gltf.images;
  delete gltf.extensionsRequired;
  const json = Buffer.from(JSON.stringify(gltf));
  const padded = Math.ceil(json.length / 4) * 4;
  const file = new ArrayBuffer(source.length - jsonSize + padded);
  const glb = Buffer.from(file);
  source.copy(glb, 0, 0, 20);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(padded, 12);
  glb.fill(32, 20, 20 + padded);
  json.copy(glb, 20);
  source.copy(glb, 20 + padded, 20 + jsonSize);
  return new GLTFLoader().parseAsync(file, "");
}

test("the model's front tires steer around a shared rear axle turn center", async () => {
  const { scene } = await untextured("./assets/car-concept.glb");
  const car = new CarView(scene, true);
  const left = car.root.getObjectByName("SteerFrontL")!;
  const right = car.root.getObjectByName("SteerFrontR")!;
  const rear = car.root.getObjectByName("SteerRearR")!;
  const rearRoll = car.root.getObjectByName("RollRearR")!;
  const wheelbase = left.position.z - rear.position.z;
  expect(wheelbase).toBeCloseTo(2.8, 2);
  car.update(0, 0, 0, 0.45, 0.8, 0, false);
  expect(left.rotation.y).toBeGreaterThan(0.45);
  expect(right.rotation.y).toBeLessThan(0.45);
  expect(left.position.x + wheelbase / Math.tan(left.rotation.y)).toBeCloseTo(right.position.x + wheelbase / Math.tan(right.rotation.y), 2);
  car.update(0, 0, 0, -0.45, -0.8, 0, false);
  expect(right.rotation.y).toBeLessThan(-0.45);
  expect(left.rotation.y).toBeGreaterThan(-0.45);
  expect(rear.rotation.y).toBe(0);
  expect(rearRoll.rotation.x).toBe(-0.8);
  car.update(0, 0, 0, 0, 0, 0, true);
  expect(left.rotation.y).toBe(0);
  expect(right.rotation.y).toBe(0);
});

test("the original lamp meshes, low cutoff, high beam and brake lamps respond independently", async () => {
  const { scene } = await untextured("./assets/car-concept.glb");
  const car = new CarView(scene, true);
  const left = car.root.getObjectByName("Left headlight beam") as SpotLight;
  const right = car.root.getObjectByName("Right headlight beam") as SpotLight;
  const head = (scene.getObjectByName("BodyHeadlights") as Mesh).material as MeshStandardMaterial;
  const rear = (scene.getObjectByName("BodyTaillights") as Mesh).material as MeshStandardMaterial;
  expect(left.position.x).toBeGreaterThan(right.position.x);
  expect(left.visible).toBe(false);
  expect(right.visible).toBe(false);
  expect(rear.emissiveIntensity).toBe(0);
  car.update(0, 0, 0, 0, 0, 0, false, "low");
  const low = { brightness: left.intensity, range: left.distance, target: left.target.position.clone(), tail: rear.emissiveIntensity };
  expect(left.visible && right.visible).toBe(true);
  expect(left.map).not.toBeNull();
  expect(head.emissiveIntensity).toBeGreaterThan(0);
  car.update(0, 0, 0, 0, 0, 0, false, "high");
  expect(left.map).toBeNull();
  expect(left.intensity).toBeGreaterThan(low.brightness);
  expect(left.distance).toBeGreaterThan(low.range * 3);
  expect(left.target.position.y).toBeGreaterThan(low.target.y);
  expect(rear.emissiveIntensity).toBe(low.tail);
  car.update(0, 0, 0, 0, 0, 0, true, "off");
  expect(rear.emissive.r).toBeGreaterThan(rear.emissive.g);
  expect(rear.toneMapped).toBe(false);
  expect(rear.emissiveIntensity).toBeGreaterThan(low.tail);
  expect(left.visible || right.visible).toBe(false);
  expect(head.emissiveIntensity).toBe(0);
});

test("Remy holds both sides of the actual rim from full left to full right", async () => {
  const [model, remy] = await Promise.all([
    untextured("./assets/car-concept.glb"),
    untextured("../../apps/console/public/assets/cast-remy-lite.glb"),
  ]);
  const car = new CarView(model.scene, true);
  const driver = new DriverView(remy, car);
  const state = new DrivingSimulation().snapshot();
  const getJoint = (name: string) => remy.scene.getObjectByName(`mixamorig${name}`)!;

  function pose(steering: number) {
    car.update(0, 0, 0, steering, 0, 0, false);
    driver.update({ ...state, x: 0, z: 0, phase: "driving", steering });
    return ["Left", "Right"].flatMap((side) => {
      const wrist = getJoint(`${side}Hand`);
      const middle = [1, 2, 3, 4].map((i) => getJoint(`${side}HandMiddle${i}`));
      return [wrist, ...middle].map((joint) => car.wheel.worldToLocal(joint.getWorldPosition(new Vector3())));
    });
  }

  const rest = pose(0);
  for (const [index, point] of rest.entries()) {
    if (index === 0 || index === 5) {
      expect(point.y).toBeGreaterThan(0.08);
    } else {
      const rimDistance = Math.hypot(Math.hypot(point.x, point.z) - RIM_RADIUS, point.y);
      expect(rimDistance).toBeGreaterThan(RIM_TUBE + 0.01);
      expect(rimDistance).toBeLessThan(RIM_TUBE + 0.018);
    }
  }
  for (const steering of [-0.58, -0.29, 0.29, 0.58]) {
    for (const [index, point] of pose(steering).entries()) {
      expect(point.distanceTo(rest[index])).toBeLessThan(0.002);
    }
  }
});
