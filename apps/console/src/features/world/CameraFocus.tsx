// Writes the ground point the camera looks at, for the HUD's location strip and minimap.
import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three";

export function CameraFocus({ onFocus }: { onFocus: (p: { x: number; z: number }) => void }) {
  const dir = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera }) => {
    camera.getWorldDirection(dir);
    // Looking level or up there is no ground point ahead: use where the camera stands.
    const k = dir.y < -0.05 ? camera.position.y / -dir.y : 0;
    onFocus({ x: camera.position.x + dir.x * k, z: camera.position.z + dir.z * k });
  });
  return null;
}
