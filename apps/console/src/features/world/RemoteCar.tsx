import { useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef, type RefObject } from "react";
import type * as THREE from "three";
import { assetUrl } from "../../lib/assetUrl";
import { extendGltf } from "./gltfExtensions";
import type { AgentFrame } from "./locomotion";

const CAR_MODEL = assetUrl("/assets/car-concept.glb");
const CAR_GROUND = 0.159;   // wheel bottoms sit this far below the car origin (BazaarCar.tsx)

/** A resident car (a server "car" body, ambientWorld.ts): placed from the interpolated stream frame RemoteCast keeps for it. */
export function RemoteCar({ framesRef, index }: { framesRef: RefObject<AgentFrame[]>; index: number }) {
  const gl = useThree((s) => s.gl);
  const gltf = useGLTF(CAR_MODEL, true, true, extendGltf(gl));
  const model = useMemo(() => gltf.scene.clone(), [gltf]);
  const ref = useRef<THREE.Group>(null);
  useFrame(() => {
    const f = framesRef.current?.[index], g = ref.current;
    if (!f || !g) return;
    g.position.set(f.position[0], CAR_GROUND, f.position[1]);   // the outer group already sits at the pose's y
    g.rotation.y = f.heading;
  });
  return <group ref={ref}><primitive object={model} /></group>;
}
