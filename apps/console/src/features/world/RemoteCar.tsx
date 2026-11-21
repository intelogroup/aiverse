import { useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef, type RefObject } from "react";
import type * as THREE from "three";
import { assetUrl } from "../../lib/assetUrl";
import { extendGltf } from "./gltfExtensions";
import type { AgentFrame } from "./locomotion";

// Resident cars use the low-poly copy (tools/city3/lod_car.py, 45k tris vs 213k): eight full cars cost 1.7 M triangles a frame.
const CAR_MODEL = assetUrl("/assets/car-npc.glb");
const CAR_GROUND = 0.01;   // its tyres bottom out at the model origin (the full car's 0.159 is an invisible part below the wheels)

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
