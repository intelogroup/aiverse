import { useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { SCALE_REMY } from "@aiverse/world-sim/bodies";
import { APPLE_ASSET, type AppleBody } from "@aiverse/world-sim/movableProps";
import { STALL_CONSUMABLES, STALL_MOUTH_S, STALL_PICKUP_S, STALL_RETURN_S, bottleTilt, type StallConsumableId } from "@aiverse/world-sim/stallConsumables";
import { assetUrl } from "../../lib/assetUrl";
import { APPLE_SIZE, appleGripOffset } from "./appleGrip";
import { extendGltf } from "./gltfExtensions";
import type { RemoteBodies } from "./remoteFrames";

type FindHand = (n: number) => { hand: THREE.Object3D; body: AppleBody } | undefined;
const BOTTLE_PROFILE = [[0, -0.1], [0.027, -0.1], [0.031, -0.096], [0.032, -0.085], [0.032, 0.036],
  [0.028, 0.056], [0.016, 0.072], [0.012, 0.079], [0.012, 0.11], [0.009, 0.11], [0.009, 0.092]];
const handScale = new THREE.Vector3();

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
      grip.hand.localToWorld(appleGripOffset(grip.body, grip.hand.getWorldScale(handScale).x, prop.position));
      prop.rotation.set(bottleTilt(elapsed) * Number(!isFruit), 0, 0);
    };
    draw(fruit.current, "stall-apple");
    draw(bottle.current, "stall-water");
  });

  return <>
    {Object.entries(STALL_CONSUMABLES).map(([id, { position: [x, , z] }]) => (
      <group key={id} position={[x, 0.2, z + 0.08]}>
        <mesh position={[0, 0.805, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.86, 0.056, 0.46]} />
          <meshStandardMaterial color="#65422b" roughness={0.77} />
        </mesh>
        <mesh position={[0, 0.735, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.77, 0.1, 0.39]} />
          <meshStandardMaterial color="#4c3021" roughness={0.85} />
        </mesh>
        {[-0.34, 0.34].flatMap((legX) => [-0.15, 0.15].map((legZ) => (
          <mesh key={`${legX}:${legZ}`} position={[legX, 0.367, legZ]} castShadow>
            <boxGeometry args={[0.06, 0.734, 0.06]} />
            <meshStandardMaterial color="#543726" roughness={0.83} />
          </mesh>
        )))}
      </group>
    ))}
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
