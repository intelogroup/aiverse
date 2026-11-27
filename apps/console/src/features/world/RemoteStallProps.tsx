import { useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { SCALE_REMY } from "@aiverse/world-sim/bodies";
import { APPLE_ASSET, type AppleBody } from "@aiverse/world-sim/movableProps";
import { STALL_CONSUMABLES, STALL_MOUTH_S, STALL_PICKUP_S, STALL_RETURN_S, bottleTilt, type StallConsumableId } from "@aiverse/world-sim/stallConsumables";
import { assetUrl } from "../../lib/assetUrl";
import { APPLE_GRIP_ROTATION, APPLE_SIZE } from "./appleGrip";
import { stallBottleAxis, stallGripOffset } from "./stallHandGrip";
import { extendGltf } from "./gltfExtensions";
import type { RemoteBodies } from "./remoteFrames";

type FindHand = (n: number) => { hand: THREE.Object3D; body: AppleBody } | undefined;
const BOTTLE_PROFILE = [[0, -0.1], [0.027, -0.1], [0.031, -0.096], [0.032, -0.085], [0.032, 0.036],
  [0.028, 0.056], [0.016, 0.072], [0.012, 0.079], [0.012, 0.11], [0.009, 0.11], [0.009, 0.092]];
const handScale = new THREE.Vector3();
const bottleUp = new THREE.Vector3(0, 1, 0);
const bottleAxis = new THREE.Vector3();
const handRotation = new THREE.Quaternion();
const appleRotation = new THREE.Quaternion(...APPLE_GRIP_ROTATION);

export function RemoteStallProps({ bodies, findHand }: { bodies: RemoteBodies; findHand: FindHand }) {
  const gl = useThree((state) => state.gl);
  const { scene } = useGLTF(assetUrl(APPLE_ASSET), true, true, extendGltf(gl));
  const apple = useMemo(() => scene.clone(), [scene]);
  const profile = useMemo(() => BOTTLE_PROFILE.map(([x, y]) => new THREE.Vector2(x, y)), []);
  const fruit = useRef<THREE.Group>(null);
  const bottle = useRef<THREE.Group>(null);

  useFrame(() => {
    const frame = bodies.stallProps;
    const t = bodies.renderTime(performance.now() / 1000) ?? -Infinity;
    const draw = (prop: THREE.Group | null, id: StallConsumableId) => {
      const state = frame?.[id];
      if (!prop) return;
      if (!state) { prop.visible = false; return; }
      const elapsed = state.motion ? t - state.motion.startedAt : -Infinity;
      const isFruit = id === "stall-apple";
      if (isFruit && (state.motion ? elapsed >= STALL_MOUTH_S : !state.visible)) {
        prop.visible = false;
        return;
      }
      prop.visible = true;
      const held = state.motion && elapsed >= STALL_PICKUP_S && elapsed < STALL_RETURN_S;
      if (!held || !state.motion) {
        const [x, y, z] = STALL_CONSUMABLES[id].position;
        prop.position.set(x, y, z);
        prop.rotation.set(0, 0, 0);
        return;
      }
      const grip = findHand(state.motion.n);
      prop.visible = !!grip;
      if (!grip) return;
      grip.hand.localToWorld(stallGripOffset(id, grip.body, grip.hand.getWorldScale(handScale).x, prop.position));
      const localAxis = stallBottleAxis(grip.body);
      if (isFruit && localAxis) {
        prop.quaternion.copy(grip.hand.getWorldQuaternion(handRotation)).multiply(appleRotation);
      } else if (!isFruit && localAxis) {
        bottleAxis.copy(localAxis).applyQuaternion(grip.hand.getWorldQuaternion(handRotation));
        prop.quaternion.setFromUnitVectors(bottleUp, bottleAxis);
      } else {
        prop.rotation.set(isFruit ? 0 : bottleTilt(elapsed), 0, 0);
      }
    };
    draw(fruit.current, "stall-apple");
    draw(bottle.current, "stall-water");
  });

  return <>
    <group ref={fruit} name="stall-apple" visible={false} scale={SCALE_REMY * APPLE_SIZE}><primitive object={apple} /></group>
    <group ref={bottle} name="stall-water" visible={false}>
      <mesh castShadow receiveShadow>
        <latheGeometry args={[profile, 32]} />
        <meshStandardMaterial color="#217b70" metalness={0.12} roughness={0.28} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, -0.032, 0]}>
        <cylinderGeometry args={[0.0324, 0.0324, 0.044, 32, 1, true]} />
        <meshStandardMaterial color="#dfdfb2" roughness={0.8} />
      </mesh>
    </group>
  </>;
}
