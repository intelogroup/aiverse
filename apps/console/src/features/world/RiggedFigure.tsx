import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { AgentFrame, LocomotionState } from "./locomotion";

// RiggedFigure — the library-clips half of the locomotion integration.
//
// Renders the KayKit Knight (CC0, shared Rig_Medium rig, 76 embedded clips
// verified in the spike) and drives an AnimationMixer from the SAME
// AgentFrame stream the procedural figures use: state "idle" plays `Idle`,
// state "walk" plays `Walking_A`, crossfaded over 0.2 s, heading from the
// crowd velocity. No separate movement logic lives here — locomotion.ts
// decides where the figure is and whether it is walking; this component
// only makes the legs agree.
//
// The GLB is 3.7 MB — over the console's delivery budget for a default
// load — so Scene3D only mounts this component when the URL carries
// ?rigged=1, and only for one figure on the largest platform.

export const KNIGHT_GLB_URL = "/assets/kaykit-knight.glb";

// KayKit's Walking_A is an in-place cycle: it carries no root motion, so
// its stride rate is only "correct" at one ground speed. The constant
// below is that nominal speed — chosen as the crowd's max speed (1.4 m/s),
// the pace the cycle reads naturally at. timeScale = speed / NOMINAL keeps
// stride rate proportional to actual ground speed at slower paces, which
// is what stops the feet from skating.
const WALK_NOMINAL_SPEED = 1.4;
const CROSSFADE_S = 0.2;
// World-space height for the figure: the procedural box figures are ~0.45
// units tall; the Knight reads better a little larger on the 3.1-unit disc.
const TARGET_HEIGHT = 0.95;

export function RiggedFigure({
  framesRef,
  index = 0,
  scale = 1,
  home,
  children,
}: {
  /** Latest crowd frames, written by the platform's useFrame driver. */
  framesRef: RefObject<AgentFrame[]>;
  /** Which crowd agent this figure visualizes. */
  index?: number;
  /** Crowd-space → platform-local render scale (see Scene3D). */
  scale?: number;
  /** Stand-here position until the first crowd frame arrives. */
  home: [number, number, number];
  /** Rendered inside the moving group (e.g. a speech bubble). */
  children?: ReactNode;
}) {
  const gltf = useGLTF(KNIGHT_GLB_URL);
  const group = useRef<THREE.Group>(null);

  // Normalize the model once: uniform scale so its height is
  // TARGET_HEIGHT, and lift it so its bounding-box floor sits at y=0.
  const fit = useMemo(() => {
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const height = box.max.y - box.min.y;
    const s = height > 0 ? TARGET_HEIGHT / height : 1;
    return { scale: s, lift: -box.min.y * s };
  }, [gltf]);

  const mixer = useMemo(() => new THREE.AnimationMixer(gltf.scene), [gltf]);
  const actions = useMemo(() => {
    const byName = (name: string) => {
      const clip = gltf.animations.find((a) => a.name === name);
      return clip ? mixer.clipAction(clip) : null;
    };
    return { idle: byName("Idle"), walk: byName("Walking_A") };
  }, [gltf, mixer]);

  const activeState = useRef<LocomotionState>("idle");

  useEffect(() => {
    actions.idle?.play();
    activeState.current = "idle";
    return () => {
      mixer.stopAllAction();
    };
  }, [actions, mixer]);

  useFrame((_, delta) => {
    const grp = group.current;
    if (!grp) return;
    const f = framesRef.current[index];
    if (f) {
      grp.position.set(f.position[0] * scale, 0, f.position[1] * scale);
      grp.rotation.y = f.heading;

      if (f.state !== activeState.current) {
        const next = f.state === "walk" ? actions.walk : actions.idle;
        const prev = f.state === "walk" ? actions.idle : actions.walk;
        if (next) {
          next.reset().setEffectiveWeight(1).fadeIn(CROSSFADE_S).play();
          prev?.fadeOut(CROSSFADE_S);
          activeState.current = f.state;
        }
      }
      if (actions.walk) {
        actions.walk.timeScale = THREE.MathUtils.clamp(f.speed / WALK_NOMINAL_SPEED, 0.4, 1.8);
      }
    }
    mixer.update(delta);
  });

  return (
    <group ref={group} position={home}>
      <primitive object={gltf.scene} scale={fit.scale} position={[0, fit.lift, 0]} />
      {children}
    </group>
  );
}
