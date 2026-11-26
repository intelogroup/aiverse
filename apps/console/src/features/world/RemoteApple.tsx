import { useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { SCALE_REMY } from "@aiverse/world-sim/bodies";
import { APPLE_ASSET, APPLE_GROUND, APPLE_STANDS, appleCenter, type AppleStand } from "@aiverse/world-sim/movableProps";
import { APPLE_GRIP_POSITION, APPLE_GRIP_ROTATION, appleVisual } from "./appleGrip";
import { assetUrl } from "../../lib/assetUrl";
import { extendGltf } from "./gltfExtensions";
import type { RemoteBodies } from "./remoteFrames";

const stands = Object.keys(APPLE_STANDS) as AppleStand[];
const gripPosition = new THREE.Vector3(...APPLE_GRIP_POSITION);
const gripRotation = new THREE.Quaternion(...APPLE_GRIP_ROTATION);

export function RemoteApple({ bodies, findHand }: { bodies: RemoteBodies; findHand: (n: number) => THREE.Object3D | undefined }) {
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
      mesh.quaternion.set(...APPLE_STANDS[visual.stand].rotation);
      mesh.visible = true;
      return;
    }
    const hand = findHand(visual.holder);
    mesh.visible = !!hand;
    if (!hand) return;
    hand.localToWorld(mesh.position.copy(gripPosition));
    hand.getWorldQuaternion(mesh.quaternion).multiply(gripRotation);
  });

  return (
    <>
      <group ref={apple} name="market-apple-01" visible={false} scale={SCALE_REMY}><primitive object={model} /></group>
      {stands.map((stand) => {
        const [x, , z] = appleCenter(stand);
        const h = APPLE_STANDS[stand].height * SCALE_REMY;
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
