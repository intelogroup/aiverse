import { useGLTF } from "@react-three/drei";
import { assetUrl } from "../../lib/assetUrl";
import { extendGltf } from "./gltfExtensions";
import { useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";

const MODEL = assetUrl("/assets/car-concept.glb");

/** A parked red car on a bazaar street. Static decoration, no collision. */
export function BazaarCar({ position = [15, 0, 5], rotationY = 0, scale = 1 }: {
  position?: [number, number, number];
  rotationY?: number;
  scale?: number;
}) {
  const gl = useThree((s) => s.gl);
  const gltf = useGLTF(MODEL, true, true, extendGltf(gl));
  const ref = useRef<THREE.Group>(null);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.position.set(...position);
    ref.current.rotation.y = rotationY;
    ref.current.scale.setScalar(scale);
  }, [position, rotationY, scale]);

  return (
    <group ref={ref}>
      <primitive object={gltf.scene.clone()} />
    </group>
  );
}