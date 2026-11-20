import { useGLTF } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useEffect } from "react";
import type * as THREE from "three";
import { assetUrl } from "../../lib/assetUrl";
import { extendGltf } from "./gltfExtensions";
import { solidParts } from "./streetFurniture";

// Same useGLTF cache entries as IntersectionSignals / RoadMarks, so the visible posts and the solid posts are the same meshes.
const SIGNALS = assetUrl("/assets/world-signals.glb");
const MARKS = assetUrl("/assets/world-roadmarks.glb");
const SIGNS = assetUrl("/assets/world-roadsigns.glb");

/** Makes the Bazaar signal posts and sign poles solid for the walker and the camera (they share DistrictWorld's collider set). */
export function StreetFurnitureColliders({ addColliders, dropColliders }: {
  addColliders: (key: string, root: THREE.Object3D) => void;
  dropColliders: (key: string) => void;
}) {
  const gl = useThree((s) => s.gl);
  const signals = useGLTF(SIGNALS, true, true, extendGltf(gl));
  const marks = useGLTF(MARKS, true, true, extendGltf(gl));
  const signs = useGLTF(SIGNS, true, true, extendGltf(gl));
  useEffect(() => {
    addColliders("signals", solidParts(signals.scene));
    addColliders("roadmarks", solidParts(marks.scene));
    addColliders("roadsigns", solidParts(signs.scene));
    return () => { dropColliders("signals"); dropColliders("roadmarks"); dropColliders("roadsigns"); };
  }, [signals, marks, signs]); // eslint-disable-line react-hooks/exhaustive-deps -- add/dropColliders are recreated each render but only touch refs
  return null;
}
