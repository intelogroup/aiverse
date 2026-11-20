import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { buildCourse } from "./course";
import { DRIVER, type CameraView, type DriveState } from "./protocol";

import { CarView } from "./car";
import { SteeringGrip } from "./steeringGrip";

const AXLE = new THREE.Vector3(1, 0, 0);
const { lerp, smoothstep } = THREE.MathUtils;

// Resolve an articulated limb against a world-space contact point, preserving its animated bend plane.
class Limb {
  private readonly shoulder = new THREE.Vector3();
  private readonly elbow = new THREE.Vector3();
  private readonly hand = new THREE.Vector3();
  private readonly targetDir = new THREE.Vector3();
  private readonly bend = new THREE.Vector3();
  private readonly nextElbow = new THREE.Vector3();
  private readonly current = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly inverse = new THREE.Quaternion();
  private readonly delta = new THREE.Quaternion();

  constructor(private upper: THREE.Object3D, private lower: THREE.Object3D, private end: THREE.Object3D) {}

  private align(joint: THREE.Object3D, current: THREE.Vector3, desired: THREE.Vector3) {
    joint.parent!.getWorldQuaternion(this.inverse).invert();
    current.normalize().applyQuaternion(this.inverse);
    desired.normalize().applyQuaternion(this.inverse);
    joint.quaternion.premultiply(this.delta.setFromUnitVectors(current, desired));
    joint.updateWorldMatrix(false, true);
  }

  reach(target: THREE.Vector3, weight = 1) {
    this.upper.getWorldPosition(this.shoulder);
    this.lower.getWorldPosition(this.elbow);
    this.end.getWorldPosition(this.hand);
    this.hand.lerp(target, weight);
    const upperLength = this.shoulder.distanceTo(this.elbow);
    const lowerLength = this.lower.getWorldPosition(this.current).distanceTo(this.end.getWorldPosition(this.desired));
    const distance = THREE.MathUtils.clamp(this.targetDir.subVectors(this.hand, this.shoulder).length(),
      Math.abs(upperLength - lowerLength) + 0.001, upperLength + lowerLength - 0.001);
    this.targetDir.normalize();
    this.bend.subVectors(this.elbow, this.shoulder);
    this.bend.addScaledVector(this.targetDir, -this.bend.dot(this.targetDir)).normalize();
    const along = (upperLength ** 2 - lowerLength ** 2 + distance ** 2) / (2 * distance);
    const height = Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2));
    this.nextElbow.copy(this.shoulder).addScaledVector(this.targetDir, along).addScaledVector(this.bend, height);
    this.align(this.upper, this.current.subVectors(this.elbow, this.shoulder),
      this.desired.subVectors(this.nextElbow, this.shoulder));
    this.lower.getWorldPosition(this.elbow);
    this.align(this.lower, this.end.getWorldPosition(this.current).sub(this.elbow), this.desired.subVectors(this.hand, this.elbow));
  }
}

export class DriverView {
  private readonly body = new THREE.Group();
  private readonly hips: THREE.Object3D;
  private readonly leftEye: THREE.Object3D;
  private readonly rightEye: THREE.Object3D;
  private readonly leftArm: Limb;
  private readonly rightArm: Limb;
  private readonly rightLeg: Limb;
  private readonly leftGrip: SteeringGrip;
  private readonly rightGrip: SteeringGrip;
  private readonly mixer: THREE.AnimationMixer;
  private readonly enter: THREE.AnimationAction;
  private readonly exit: THREE.AnimationAction;
  private readonly idle: THREE.AnimationAction;
  private readonly hipAt = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly eye = new THREE.Vector3();
  private playing: THREE.AnimationAction | null = null;
  private gear = 0;

