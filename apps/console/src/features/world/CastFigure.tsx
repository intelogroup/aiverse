import { useMemo, useRef, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import { Html, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { AgentFrame } from "./locomotion";

// CastFigure — a White Bot (the Agora's greeter body) driven by the same
// AgentFrame stream as every other figure in the world. The model is a
// STATIC posed mesh — no skeleton, no clips — so one GLB loads once (drei
// cache) and each cast member is a plain hierarchy clone: geometry and
// materials are shared across instances, nothing is skinned or mixed.
//
// Motion life comes from the crowd frames plus the same procedural
// treatment the ring world's unrigged figures use in Scene3D.tsx: while
// walking, a subtle vertical bob and forward lean (with a slight roll
// from the stride), all easing back to a settled upright stance at rest.
// Position and heading are owned by the crowd, exactly as before.

export const BOT_GLB_URL = "/assets/cast-whitebot.glb";

// Ported from Scene3D.tsx's figure treatment (same constants, so the two
// worlds read alike): bob is |sin| at ~9 rad/s, 5 cm tall; lean is a
// fixed 0.1 rad pitch while walking. Roll is the stride sway on top.
const BOB_FREQ = 9;
const BOB_AMP = 0.05;
const LEAN_MAX = 0.1;
const ROLL_MAX = 0.035;
// Smoothing rate for lean/roll so starts and stops settle, not snap.
const SETTLE = 8;

export function CastFigure({
  framesRef,
  index = 0,
  baseY = 0,
  home,
  label,
}: {
  /** Latest crowd frames, written by the crowd driver (GlbWorld). */
  framesRef: RefObject<AgentFrame[]>;
  /** Which crowd agent this figure visualizes. */
  index?: number;
  /** World Y of the ground this figure walks on (frames carry only XZ). */
  baseY?: number;
  /** Stand-here position until the first crowd frame arrives. */
  home: [number, number, number];
  /** Agent name shown on the floating label (roster name, as elsewhere). */
  label?: string;
}) {
  const gltf = useGLTF(BOT_GLB_URL);
  const group = useRef<THREE.Group>(null);
  const lean = useRef<THREE.Group>(null);
  const pose = useRef({ lean: 0, roll: 0 });

  // Shared geometry/materials per instance — Object3D.clone() on an
  // unrigged hierarchy reuses both; only transforms are per-figure.
  const scene = useMemo(() => gltf.scene.clone(), [gltf]);

  // The export is grounded (feet at y = 0, 1.15 m tall); measure anyway so
  // the label height tracks the real bounds and any floor offset lifts out.
  const fit = useMemo(() => {
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene);
    return { lift: -box.min.y, height: box.max.y - box.min.y };
  }, [scene]);

  useFrame((state, delta) => {
    const grp = group.current;
    const inner = lean.current;
    if (!grp || !inner) return;
    const f = framesRef.current[index];
    const walking = f?.state === "walk";
    const speed = f ? f.speed : 0;
    // Stride phase per figure (index-offset, as in Scene3D) so a walking
    // crowd never bobs in sync.
    const phase = state.clock.elapsedTime * BOB_FREQ + index * 1.7;
    const bob = walking ? Math.abs(Math.sin(phase)) * BOB_AMP : 0;

    if (f) {
      grp.position.set(f.position[0], baseY + bob, f.position[1]);
      grp.rotation.y = f.heading;
    }

    // Ease lean/roll toward their targets: pitched and swaying in
    // proportion to speed while walking, upright and still at rest.
    const p = pose.current;
    const k = Math.min(1, delta * SETTLE);
    const leanTarget = walking ? LEAN_MAX * Math.min(1, speed) : 0;
    const rollTarget = walking ? Math.sin(phase) * ROLL_MAX * Math.min(1, speed) : 0;
    p.lean += (leanTarget - p.lean) * k;
    p.roll += (rollTarget - p.roll) * k;
    inner.rotation.x = p.lean;
    inner.rotation.z = p.roll;
  });

  return (
    <group ref={group} position={home}>
      <group ref={lean}>
        <primitive object={scene} position={[0, fit.lift, 0]} />
      </group>
      {label && (
        <Html center position={[0, fit.height + 0.4, 0]}>
          <div className="w-cast-name">{label}</div>
        </Html>
      )}
    </group>
  );
}
