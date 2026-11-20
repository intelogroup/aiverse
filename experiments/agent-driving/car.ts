import * as THREE from "three";
import { DRIVER, type HeadlightMode } from "./protocol";

const Y = new THREE.Vector3(0, 1, 0);

function part(root: THREE.Object3D, name: string) {
  const node = root.getObjectByName(name);
  if (!node) throw new Error(`Missing Car Concept part ${name}`);
  return node;
}

export const RIM_RADIUS = 0.157;
export const RIM_TUBE = 0.014;

// Positive model X is the driver's left. The two tire axes meet at the
// same point on the rear axle instead of pointing in parallel.
export function frontWheelAngle(centerSteering: number, wheelX: number) {
  const curvature = Math.tan(centerSteering) / DRIVER.wheelbase;
  return Math.atan2(DRIVER.wheelbase * curvature, 1 - wheelX * curvature);
}

function lowBeamCutoff() {
  const size = 32;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const level = Math.round(255 * Math.max(0, Math.min(1, (0.54 - y / (size - 1)) * 22)));
    for (let x = 0; x < size; x++) pixels.set([level, level, level, 255], (y * size + x) * 4);
  }
  const map = new THREE.DataTexture(pixels, size, size);
  map.minFilter = map.magFilter = THREE.LinearFilter;
  map.needsUpdate = true;
  return map;
}

const LOW_CUTOFF = lowBeamCutoff();

export class CarView {
  readonly root = new THREE.Group();
  readonly door = new THREE.Group();
  readonly wheel = new THREE.Group();
  readonly handle = new THREE.Object3D();
  private readonly wheelRest: THREE.Quaternion;
  private readonly windshield: THREE.Mesh | null;
  private readonly exteriorGlass: THREE.Material | THREE.Material[] | null;
  private readonly cockpitGlass: THREE.MeshPhysicalMaterial | null;
  private readonly tires: { steer: THREE.Group; roll: THREE.Group; front: boolean }[] = [];
  private readonly frontLamps: THREE.MeshStandardMaterial[] = [];
  private readonly rearLamps: THREE.MeshStandardMaterial[] = [];
  private readonly beams: THREE.SpotLight[] = [];
  private readonly rearGlow: THREE.PointLight | undefined;
  private beamMode: HeadlightMode | undefined;
  private readonly rotation = new THREE.Quaternion();

