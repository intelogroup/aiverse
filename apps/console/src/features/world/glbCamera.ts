// Camera rigs for the spectator stage (extracted from GlbWorld.tsx,
// cleanup L2).
import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { isReducedMotion } from "./comfort";

/**
 * Mobile Phase 2: the double-tap fly-to for a tapped figure. When the
 * shared ref gains a point, fly the spectator camera to a three-quarter
 * view of it over ~1.1 s (smoothstep), moving OrbitControls' target
 * with it — the same write-the-controls pattern the room flights use.
 */
export function FigureFlyRig({
  flyRef,
}: {
  flyRef: { current: { x: number; z: number } | null };
}) {
  // Mobile Phase 4: reduced motion turns the flight into a cut — the
  // goal state applies in the first frame instead of easing over 1.1 s.
  const reduced = isReducedMotion();
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as {
    target: THREE.Vector3;
    update?: () => void;
  } | null;
  const anim = useRef<{
    t: number;
    fromPos: THREE.Vector3;
    fromTgt: THREE.Vector3;
    toPos: THREE.Vector3;
    toTgt: THREE.Vector3;
  } | null>(null);
  useFrame((_, delta) => {
    const goal = flyRef.current;
    if (goal && !anim.current) {
      flyRef.current = null;
      const toTgt = new THREE.Vector3(goal.x, 1.1, goal.z);
      const away = camera.position.clone().sub(toTgt);
      away.y = 0;
      if (away.lengthSq() < 0.01) away.set(1, 0, 1);
      away.normalize();
      anim.current = {
        t: 0,
        fromPos: camera.position.clone(),
        fromTgt: controls?.target.clone() ?? new THREE.Vector3(),
        toPos: toTgt.clone().add(away.multiplyScalar(6.5)).add(new THREE.Vector3(0, 3.2, 0)),
        toTgt,
      };
      if (reduced) anim.current.t = 0.999; // one frame: the cut
    }
    const a = anim.current;
    if (!a) return;
    a.t = Math.min(1, a.t + delta / 1.1);
    const k = a.t * a.t * (3 - 2 * a.t);
    camera.position.lerpVectors(a.fromPos, a.toPos, k);
    if (controls) {
      controls.target.lerpVectors(a.fromTgt, a.toTgt, k);
      controls.update?.();
    }
    if (a.t >= 1) anim.current = null;
  });
  return null;
}