  constructor(gltf: GLTF, private readonly car: CarView) {
    const { scene } = gltf;
    const bone = (name: string) => {
      const node = scene.getObjectByProperty("name", `mixamorig${name}`) ??
        scene.getObjectByProperty("name", `mixamorig:${name}`);
      if (!node) throw new Error(`Missing Remy bone ${name}`);
      return node;
    };
    this.hips = bone("Hips");
    this.leftEye = bone("LeftEye");
    this.rightEye = bone("RightEye");
    this.leftArm = new Limb(bone("LeftArm"), bone("LeftForeArm"), bone("LeftHand"));
    this.rightArm = new Limb(bone("RightArm"), bone("RightForeArm"), bone("RightHand"));
    this.leftGrip = new SteeringGrip("Left", bone);
    this.rightGrip = new SteeringGrip("Right", bone);
    this.rightLeg = new Limb(bone("RightUpLeg"), bone("RightLeg"), bone("RightFoot"));
    this.body.add(scene);
    this.body.scale.setScalar(1.07);
    car.root.add(this.body);
    scene.traverse((node) => {
      if (!(node instanceof THREE.SkinnedMesh)) return;
      node.frustumCulled = false;
      node.castShadow = true;
    });
    this.mixer = new THREE.AnimationMixer(scene);
    const clip = (name: string) => {
      const animation = THREE.AnimationClip.findByName(gltf.animations, name);
      if (!animation) throw new Error(`Missing Remy clip ${name}`);
      return this.mixer.clipAction(animation);
    };
    this.enter = clip("EnterCar");
    this.exit = clip("ExitCar");
    this.idle = clip("Idle");
  }

  update(state: DriveState) {
    const { phase, phaseProgress: t } = state;
    const seated = phase === "driving";
    const exiting = phase === "exiting";
    const action = phase === "outside" ? this.idle : exiting ? this.exit : this.enter;
    if (action !== this.playing) {
      this.playing?.stop();
      action.reset().play();
      this.playing = action;
    }
    const duration = action.getClip().duration;
    action.time = seated ? duration - 0.001 : phase === "outside" ? state.time % duration : t * (duration - 0.001);
    this.mixer.update(0);

    const mount = seated ? 1 : exiting ? 1 - smoothstep(t, 0.28, 0.63) : smoothstep(t, 0.40, 0.78);
    const standYaw = exiting ? 0 : -Math.PI / 2;
    this.body.rotation.set(0, standYaw, seated ? state.steering * -0.065 : 0);
    this.body.rotateOnWorldAxis(AXLE, mount * 0.095);
    this.body.position.set(0, 0, 0);
    this.hips.getWorldPosition(this.hipAt);
    this.car.root.worldToLocal(this.hipAt);
    const [x, y, z] = DRIVER.seat;
    this.body.position.set(lerp(1.39, x, mount), lerp(0.768, y, mount), lerp(-0.42, z, mount)).sub(this.hipAt);
    this.body.updateWorldMatrix(true, true);

    if (phase === "entering" && t >= 0.06 && t <= 0.39) {
      const hold = smoothstep(t, 0.06, 0.16) * (1 - smoothstep(t, 0.27, 0.39));
      this.leftArm.reach(this.car.handle.getWorldPosition(this.target), hold * 0.8);
    }
    if (seated || phase === "entering" && t > 0.89) {
      const hold = seated ? 1 : smoothstep(t, 0.89, 1);
      this.leftArm.reach(this.leftGrip.wristTarget(this.car.wheel), hold);
      this.leftGrip.pose(this.car.wheel, hold);
      this.rightArm.reach(this.rightGrip.wristTarget(this.car.wheel), hold);
      this.rightGrip.pose(this.car.wheel, hold);
    }
    if (seated) {
      this.gear = lerp(this.gear, state.braking ? -1 : state.throttle, 0.19);
      if (Math.abs(this.gear) > 0.01) {
        this.rightLeg.reach(this.car.root.localToWorld(this.target.set(
          lerp(-0.09, 0.02, smoothstep(-this.gear, 0, 1)), 0.16, 1.02 + this.gear * 0.065,
        )), Math.abs(this.gear) * 0.72);
      }
    } else {
      this.gear = 0;
    }
  }

