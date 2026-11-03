import { useEffect, useMemo, useRef, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import { Html, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { AgentFrame } from "./locomotion";
import { pinRootMotion } from "./clipUtils";

// CastFigure — a Y Bot (Mixamo-rigged, 65 bones) driven by the same
// AgentFrame stream as every other figure in the world. One GLB is loaded
// once (drei cache) and cloned per cast member with SkeletonUtils, so each
// bot owns its skeleton and AnimationMixer while sharing geometry.
//
// The model ships exactly two clips: "Walk" (1.0 s) and "Rumba". There is
// NO idle clip, and none is faked: at crowd-idle the Walk action fades out
// and the figure simply stands in its bind pose. While walking, the clip
// plays with timeScale proportional to ground speed (anti-skate, same
// convention as RiggedFigure) and its root travel is pinned
// (pinRootMotion) because the crowd — not the clip — owns position.

export const BOT_GLB_URL = "/assets/bot-ybot.glb";

// The source model stands ~3.57 m; on the Agora deck (19.4 m across) and
// the city streets alike, a 1.8 m figure reads as a person-scale bot.
const TARGET_HEIGHT = 1.8;
// Walk stride is ~2.0 m per 1.0 s loop at this height, so the cycle is
// skate-free when timeScale = speed / WALK_NOMINAL_SPEED.
const WALK_NOMINAL_SPEED = 2.0;
const CROSSFADE_S = 0.25;

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

  // Normalize once: uniform scale to TARGET_HEIGHT, floor lifted to y=0.
  const fit = useMemo(() => {
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene);
    const height = box.max.y - box.min.y;
    const s = height > 0 ? TARGET_HEIGHT / height : 1;
    return { scale: s, lift: -box.min.y * s };
  }, [scene]);

  const mixer = useMemo(() => new THREE.AnimationMixer(scene), [scene]);
  const walk = useMemo(() => {
    const clip = gltf.animations.find((a) => a.name === "Walk");
    if (!clip) return null;
    const action = mixer.clipAction(pinRootMotion(clip.clone()));
    action.setLoop(THREE.LoopRepeat, Infinity);
    return action;
  }, [gltf, mixer]);

  const fadingOut = useRef(false);

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

      if (walk) {
        if (f.state === "walk") {
          if (!walk.isRunning()) {
            walk.reset().setEffectiveWeight(0).play();
          }
          fadingOut.current = false;
          walk.fadeIn(CROSSFADE_S);
          walk.timeScale = THREE.MathUtils.clamp(f.speed / WALK_NOMINAL_SPEED, 0.3, 1.2);
        } else if (walk.isRunning()) {
          walk.fadeOut(CROSSFADE_S);
          fadingOut.current = true;
        }
      }
    }
    mixer.update(delta);
    // Once the idle fade has fully drained, stop the action so an idle
    // bot costs no clip evaluation — its bind pose is the standing pose.
    if (walk && fadingOut.current && walk.getEffectiveWeight() < 0.02) {
      walk.stop();
      fadingOut.current = false;
    }
  });

  return (
    <group ref={group} position={home}>
      <primitive object={scene} scale={fit.scale} position={[0, fit.lift, 0]} />
      {label && (
        <Html center position={[0, TARGET_HEIGHT + 0.4, 0]}>
          <div className="w-cast-name">{label}</div>
        </Html>
      )}
    </group>
  );
}
