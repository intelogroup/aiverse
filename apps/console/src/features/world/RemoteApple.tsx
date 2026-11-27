import { useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { SCALE_REMY } from "@aiverse/world-sim/bodies";
import { APPLE_ASSET, APPLE_GROUND, APPLE_STANDS, appleCenter, type AppleStand } from "@aiverse/world-sim/movableProps";
import { type AppleBody } from "@aiverse/world-sim/movableProps";
import { APPLE_GRIP_ROTATION, APPLE_HALF_HEIGHT, APPLE_SIZE, appleGripOffset, appleVisual } from "./appleGrip";
import { assetUrl } from "../../lib/assetUrl";
import { extendGltf } from "./gltfExtensions";
import type { RemoteBodies } from "./remoteFrames";

const stands = Object.keys(APPLE_STANDS) as AppleStand[];
const gripRotation = new THREE.Quaternion(...APPLE_GRIP_ROTATION);
const handScale = new THREE.Vector3();

export function RemoteApple({ bodies, findHand }: { bodies: RemoteBodies; findHand: (n: number) => { hand: THREE.Object3D; body: AppleBody } | undefined }) {
  const gl = useThree((state) => state.gl);
  const { scene } = useGLTF(assetUrl(APPLE_ASSET), true, true, extendGltf(gl));
  const model = useMemo(() => scene.clone(), [scene]);
  const apple = useRef<THREE.Group>(null);
  useFrame(() => {
    const mesh = apple.current, state = bodies.apple;
    if (!mesh || !state) return;
    const t = bodies.renderTime(performance.now() / 1000);
    const visual = appleVisual(state, t ?? -Infinity);
    if (visual.holder === null) {
      mesh.position.set(...appleCenter(visual.stand));
      mesh.quaternion.fromArray(APPLE_STANDS[visual.stand].rotation);
      mesh.visible = true;
      return;
    }
    const holder = findHand(visual.holder);
    mesh.visible = !!holder;
    if (!holder) return;
    const { hand, body } = holder;
    hand.localToWorld(appleGripOffset(body, hand.getWorldScale(handScale).x, mesh.position));
    hand.getWorldQuaternion(mesh.quaternion).multiply(gripRotation);
  });

  return (
    <>
      <group ref={apple} name="market-apple-01" visible={false} scale={SCALE_REMY * APPLE_SIZE}><primitive object={model} /></group>
      {stands.map((stand) => {
        const [x, , z] = appleCenter(stand);
        // Authored for the size-1 apple; the bigger apple's bottom sits lower, so the stand is shorter by the difference.
        const h = (APPLE_STANDS[stand].height - APPLE_HALF_HEIGHT * (APPLE_SIZE - 1)) * SCALE_REMY;
        return (
          <mesh key={stand} name={stand} position={[x, APPLE_GROUND + h / 2, z]} castShadow receiveShadow>
            <cylinderGeometry args={[0.006 * SCALE_REMY, 0.036 * SCALE_REMY, h, 32]} />
            <meshStandardMaterial color="#634129" roughness={0.8} />
          </mesh>
        );
      })}
    </>
  );
}