  eyePosition(target: THREE.Vector3) {
    this.leftEye.getWorldPosition(this.eye);
    this.rightEye.getWorldPosition(target).lerp(this.eye, 0.5);
    this.car.root.getWorldQuaternion(this.carRotation);
    return target.add(this.offset.set(0, 0.022, 0.043).applyQuaternion(this.carRotation));
  }

  private readonly carRotation = new THREE.Quaternion();
}

export async function createRenderer(viewport: HTMLElement, night = false) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.22;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  viewport.replaceChildren(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(night ? 0x0b1425 : 0xb4beb2, night ? 0.0028 : 0.0082);
  const camera = new THREE.PerspectiveCamera(41, 1, 0.055, 280);
  const resize = () => {
    const { clientWidth, clientHeight } = viewport;
    renderer.setSize(clientWidth, clientHeight, false);
    camera.aspect = clientWidth / Math.max(1, clientHeight);
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(viewport);
  resize();

  const sun = new THREE.DirectionalLight(night ? 0x9ab6ff : 0xffead2, night ? 0.14 : 2.15);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -14;
  sun.shadow.camera.right = sun.shadow.camera.top = 14;
  sun.shadow.camera.near = 0.3;
  sun.shadow.camera.far = 46;
  sun.shadow.normalBias = 0.035;
  const course = buildCourse();
  scene.add(sun, sun.target, new THREE.HemisphereLight(0xd5e6f5, 0x8a826e, night ? 0.10 : 1.18), course.root);

  const basis = new KTX2Loader().setTranscoderPath("/basis/").detectSupport(renderer);
  const loader = new GLTFLoader().setKTX2Loader(basis).setMeshoptDecoder(MeshoptDecoder);
  const [concept, remy, sky] = await Promise.all([
    loader.loadAsync("/assets/car-concept.glb"),
    loader.loadAsync("/assets/remy.glb"),
    new RGBELoader().loadAsync("/assets/sky.hdr"),
  ]);
  basis.dispose();
  sky.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = sky;
  scene.background = night ? new THREE.Color(0x0b1425) : sky;
  scene.environmentIntensity = night ? 0.13 : 0.95;
  scene.backgroundIntensity = 0.68;
  scene.backgroundBlurriness = 0.05;

  const traffic = new CarView(concept.scene.clone(true), false);
  const car = new CarView(concept.scene, true);
  const driver = new DriverView(remy, car);
  scene.add(traffic.root, car.root);
  const pedestrian = new THREE.Group();
  const coat = new THREE.MeshStandardMaterial({ color: 0xd67c24, roughness: 0.85 });
  const jeans = new THREE.MeshStandardMaterial({ color: 0x213646, roughness: 0.88 });
  const skin = new THREE.MeshStandardMaterial({ color: 0x986448, roughness: 0.8 });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.21, 0.37, 6, 10), coat);
  torso.position.y = 1.22;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.139, 12, 10), skin);
  head.position.y = 1.72;
  pedestrian.add(torso, head);
  const limbs = [-1, 1].map((side) => {
    const leg = new THREE.Group();
    const arm = new THREE.Group();
    leg.position.set(side * 0.105, 0.86, 0);
    arm.position.set(side * 0.245, 1.43, 0);
    const pants = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.64, 5, 8), jeans);
    const sleeve = new THREE.Mesh(new THREE.CapsuleGeometry(0.061, 0.43, 5, 8), coat);
    pants.position.y = -0.38;
    sleeve.position.y = -0.23;
    leg.add(pants);
    arm.add(sleeve);
    pedestrian.add(leg, arm);
    return { leg, arm };
  });
  pedestrian.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; });
  scene.add(pedestrian);

  const focus = new THREE.Vector3();
  const intended = new THREE.Vector3();
  const ahead = new THREE.Vector3();
  let cockpitLast: boolean | null = null;
  let followBlend = 0;

  return {
    canvas: renderer.domElement,
    frame(state: DriveState, cockpit: boolean, dt: number, follow = false, gaze?: CameraView) {
      course.update(state.lesson);
      car.update(state.x, state.z, state.heading, state.steering, state.wheelRoll, state.door, state.braking, state.headlights);
      const actor = state.lesson?.actor;
      const vehicle = state.lesson?.oncoming ?? (actor?.kind === "vehicle" ? actor : undefined);
      if (vehicle) {
        traffic.update(vehicle.x, vehicle.z, vehicle.heading, 0, vehicle.z / DRIVER.wheelRadius, 0, state.action !== "wait", night ? "low" : "off");
      } else {
        traffic.update(state.traffic.x, state.traffic.z, Math.PI / 2, 0, state.traffic.wheelRoll, 0, false, night ? "low" : "off");
      }
      traffic.root.visible = state.lesson ? Boolean(vehicle) : state.traffic.visible;
      pedestrian.visible = actor?.kind === "pedestrian";
      if (actor?.kind === "pedestrian") {
        pedestrian.position.set(actor.x, 0, actor.z);
        pedestrian.rotation.y = actor.heading;
        limbs.forEach(({ leg, arm }, i) => {
          leg.rotation.x = Math.sin(actor.z * 5 + i * Math.PI) * 0.45;
          arm.rotation.x = -leg.rotation.x * 0.65;
        });
      }
      driver.update(state);
      sun.target.position.set(state.x, 0, state.z);
      sun.position.set(state.x + 11, 17, state.z - 9);
      car.root.localToWorld(focus.set(0.22, 0.72, 0.3));
      if (cockpit) {
        driver.eyePosition(intended);
        const road = gaze === "road";
        const detail = gaze === "right_detail";
        const side = gaze === "left" ? 1 : gaze === "right" || detail ? -1 : 0;
        const yaw = state.heading + side * (detail ? 0.77 : 0.62);
        if (side || road) {
          intended.y += road ? 0.30 : 0.14;
          intended.x += Math.sin(state.heading) * (road ? 0.32 : 0.15);
          intended.z += Math.cos(state.heading) * (road ? 0.32 : 0.15);
        }
        ahead.set(Math.sin(yaw), road ? -0.35 : side ? -0.24 : gaze === "signal_detail" ? 0.05 : gaze ? -0.09 : -0.44, Math.cos(yaw));
        camera.position.copy(intended);
        camera.lookAt(focus.copy(intended).add(ahead));
      } else if (follow) {
        const length = DRIVER.halfLength * 2;
        const previousBlend = followBlend;
        const tracking = state.phase === "driving" || state.phase === "exiting";
        followBlend = THREE.MathUtils.clamp(followBlend + dt * (tracking ? 0.52 : -0.52), 0, 1);
        const blend = smoothstep(followBlend, 0, 1);
        car.root.localToWorld(intended.set(
          lerp(5.6, length * 0.91, blend),
          lerp(2.23, length * 0.82, blend),
          lerp(4.4, -length * 1.54, blend),
        ));
        car.root.localToWorld(focus.set(0.22, lerp(0.72, 0.95, blend), lerp(0.3, length * 0.42, blend)));
        const handoff = previousBlend !== followBlend;
        const blendPosition = cockpitLast !== false || handoff ? 1 : 1 - Math.exp(-6.2 * dt);
        camera.position.lerp(intended, blendPosition);
        camera.lookAt(focus);
      } else {
        car.root.localToWorld(intended.set(5.6, 2.23, 4.4));
        camera.position.lerp(intended, cockpitLast !== false ? 1 : 1 - Math.exp(-5.5 * dt));
        camera.lookAt(focus);
      }
      if (cockpit !== cockpitLast) {
        car.setCockpit(cockpit);
        cockpitLast = cockpit;
      }
      const fov = cockpit ? gaze === "signal_detail" ? 34 : gaze === "right_detail" ? 47 : gaze === "road" ? 65 : 80 : 41;
      if (camera.fov !== fov) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
      renderer.render(scene, camera);
    },
  };
}
