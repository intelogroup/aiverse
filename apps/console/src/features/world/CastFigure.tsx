import { useEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { verticalExcess, type AgentFrame } from "./locomotion";
import type { FigureOverride, SitPhase } from "./embody";
import { BODY_CAST, sitClipForPhase, type BodyDef } from "./bodies";
import { qualityStore } from "./quality";
import { CLIP_CATALOG, clipDef, clipTesterYield, type ClipTestState } from "./clips";
import { approach, cycleRateFor, gaitTargets, runTimeForWalkPhase, type GaitSpec } from "./gait";
import { clipMinClearance, contactPoints, groundingOffset, rootMotionDelta, soleClearance } from "./grounding";
import { FootLock, footLockEnabled } from "./footLock";
import { createFootContactShadows } from "./contactShadow";

// CastFigure — a cast bot (a "body" from bodies.ts: a rigged GLB plus
// its measured hips and clip catalog) driven by the same AgentFrame
// stream as every other figure in the world. One GLB is loaded once
// (drei cache) and cloned per cast member with SkeletonUtils, so each
// bot owns its skeleton and AnimationMixer while sharing geometry and
// materials.
//
// Every body ships the same 45-clip catalog (clips.ts). Five clips
// are body-layer business: "Walk" (a REAL root-motion cycle since
// 2026-11-05 — the clip carries genuine hips translation; the crowd
// still owns position, so the frame loop extracts the root motion:
// it counter-translates the posed hips XZ on the skeleton's parent
// node, leaving the gait, the bob and the foot plants in the pose
// while the figure stays over its crowd point),
// "IdleLong" (the resting stand; body.clips.idle — the catalog's plain "Idle" is a walk in place and is not played), "SittingTalking" (a 44 s seated loop,
// rotations only — the embody override owns seat placement),
// "SitDown" (the authored stand-to-sit transition, played once while
// the override mounts) and "StandUp" (its dedicated sit-to-stand
// counterpart, played once while the override stands). The other 40
// are catalog vocabulary, driven only by the Embody panel's clip
// tester overlay below. Animation state
// follows the body: Idle at rest, Walk while moving, and the sitting
// family follows the override's phase (bodies.ts sitClipForPhase).
// The weights ramp over ~0.25 s so transitions crossfade instead of
// snapping — the one exception being SitDown's start, which begins
// from the standing pose its first frame already matches.
// Walk playback rate scales modestly with ground speed (anti-skate).
//
// Bodies are authored at cast size: 1.25 m tall, feet grounded at the
// local origin. Unlike the retired Y Bot there is NO height
// normalization — the only fit applied is a measured floor lift.

export const BOT_GLB_URL = "/assets/cast-bodyblock.glb";



// The Walk cycle's natural rate is per body (bodies.ts walkSpeed —
// measured from the baked cycle's stance feet, not a global guess).

// Per-agent body colors: each bot is painted its own color (Jim's call —
// red, yellow, blue and family), with the face screen glowing a lightened
// version of the same hue. The pick is a stable hash of the figure's seed
// so an agent keeps its color wherever it stands. Part shades preserve
// the authored light/dark ladder between body parts (head darkest, limbs
// lightest) on top of the agent color. The asset's own factors are the
// graphite fallback for anything this pass doesn't reach.
const ACCENT_PALETTE = [
  "#d23b3b", // red
  "#e6b93d", // yellow
  "#2f6fd0", // blue
  "#3fae5a", // green
  "#e07b2a", // orange
  "#7a4fd0", // violet
  "#1fa8a0", // teal
  "#d0537f", // rose
];

const PART_SHADE: Record<string, number> = {
  torso: 1.0,
  head: 0.75,
  pelvis: 0.86,
  arms: 1.2,
  legs: 1.2,
  ears: 1.2,
};

export function accentForFigure(seed: string | undefined, index: number): string {
  const s = seed ?? String(index);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return ACCENT_PALETTE[h % ACCENT_PALETTE.length];
}
// Time for the walk weight to ramp 0→1 (the Idle↔Walk crossfade).
const FADE_S = 0.25;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

// Authored-bob band for the vertical guard below: hips height may
// wander ±9 cm around rest on the pose's own bob; anything past that is
// a baked ramp, not a bob, and gets countered on the figure group.
const HIPS_Y_BAND = 0.09;


export function CastFigure({
  framesRef,
  overridesRef,
  index = 0,
  baseY = 0,
  home,
  hidden = false,
  body = BODY_CAST,
  clipTester,
  headPoseRef,
  playingClipRef,
  renderedReadyRef,
}: {
  /**
   * Head-bone stream for the first-person camera (cameraRig): when
   * present (the Embody panel's focus figure only), the figure writes
   * its head bone's world position here every frame — Summer's rig
   * names it `mixamorig:Head` — and the ride camera anchors on it, so
   * the view carries the head's own motion. Figures without the prop
   * never pay for the lookup.
   */
  headPoseRef?: { current: [number, number, number] | null };
  /** The clip the mixer has actually applied on this frame. */
  playingClipRef?: { current: string | null };
  renderedReadyRef?: { current: boolean };
  /** The body this member wears (bodies.ts registry). */
  body?: BodyDef;
  /**
   * Embody panel clip tester (clips.ts): when present (the panel's
   * focus figure in embody mode), the figure blends toward the fired catalog clip —
   * one-shots once, loops held — and yields back to the body layer
   * afterwards. The sit choreography always wins: while a sit
   * override is active the tester is suppressed, never blended.
   */
  clipTester?: ClipTestState;
  /** Latest crowd frames, written by the crowd driver (GlbWorld). */
  framesRef: RefObject<AgentFrame[]>;
  /**
   * Embody v0 render overrides (seat transforms while sitting/mounting),
   * keyed by crowd index. Absent in the normal world view.
   */
  overridesRef?: RefObject<Map<number, FigureOverride>>;
  /** Which crowd agent this figure visualizes. */
  index?: number;
  /**
   * Ride mode: this figure IS the camera. It does not render at all —
   * body — so the first-person view is through its eyes, never
   * barred by its own shell. Wide and Follow keep it fully visible.
   */
  hidden?: boolean;
  /** World Y of the ground this figure walks on (frames carry only XZ). */
  baseY?: number;
  /** Stand-here position until the first crowd frame arrives. */
  home: [number, number, number];
}) {
  // Mobile Phase 3: at the lite tier a body with a Lite variant
  // (bodies.ts liteUrl — resampled/quantized) loads that instead.
  const quality = useSyncExternalStore(qualityStore.subscribe, qualityStore.getSnapshot);
  const gltf = useGLTF(quality.tier === "lite" && body.liteUrl ? body.liteUrl : body.url);
  const group = useRef<THREE.Group>(null);

  // Own skeleton + own scene graph per cast member, shown at the body's display scale (bodies.ts: realistic heights).
  // Everything measured below (fit, rest hips, head bone) reads world space and so includes it; grounding.ts measures in
  // the scene's own (unscaled) frame, so its offset is multiplied back by bodyScale where it is applied.
  const bodyScale = body.scale ?? 1;
  const scene = useMemo(() => {
    const s = skeletonClone(gltf.scene);
    s.scale.setScalar(bodyScale);
    return s;
  }, [gltf, bodyScale]);

  // Paint this figure in its agent color. Materials are shared across
  // clones, so every tinted material is cloned first. Body parts take the
  // color at their ladder shade; the screen glows a lightened version.
  useMemo(() => {
    const accent = new THREE.Color(accentForFigure(undefined, index));
    const face = accent.clone().lerp(new THREE.Color("#ffffff"), 0.55);
    scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const mat = o.material;
      if (Array.isArray(mat) || !(mat instanceof THREE.MeshStandardMaterial)) return;
      if (mat.name === "screen") {
        const own = mat.clone();
        own.emissive.copy(face);
        own.emissiveIntensity = 2.6;
        o.material = own;
      } else if (mat.name in PART_SHADE) {
        const own = mat.clone();
        own.color.copy(accent).multiplyScalar(PART_SHADE[mat.name]);
        o.material = own;
      }
    });
  }, [scene, index]);

  // Measure the (scaled) figure so the floor lift tracks its real bounds.
  const fit = useMemo(() => {
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene);
    return { lift: -box.min.y, height: box.max.y - box.min.y };
  }, [scene]);

  // Root-motion extraction rig: the hips joint (the only joint whose
  // translation any clip animates — Walk's root ramp; every other
  // clip ships rotation-only) and its parent node. Each frame the
  // parent is counter-translated by the posed hips XZ delta, so the
  // traveling cycle performs over the crowd point instead of walking
  // away from it and snapping back at the loop.
  const rootMotion = useMemo(() => {
    const found: THREE.Object3D[] = [];
    scene.traverse((o) => {
      if (o.name.endsWith("Hips")) found.push(o);
    });
    const hips = found[0] ?? null;
    if (!hips || !hips.parent) return null;
    const parent = hips.parent;
    // Rest hips height in figure-local space (the primitive rides at
    // fit.lift inside the group) — the vertical guard's reference.
    scene.updateMatrixWorld(true);
    const restWorld = new THREE.Vector3();
    hips.getWorldPosition(restWorld);
    return {
      hips,
      parent,
      hipsRest: hips.position.clone(),
      parentRest: parent.position.clone(),
      parentQuat: parent.quaternion.clone(),
      // Mixamo FBX rigs keep centimetres under a scaled Armature (Remy: 0.003), so the hips delta must be
      // scaled into the parent's frame too, or the cancel shoves the body metres sideways each cycle.
      parentScale: parent.scale.clone(),
      restHipsLocalY: restWorld.y + fit.lift,
    };
  }, [scene, fit]);
  // Foot contact joints, read in the bind pose (grounding.ts), and the Run clip's lowest clearance over a cycle
  // (its flight phase must not be pulled down to the floor). No contact joints = the old hips guard only.
  const contacts = useMemo(() => contactPoints(scene), [scene]);
  const runMin = useMemo(() => {
    const clip = body.run ? gltf.animations.find((a) => a.name === "Run") : undefined;
    return clip ? clipMinClearance(scene, clip, contacts) : 0;
  }, [scene, contacts, gltf, body]);
  // Runtime foot lock (footLock.ts): pins a planted foot in the world while the gait-driven body travels over it.
  const footLock = useMemo(() => new FootLock(scene, contacts), [scene, contacts]);
  const contactShadows = useMemo(() => createFootContactShadows(contacts, bodyScale), [contacts, bodyScale]);
  useEffect(() => () => contactShadows.dispose(), [contactShadows]);
  const rmDelta = useRef(new THREE.Vector3());
  const hipsWorldTmp = useRef(new THREE.Vector3());

  // The head bone, for the first-person camera stream (see the
  // headPoseRef prop). Matched by name suffix: Summer's Mixamo rig
  // calls it `mixamorig:Head`, the KayKit Rig_Medium `Head` — while
  // `mixamorig:HeadTop_End` (the scalp terminus above it) must NOT
  // match, hence the exact-suffix test rather than a substring.
  const headBone = useMemo(() => {
    if (!headPoseRef) return null;
    const matches: THREE.Object3D[] = [];
    scene.traverse((o) => {
      if (o.name.endsWith("Head")) matches.push(o);
    });
    return matches[0] ?? null;
  }, [scene, headPoseRef]);
  const headWorldTmp = useRef(new THREE.Vector3());

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
    const idle = make(body.clips.idle);
    const walk = make(body.clips.walk);
    const sit = make(body.clips.sitTalk);
    const sitDown = make(body.clips.sitDown);
    const standUp = make(body.clips.standUp);
    // The full catalog by name, for the clip tester: every clip the
    // body ships (clips.ts) gets an action; the five core clips share
    // the action objects above, the rest start silent and are driven
    // only by the tester overlay in the frame loop.
    const byName = new Map<string, THREE.AnimationAction>();
    for (const def of CLIP_CATALOG) {
      const a = make(def.name);
      if (a) byName.set(def.name, a);
    }
    // The transitions are one-shots, not loops: play once per phase
    // and hold the final pose until the next state has faded in.
    for (const t of [sitDown, standUp]) {
      if (t) {
        t.setLoop(THREE.LoopOnce, 1);
        t.clampWhenFinished = true;
      }
    }
    // Idle is the resting state: running from the start at full weight.
    // The rest start silent; the frame loop raises their weights.
    if (idle) idle.reset().setEffectiveWeight(1).play();
    if (walk) walk.setEffectiveWeight(0);
    if (sit) sit.setEffectiveWeight(0);
    if (sitDown) sitDown.setEffectiveWeight(0);
    if (standUp) standUp.setEffectiveWeight(0);
    for (const a of byName.values()) {
      if (a !== idle && a !== walk && a !== sit && a !== sitDown && a !== standUp) {
        a.setEffectiveWeight(0);
      }
    }
    // Run: only bodies with measured run facts (bodies.ts `run`), only for gait-driven frames (AgentFrame.gait).
    const run = body.run ? (byName.get("Run") ?? null) : null;
    const gait: GaitSpec | null =
      run && walk && body.run
        ? {
            walkSpeed: body.walkSpeed,
            runSpeed: body.run.speed,
            walkDuration: walk.getClip().duration,
            runDuration: run.getClip().duration,
          }
        : null;
    return { idle, walk, sit, sitDown, standUp, byName, run, gait };
  }, [gltf, mixer, body]);

  // Current Walk blend weight (0 = pure Idle, 1 = pure Walk). On the gait path: Idle vs locomotion (Walk + Run).
  const walkWeight = useRef(0);
  // Gait path only: Run's share of the locomotion blend (0 = all Walk, 1 = all Run).
  const runMix = useRef(0);
  // Current SittingTalking blend weight (0 = upright, 1 = seated loop).
  const sitWeight = useRef(0);
  // Current SitDown blend weight (the mount transition clip).
  const downWeight = useRef(0);
  // Current StandUp blend weight (the stand transition clip).
  const upWeight = useRef(0);
  // The override phase the figure last reacted to — SitDown is
  // (re)started on phase ENTRY, not held down per frame.
  const phaseRef = useRef<SitPhase | null>(null);
  // Clip tester overlay: the catalog clip currently fired on this
  // figure (null = body layer owns it) and its blend weight.
  const activeTest = useRef<string | null>(null);
  const testActionRef = useRef<THREE.AnimationAction | null>(null);
  const testWeight = useRef(0);
  // Body-controller turn clip (bodyController.ts): the catalog's TurnLeft90/TurnRight90 bake the pelvis
  // rotation into the clip. The controller owns the clip clock and the heading; this figure counter-rotates
  // the skeleton root by the yaw the clip has swung so far, so the visible facing is the controller's heading
  // while the legs still step the way the clip authored them (feet planted, no turntable spin). The clips also carry
  // a constant ~62 degree start offset (TURN_YAW0); `turnYawRef` is the whole baked yaw.
  const turnWeight = useRef(0);
  const turnYawRef = useRef(0);
  const turnActionRef = useRef<THREE.AnimationAction | null>(null);

  useEffect(() => {
    // React StrictMode (dev) mounts, cleans up and mounts again: the cleanup below stops the Idle the actions memo
    // started, and the memo does not re-run, so a dev figure stood frozen in its first pose. Start it again.
    if (actions.idle && !actions.idle.isRunning()) actions.idle.reset().setEffectiveWeight(1).play();
    return () => {
      mixer.stopAllAction();
      if (renderedReadyRef) renderedReadyRef.current = false;
    };
  }, [mixer, actions, renderedReadyRef]);

  useFrame((_, frameDelta) => {
    const delta = playingClipRef ? Math.min(frameDelta, 0.1) : frameDelta;
    const grp = group.current;
    if (!grp) return;
    // The ridden figure is the camera: never render it (see `hidden`).
    grp.visible = !hidden;
    const f = framesRef.current[index];
    const ov = f ? overridesRef?.current.get(index) : undefined;
    if (f) {
      if (ov) {
        // Embody override: the figure sits/mounts at the anchor while the
        // crowd body stays at the approach point.
        grp.position.set(ov.position[0], baseY + ov.y, ov.position[1]);
        grp.rotation.y = ov.heading;
      } else {
        grp.position.set(f.position[0], baseY, f.position[1]);
        grp.rotation.y = f.heading;
      }
    }

    const { idle, walk, sit, sitDown, standUp, byName } = actions;
    // Sitting family follows the override's phase (see sitClipForPhase):
    // mounting plays SitDown once, seated loops SittingTalking,
    // standing plays the dedicated StandUp once. No override — no
    // sitting clip.
    const phase: SitPhase | null = ov ? ov.phase : null;
    const plan = sitClipForPhase(phase);
    const transition =
      plan.clip === "sitDown" ? sitDown : plan.clip === "standUp" ? standUp : null;
    if (transition && phase !== phaseRef.current) {
      // Phase entry: (re)start the transition from its first frame —
      // SitDown opens on the standing pose the figure already holds,
      // StandUp on the seated pose.
      transition.reset();
      transition.timeScale = 1;
      transition.play();
    }
    phaseRef.current = phase;
    const ramp = (cur: number, target: number): number => {
      if (cur === target) return cur;
      const step = delta / FADE_S;
      return target > cur ? Math.min(target, cur + step) : Math.max(target, cur - step);
    };
    // ---- Clip tester sync (Embody panel, focus figure only) ----
    // This figure is the tester state's only consumer, so it ticks
    // the clock that expires one-shots. While a sit override owns the
    // body the sync is skipped outright — the choreography is never
    // fought; a clip fired mid-sit starts once the figure stands.
    if (clipTester) {
      clipTester.tick(delta);
      if (!ov && clipTester.current !== activeTest.current) {
        const want = clipTester.current;
        if (want) {
          // Direct clip-to-clip switch: retire the old overlay clip.
          const prev = testActionRef.current;
          if (prev && prev !== idle && prev !== walk) {
            prev.stop();
            prev.setEffectiveWeight(0);
          }
          testActionRef.current = null;
        }
        // On expiry (want === null) the old action stays referenced
        // so the weight block can fade it out before stopping it.
        activeTest.current = want;
        if (want && want !== body.clips.walk && want !== body.clips.idle) {
          const a = byName.get(want);
          const def = clipDef(want);
          if (a && def) {
            a.reset();
            if (def.loop) {
              a.setLoop(THREE.LoopRepeat, Infinity);
              a.clampWhenFinished = false;
            } else {
              a.setLoop(THREE.LoopOnce, 1);
              a.clampWhenFinished = true;
            }
            a.play();
            testActionRef.current = a;
          }
        }
      }
    }
    if (sit) {
      sitWeight.current = ramp(sitWeight.current, plan.clip === "sitTalk" ? 1 : 0);
      const sw = sitWeight.current;
      if (sw > 0 && !sit.isRunning()) sit.reset().play();
      sit.setEffectiveWeight(sw);
      if (sw === 0 && sit.isRunning() && sit !== testActionRef.current) sit.stop();
    }
    const driveTransition = (
      action: THREE.AnimationAction | null,
      weight: { current: number },
      active: boolean,
    ) => {
      if (!action) return;
      weight.current = ramp(weight.current, active ? 1 : 0);
      const w = weight.current;
      if (w > 0 && !action.isRunning() && active) action.play();
      action.setEffectiveWeight(w);
      if (w === 0 && action.isRunning() && !active && action !== testActionRef.current) {
        action.stop();
      }
    };
    driveTransition(sitDown, downWeight, plan.clip === "sitDown");
    driveTransition(standUp, upWeight, plan.clip === "standUp");
    // While any sitting weight is up, the upright clips yield.
    const seated = Math.min(1, sitWeight.current + downWeight.current + upWeight.current);
    // ---- Clip tester weight ----
    // Ramps toward the fired clip while no sit override owns the
    // body, scaled by (1 - seated) so the sitting family always wins
    // a blend. While an override IS active the tester never writes a
    // core sit action (its drivers own those); a tester-only action
    // is simply muted. yieldEff damps Idle/Walk by the same factor.
    testWeight.current = ramp(testWeight.current, activeTest.current && !ov ? 1 : 0);
    const testEff = testWeight.current * (1 - seated);
    const effAction = testActionRef.current;
    if (effAction && !ov) {
      effAction.setEffectiveWeight(testEff);
      if (testWeight.current === 0 && !activeTest.current) {
        effAction.stop();
        testActionRef.current = null;
      }
    } else if (
      effAction &&
      ov &&
      effAction !== sit &&
      effAction !== sitDown &&
      effAction !== standUp
    ) {
      effAction.setEffectiveWeight(0);
    }
    // Walk and the resting clip are exempt from the yield (see
    // clipTesterYield in clips.ts): the sync above creates no tester
    // overlay for either, so damping them would freeze the figure.
    const yieldEff = clipTesterYield(activeTest.current, body.clips.walk, body.clips.idle, testEff);
    // ---- Body-controller turn clip ----
    const ctrl = f?.body && !ov && !activeTest.current && rootMotion ? f.body : null;
    const bt = ctrl?.turn ?? null;
    const turnAction = bt ? (byName.get(bt.clip) ?? null) : null;
    if (bt && turnAction) {
      if (turnActionRef.current !== turnAction) {
        if (turnActionRef.current) {
          turnActionRef.current.setEffectiveWeight(0);
          turnActionRef.current.stop();
        }
        turnAction.reset();
        turnAction.setLoop(THREE.LoopOnce, 1);
        turnAction.clampWhenFinished = true;
        turnAction.play();
        turnAction.paused = true; // scrubbed: the controller owns the clip clock
        turnActionRef.current = turnAction;
      }
      turnAction.time = bt.t * turnAction.getClip().duration;
      turnYawRef.current = bt.baked; // the pelvis yaw the pose carries (clip offset + swing)
    }
    turnWeight.current = ramp(turnWeight.current, bt && turnAction ? 1 : 0);
    const tw = turnWeight.current;
    if (turnActionRef.current) {
      turnActionRef.current.setEffectiveWeight(tw * (1 - seated));
      if (tw === 0 && !bt) {
        turnActionRef.current.stop();
        turnActionRef.current = null;
        turnYawRef.current = 0;
      }
    }
    // ---- Gait path (AgentFrame.gait: the City 3 walker) ----
    // Idle / Walk / Run from speed (gait.ts), one shared phase: Walk runs at the mixed stride's cycle rate
    // (reversed for a backpedal) and Run's clock is slaved to Walk's phase + the measured touchdown offset.
    // Frames without `gait` (the keeper, the bartender, Scout) keep the Idle/Walk code below unchanged.
    const runAction = actions.run;
    const gaitSpec = actions.gait;
    const gaitOn = !!(f?.gait && gaitSpec && runAction && walk && !ctrl && !ov && !activeTest.current);
    let runEff = 0;
    if (gaitOn && f && gaitSpec && runAction && walk) {
      const reverse = f.gait!.reverse;
      const g = gaitTargets(f.speed, gaitSpec);
      const moving = g.walk + g.run;
      walkWeight.current = approach(walkWeight.current, moving, delta, FADE_S);
      runMix.current = approach(runMix.current, reverse || moving === 0 ? 0 : g.run / moving, delta, FADE_S);
      const weight = walkWeight.current;
      const rm = runMix.current;
      const common = (1 - seated) * (1 - yieldEff);
      const rate = cycleRateFor(f.speed, rm, gaitSpec);
      if (weight > 0 && !walk.isRunning()) walk.reset().play();
      walk.timeScale = rate * gaitSpec.walkDuration * (reverse ? -1 : 1);
      walk.setEffectiveWeight(weight * (1 - rm) * common);
      runEff = weight * rm * common;
      if (runEff > 0) {
        if (!runAction.isRunning()) runAction.reset().play();
        const wp = walk.time / gaitSpec.walkDuration;
        runAction.time = runTimeForWalkPhase(wp, body.run!.phaseOffset, gaitSpec.runDuration);
        runAction.timeScale = rate * gaitSpec.runDuration;
      } else if (runAction.isRunning()) {
        runAction.stop();
      }
      runAction.setEffectiveWeight(runEff);
      if (idle) idle.setEffectiveWeight((1 - weight) * common);
      if (weight === 0 && walk.isRunning()) walk.stop();
    } else if (runAction && runMix.current > 0) {
      // Leaving the gait path (tester fired, override mounted): Run hands back to the Idle/Walk layer.
      runMix.current = 0;
      if (runAction !== testActionRef.current) {
        runAction.setEffectiveWeight(0);
        runAction.stop();
      }
    }
    if (walk && !gaitOn) {
      const testerWalk = activeTest.current === body.clips.walk;
      const walking = f?.state === "walk";
      const useBody = ctrl !== null && !testerWalk;
      const target = testerWalk || walking ? 1 : 0;
      const w = walkWeight.current;
      if (useBody) {
        walkWeight.current = ctrl.walkWeight; // the controller already smooths it by speed
      } else if (w !== target) {
        const step = delta / FADE_S;
        walkWeight.current =
          target > w ? Math.min(target, w + step) : Math.max(target, w - step);
      }
      const weight = walkWeight.current;
      if (weight > 0 && !walk.isRunning()) walk.reset().play();
      walk.setEffectiveWeight(weight * (1 - seated) * (1 - yieldEff) * (1 - tw));
      if (idle) idle.setEffectiveWeight((1 - weight) * (1 - seated) * (1 - yieldEff) * (1 - tw));
      // Feet match ground speed: the cycle plays at its natural rate
      // when the crowd moves at this body's measured walkSpeed
      // (bodies.ts), scaled proportionally and clamped to a modest
      // band. A tester-fired Walk plays at its natural rate instead —
      // the crowd is standing still and the extraction below keeps
      // the traveling cycle over its point.
      walk.timeScale = testerWalk
        ? 1
        : useBody
          ? ctrl.walkTimeScale
          : THREE.MathUtils.clamp((f ? f.speed : 0) / body.walkSpeed, 0.7, 1.4);
      // Fully idle again: stop the Walk action so a resting bot costs
      // no clip evaluation beyond its Idle sway.
      if (weight === 0 && walk.isRunning()) walk.stop();
    }
    // The walker clamps its step to 0.1 s; a gait-driven figure's clips advance by the same clamped dt so the
    // cycle stays in step with the travel on slow frames (feet do not run ahead of the body on a hitch).
    mixer.update(gaitOn ? Math.min(delta, 0.1) : delta);
    if (renderedReadyRef) renderedReadyRef.current = true;
    if (playingClipRef) {
      const action = testActionRef.current;
      playingClipRef.current = action?.isRunning() && action.getEffectiveWeight() > 0
        ? action.getClip().name : null;
    }
    // Root-motion extraction (see rootMotion above): cancel the
    // posed hips' horizontal travel on the skeleton's parent node.
    // The Y (bob) is left in the pose — it is what grounds the feet.
    // Clips without hips translation (everything but Walk) evaluate
    // to a zero delta here, so sitting and tester poses are untouched.
    if (rootMotion) {
      const d = rootMotionDelta(
        rootMotion.hips.position,
        rootMotion.hipsRest,
        rootMotion.parentScale,
        rootMotion.parentQuat,
        rmDelta.current,
      );
      rootMotion.parent.position.copy(rootMotion.parentRest).sub(d);
      // Cancel the pelvis yaw the turn clip has baked in so far (the group already carries it as heading).
      rootMotion.parent.quaternion
        .setFromAxisAngle(Y_AXIS, -turnYawRef.current * tw)
        .multiply(rootMotion.parentQuat);
    }
    // Vertical guard: a baked Walk cycle can carry a large vertical
    // hips ramp under its bob (Summer's sinks ~1.26 m per cycle and
    // snaps back at the loop — the visible plunge into the deck). The
    // extraction above leaves Y in the pose by design, so counter only
    // the deviation beyond the bob band, on the figure group: the bob
    // passes, the ramp is floored. Body-layer locomotion only — sit
    // overrides and tester clips own their own heights.
    // A held Run (the walk HUD's Run toggle) or tester Walk is locomotion, not a pose that owns its height: ground it
    // too (Run with its flight phase: the Run clip's cycle minimum, as on the gait path), or it floats/sinks.
    const testLoco = activeTest.current === "Run" || activeTest.current === body.clips.walk;
    if (testLoco && activeTest.current === "Run" && body.run) runEff = Math.max(runEff, testWeight.current);
    if (rootMotion && !ov && (!activeTest.current || testLoco)) {
      const hw = hipsWorldTmp.current;
      rootMotion.hips.getWorldPosition(hw);
      const dy = grp.worldToLocal(hw).y - rootMotion.restHipsLocalY;
      let drop = verticalExcess(dy, HIPS_Y_BAND);
      // Run was baked with its hips drop stripped: its stance foot rides body.run.footLift above Walk's.
      if (runEff > 0 && body.run) drop += body.run.footLift * runEff;
      // Foot grounding (grounding.ts) replaces both corrections whenever the rig has contact joints: lower the
      // figure until its lowest contact point meets the floor. The sitting family keeps the hips guard (its
      // seat height belongs to the pose), blended by the seated weight.
      if (contacts.length > 0) {
        // grounding.ts works in the scene's own frame (unscaled): x bodyScale turns its offset into world metres.
        const ground = groundingOffset(soleClearance(contacts, scene), runMin, runEff) * bodyScale;
        drop = drop * seated + ground * (1 - seated);
      }
      grp.position.y = baseY - drop;
    }
    // Foot lock (footLock.ts), last of the leg edits: only the City 3 walker's gait path, never while a sit override,
    // a tester clip or the body controller owns the pose (their feet are not travelling over the ground).
    if (gaitOn && f && footLock.usable && footLockEnabled()) {
      footLock.update(grp, scene, f.speed, delta, baseY - grp.position.y);
    } else if (footLock.usable) {
      footLock.reset();
    }
    contactShadows.update(scene, grp, baseY, !!f?.gait && !ov && !activeTest.current && seated === 0);
    // Head-bone stream for the ride camera: written AFTER the mixer
    // and every position adjustment above, so the camera anchors on
    // the head as it actually renders this frame (bob, sway and seat
    // drop included). One frame of lag vs the camera rig is fine —
    // the rig damps its pose anyway.
    if (headPoseRef && headBone) {
      const hw = headWorldTmp.current;
      headBone.getWorldPosition(hw);
      const cur = headPoseRef.current;
      if (cur) {
        cur[0] = hw.x;
        cur[1] = hw.y;
        cur[2] = hw.z;
      } else {
        headPoseRef.current = [hw.x, hw.y, hw.z];
      }
    }
  });

  return (
    <group ref={group} position={home}>
      <primitive object={scene} position={[0, fit.lift, 0]} />
      <primitive object={contactShadows.group} />
    </group>
  );
}
