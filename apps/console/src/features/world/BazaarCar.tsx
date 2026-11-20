import { useGLTF } from "@react-three/drei";
import { assetUrl } from "../../lib/assetUrl";
import { extendGltf } from "./gltfExtensions";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { RemoteBodies } from "./remoteFrames";

const MODEL = assetUrl("/assets/car-concept.glb");
// car-concept.glb's origin is at its centre; the wheels sit ~2.4 m below.
const GROUND_OFFSET = 2.4;

/** A parked (or driven) red car on a bazaar street. */
export function BazaarCar({
  position = [15, 0, 5],
  rotationY = 0,
  scale = 1,
  /** When set, the car follows this agent's body number (driven). */
  driverBodyN = null,
  /** Remote bodies to read the driver's position from. */
  remoteBodies = null,
}: {
  position?: [number, number, number];
  rotationY?: number;
  scale?: number;
  driverBodyN?: number | null;
  remoteBodies?: RemoteBodies | null;
}) {
  const gl = useThree((s) => s.gl);
  const gltf = useGLTF(MODEL, true, true, extendGltf(gl));
  const ref = useRef<THREE.Group>(null);

  useFrame(() => {
    if (!ref.current) return;
    if (driverBodyN !== null && remoteBodies) {
      const t = remoteBodies.renderTime(performance.now() / 1000);
      const pose = t !== null ? remoteBodies.sample(driverBodyN, t) : null;
      if (pose) {
        ref.current.position.set(pose.x, pose.y + GROUND_OFFSET, pose.z);
        ref.current.rotation.y = pose.heading;
        return;
      }
    }
    // Parked: use initial position
    ref.current.position.set(position[0], position[1] + GROUND_OFFSET, position[2]);
    ref.current.rotation.y = rotationY;
    ref.current.scale.setScalar(scale);
  });

  return (
    <group ref={ref}>
      <primitive object={gltf.scene.clone()} />
    </group>
  );
}