  constructor(scene: THREE.Object3D, main: boolean) {
    this.root.add(scene);
    this.root.updateMatrixWorld(true);

    const doorMesh = part(scene, "BodyDoorLColor1");
    const handleMesh = part(scene, "BodyDoorLHandle01");
    this.handle.position.copy(new THREE.Box3().setFromObject(handleMesh, true).getCenter(new THREE.Vector3()));
    this.root.add(this.handle, this.door, this.wheel);
    doorMesh.getWorldPosition(this.door.position);
    this.door.attach(doorMesh);
    this.door.attach(this.handle);

    // Centre and plane measured from the actual leather rim in the source mesh.
    this.wheel.position.set(0.001, 0.652, 0.933);
    this.wheel.rotation.x = -1.228;
    this.wheel.attach(part(scene, "InteriorSteeringCylinder"));
    // Set the telescoping column for Remy's arm length.
    this.wheel.position.add(new THREE.Vector3(0, 0.025, -0.071));
    this.wheelRest = this.wheel.quaternion.clone();

    for (const axle of ["Front", "Rear"]) {
      const front = axle === "Front";
      for (const side of ["L", "R"]) {
        const original = part(scene, `Wheel${axle}${side}`);
        const steer = new THREE.Group();
        const roll = new THREE.Group();
        const tireAlignment = new THREE.Group();
        const caliperAlignment = new THREE.Group();
        original.getWorldPosition(steer.position);
        steer.name = `Steer${axle}${side}`;
        roll.name = `Roll${axle}${side}`;
        this.root.add(steer);
        steer.add(roll, caliperAlignment);
        roll.add(tireAlignment);
        for (const child of [...original.children]) {
          const attachment = child.name.endsWith("BrakePad") ? caliperAlignment : tireAlignment;
          attachment.attach(child);
        }
        // The source front tires are posed 30 degrees to the right.
        if (front) tireAlignment.rotation.y = caliperAlignment.rotation.y = Math.PI / 6;
        this.tires.push({ steer, roll, front });
      }
    }

    const glass = part(scene, "BodyWindshield");
    this.windshield = main && glass instanceof THREE.Mesh ? glass : null;
    this.exteriorGlass = this.windshield?.material ?? null;
    this.cockpitGlass = this.exteriorGlass instanceof THREE.MeshPhysicalMaterial ? this.exteriorGlass.clone() : null;
    if (this.cockpitGlass) {
      this.cockpitGlass.ior = 1.08;
      this.cockpitGlass.roughness = 0.015;
      this.cockpitGlass.color.setRGB(0.96, 0.98, 0.99);
      this.cockpitGlass.envMapIntensity = 0.1;
    }

    if (main) {
      this.root.updateMatrixWorld(true);
      const fronts = new THREE.Box3().setFromObject(part(scene, "BodyHeadlights"), true);
      const center = fronts.getCenter(new THREE.Vector3());
      const spread = (fronts.max.x - fronts.min.x) * 0.34;
      for (const side of [-1, 1]) {
        const beam = new THREE.SpotLight(0xf0f5ff, 0, 31, 0.43, 0.38, 2);
        beam.name = side > 0 ? "Left headlight beam" : "Right headlight beam";
        beam.position.set(center.x + side * spread, center.y, fronts.max.z + 0.1);
        this.root.add(beam, beam.target);
        this.beams.push(beam);
      }
      const rear = new THREE.Box3().setFromObject(part(scene, "BodyTaillights"), true);
      this.rearGlow = new THREE.PointLight(0xff1014, 0, 4, 2);
      this.rearGlow.name = "Rear lamp reflection";
      this.rearGlow.position.set(0, 0.34, rear.min.z - 0.18);
      this.root.add(this.rearGlow);
    }

    this.root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      const replacements = materials.map((material: THREE.Material) => {
        if (material instanceof THREE.MeshStandardMaterial) {
          if (material.name === "Headlight" || material.name === "Brakelight") {
            const lamp = material.clone();
            const front = material.name === "Headlight";
            lamp.emissive.setHex(front ? 0xe9f2ff : 0xff080d);
            // Keep the red lens saturated when the stop lamps reach full brightness.
            lamp.toneMapped = front;
            (front ? this.frontLamps : this.rearLamps).push(lamp);
            return lamp;
          }
          if (material.name === "Signallight") {
            const lamp = material.clone();
            lamp.emissiveIntensity = 0;
            return lamp;
          }
        }
        if (!main && material instanceof THREE.MeshPhysicalMaterial && material.transmission > 0) {
          return new THREE.MeshStandardMaterial({ color: 0x29343a, metalness: 0.47, roughness: 0.2 });
        }
        return material;
      });
      node.material = Array.isArray(node.material) ? replacements : replacements[0];
      node.castShadow = !materials.some((material: THREE.Material) => material.name === "Glass");
    });
    this.updateLights("off", false);
  }

  setCockpit(inside: boolean) {
    if (this.windshield && this.cockpitGlass && this.exteriorGlass) {
      this.windshield.material = inside ? this.cockpitGlass : this.exteriorGlass;
    }
  }

  update(x: number, z: number, heading: number, steering: number, roll: number, door: number, braking: boolean, headlights: HeadlightMode = "off") {
    this.root.position.set(x, 0, z);
    this.root.rotation.y = heading;
    this.door.rotation.set(-door * 0.91, door * 0.42, 0, "YXZ");
    for (const { steer, roll: tire, front } of this.tires) {
      if (front) steer.rotation.y = frontWheelAngle(steering, steer.position.x);
      tire.rotation.x = roll;
    }
    this.wheel.quaternion.copy(this.wheelRest).multiply(this.rotation.setFromAxisAngle(Y, steering * DRIVER.steeringWheelRatio));
    this.updateLights(headlights, braking);
  }

  private updateLights(mode: HeadlightMode, braking: boolean) {
    if (mode !== this.beamMode) {
      this.beamMode = mode;
      const high = mode === "high";
      for (const lamp of this.frontLamps) lamp.emissiveIntensity = mode === "off" ? 0 : high ? 7 : 3.5;
      for (const beam of this.beams) {
        beam.visible = mode !== "off";
        beam.intensity = high ? 620 : 145;
        beam.distance = high ? 106 : 31;
        beam.angle = high ? 0.27 : 0.43;
        beam.map = high ? null : LOW_CUTOFF;
        beam.target.position.set(beam.position.x * 1.07, high ? 0.23 : -0.29, beam.position.z + (high ? 43 : 17));
      }
    }
    const red = braking ? 1.35 : mode === "off" ? 0 : 0.22;
    for (const lamp of this.rearLamps) lamp.emissiveIntensity = red;
    if (this.rearGlow) this.rearGlow.intensity = braking ? 3.2 : mode === "off" ? 0 : 0.22;
  }
}
