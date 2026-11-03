import { useEffect, useMemo, useRef, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import { Html, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { AgentFrame } from "./locomotion";

// CastFigure — a Body Block bot (Mixamo-rigged, 57 bones) driven by the
// same AgentFrame stream as every other figure in the world. One GLB is
// loaded once (drei cache) and cloned per cast member with SkeletonUtils,
// so each bot owns its skeleton and AnimationMixer while sharing
// geometry and materials.
//
// The model ships two clips: "Walk" (1.0 s, baked IN PLACE — the crowd,
// not the clip, owns position, so no root-motion pinning is needed) and
// "Idle" (a subtle sway). Animation state follows crowd speed: Idle at
// rest, Walk while moving, the two blended by a walk weight that ramps
// over ~0.25 s so starts and stops crossfade instead of snapping. Walk
// playback rate scales modestly with ground speed (anti-skate).
//
// The model is authored at cast size: 1.25 m tall, feet grounded at the
// local origin. Unlike the retired Y Bot there is NO height
// normalization — the only fit applied is a measured floor lift.

export const BOT_GLB_URL = "/assets/cast-bodyblock.glb";

// Ground speed at which the Walk cycle plays at its natural rate.
const WALK_NOMINAL_SPEED = 1.0;
// Time for the walk weight to ramp 0→1 (the Idle↔Walk crossfade).
const FADE_S = 0.25;

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

  // Own skeleton + own scene graph per cast member.
  const scene = useMemo(() => skeletonClone(gltf.scene), [gltf]);

  // No scaling — the export is authored at 1.25 m with feet at y = 0.
  // Measure anyway so the floor lift and label height track real bounds.
  const fit = useMemo(() => {
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene);
    return { lift: -box.min.y, height: box.max.y - box.min.y };
  }, [scene]);

  const mixer = useMemo(() => new THREE.AnimationMixer(scene), [scene]);
  const actions = useMemo(() => {
    const make = (name: string) => {
      // Exact name first; the exporter may suffix a duplicate clip name
      // ("Walk.001"), so fall back to matching the base name.
      const clip =
        gltf.animations.find((a) => a.name === name) ??
        gltf.animations.find((a) => a.name.replace(/\.\d+$/, "") === name);
      if (!clip) return null;
      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      return action;
    };
    const idle = make("Idle");
    const walk = make("Walk");
    // Idle is the resting state: running from the start at full weight.
    // Walk starts silent; the frame loop raises its weight on movement.
    if (idle) idle.reset().setEffectiveWeight(1).play();
    if (walk) walk.setEffectiveWeight(0);
    return { idle, walk };
  }, [gltf, mixer]);

  // Current Walk blend weight (0 = pure Idle, 1 = pure Walk).
  const walkWeight = useRef(0);

  useEffect(() => {
    return () => {
      mixer.stopAllAction();
    };
  }, [mixer]);

  useFrame((_, delta) => {
    const grp = group.current;
    if (!grp) return;
    const f = framesRef.current[index];
    if (f) {
      grp.position.set(f.position[0], baseY, f.position[1]);
      grp.rotation.y = f.heading;
    }

    const { idle, walk } = actions;
    if (walk) {
      const walking = f?.state === "walk";
      const target = walking ? 1 : 0;
      const w = walkWeight.current;
      if (w !== target) {
        const step = delta / FADE_S;
        walkWeight.current =
          target > w ? Math.min(target, w + step) : Math.max(target, w - step);
      }
      const weight = walkWeight.current;
      if (weight > 0 && !walk.isRunning()) walk.reset().play();
      walk.setEffectiveWeight(weight);
      if (idle) idle.setEffectiveWeight(1 - weight);
      // Feet roughly match ground speed: the 1.0 s cycle at its natural
      // rate near WALK_NOMINAL_SPEED, clamped to a modest band.
      walk.timeScale = THREE.MathUtils.clamp(
        (f ? f.speed : 0) / WALK_NOMINAL_SPEED,
        0.7,
        1.4,
      );
      // Fully idle again: stop the Walk action so a resting bot costs
      // no clip evaluation beyond its Idle sway.
      if (weight === 0 && walk.isRunning()) walk.stop();
    }
    mixer.update(delta);
  });

  return (
    <group ref={group} position={home}>
      <primitive object={scene} position={[0, fit.lift, 0]} />
      {label && (
        <Html center position={[0, fit.height + 0.35, 0]}>
          <div className="w-cast-name">{label}</div>
        </Html>
      )}
    </group>
  );
}
