import { useEffect, useMemo, useRef, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import { Html, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { verticalExcess, type AgentFrame } from "./locomotion";
import type { FigureOverride, SitPhase } from "./embody";
import { BODY_CAST, sitClipForPhase, type BodyDef } from "./bodies";
import { CLIP_CATALOG, clipDef, type ClipTestState } from "./clips";

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
// "Idle" (a subtle sway), "SittingTalking" (a 44 s seated loop,
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

// Nameplate scaling (drei Html distanceFactor): the element renders
// as if its CSS pixels were world units scaled by
// distanceFactor / canvasHeightPx — at 10 and a ~1000 px-tall canvas,
// 100 px ≈ 1 m in the world at ANY camera distance. The nameplate's
// 30 px name therefore stands ≈ 0.30 m tall in world space (about a
// quarter of the 1.25 m figure): proportionate from the Agora camera
// (~24 m) and shrunk with its bot from the City camera (~114 m)
// instead of wallpapering the streets at constant screen size.
// One-line tuning knob for Jim's eye.
export const NAMEPLATE_DISTANCE_FACTOR = 10;

// The Walk cycle's natural rate is per body (bodies.ts walkSpeed —
// measured from the baked cycle's stance feet, not a global guess).

// Per-agent body colors: each bot is painted its own color (Jim's call —
// red, yellow, blue and family), with the face screen glowing a lightened
// version of the same hue. The pick is a stable hash of the roster label
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

export function accentForFigure(label: string | undefined, index: number): string {
  const s = label ?? String(index);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return ACCENT_PALETTE[h % ACCENT_PALETTE.length];
}
// Time for the walk weight to ramp 0→1 (the Idle↔Walk crossfade).
const FADE_S = 0.25;

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
  label,
  hidden = false,
  body = BODY_CAST,
  clipTester,
}: {
  /** The body this member wears (bodies.ts registry). */
  body?: BodyDef;
  /**
   * Embody panel clip tester (clips.ts): when present (cast[0] in
   * embody mode), the figure blends toward the fired catalog clip —
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
   * body or label — so the first-person view is through its eyes, never
   * barred by its own shell. Wide and Follow keep it fully visible.
   */
  hidden?: boolean;
  /** World Y of the ground this figure walks on (frames carry only XZ). */
  baseY?: number;
  /** Stand-here position until the first crowd frame arrives. */
  home: [number, number, number];
  /** Agent name shown on the floating label (roster name, as elsewhere). */
  label?: string;
}) {
  const gltf = useGLTF(body.url);
  const group = useRef<THREE.Group>(null);

  // Own skeleton + own scene graph per cast member.
  const scene = useMemo(() => skeletonClone(gltf.scene), [gltf]);

  // Paint this figure in its agent color. Materials are shared across
  // clones, so every tinted material is cloned first. Body parts take the
  // color at their ladder shade; the screen glows a lightened version.
  useMemo(() => {
    const accent = new THREE.Color(accentForFigure(label, index));
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
  }, [scene, label, index]);

  // No scaling — the export is authored at 1.25 m with feet at y = 0.
  // Measure anyway so the floor lift and label height track real bounds.
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
      restHipsLocalY: restWorld.y + fit.lift,
    };
  }, [scene, fit]);
  const rmDelta = useRef(new THREE.Vector3());
  const hipsWorldTmp = useRef(new THREE.Vector3());

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
    return { idle, walk, sit, sitDown, standUp, byName };
  }, [gltf, mixer, body]);

  // Current Walk blend weight (0 = pure Idle, 1 = pure Walk).
  const walkWeight = useRef(0);
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

  useEffect(() => {
    return () => {
      mixer.stopAllAction();
    };
  }, [mixer]);

  useFrame((_, delta) => {
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
    // ---- Clip tester sync (Embody panel, cast[0] only) ----
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
    const yieldEff = activeTest.current === body.clips.walk ? 0 : testEff;
    if (walk) {
      const testerWalk = activeTest.current === body.clips.walk;
      const walking = f?.state === "walk";
      const target = testerWalk || walking ? 1 : 0;
      const w = walkWeight.current;
      if (w !== target) {
        const step = delta / FADE_S;
        walkWeight.current =
          target > w ? Math.min(target, w + step) : Math.max(target, w - step);
      }
      const weight = walkWeight.current;
      if (weight > 0 && !walk.isRunning()) walk.reset().play();
      walk.setEffectiveWeight(weight * (1 - seated) * (1 - yieldEff));
      if (idle) idle.setEffectiveWeight((1 - weight) * (1 - seated) * (1 - yieldEff));
      // Feet match ground speed: the cycle plays at its natural rate
      // when the crowd moves at this body's measured walkSpeed
      // (bodies.ts), scaled proportionally and clamped to a modest
      // band. A tester-fired Walk plays at its natural rate instead —
      // the crowd is standing still and the extraction below keeps
      // the traveling cycle over its point.
      walk.timeScale = testerWalk
        ? 1
        : THREE.MathUtils.clamp((f ? f.speed : 0) / body.walkSpeed, 0.7, 1.4);
      // Fully idle again: stop the Walk action so a resting bot costs
      // no clip evaluation beyond its Idle sway.
      if (weight === 0 && walk.isRunning()) walk.stop();
    }
    mixer.update(delta);
    // Root-motion extraction (see rootMotion above): cancel the
    // posed hips' horizontal travel on the skeleton's parent node.
    // The Y (bob) is left in the pose — it is what grounds the feet.
    // Clips without hips translation (everything but Walk) evaluate
    // to a zero delta here, so sitting and tester poses are untouched.
    if (rootMotion) {
      const d = rmDelta.current
        .copy(rootMotion.hips.position)
        .sub(rootMotion.hipsRest)
        .applyQuaternion(rootMotion.parentQuat);
      d.y = 0;
      rootMotion.parent.position.copy(rootMotion.parentRest).sub(d);
    }
    // Vertical guard: a baked Walk cycle can carry a large vertical
    // hips ramp under its bob (Summer's sinks ~1.26 m per cycle and
    // snaps back at the loop — the visible plunge into the deck). The
    // extraction above leaves Y in the pose by design, so counter only
    // the deviation beyond the bob band, on the figure group: the bob
    // passes, the ramp is floored. Body-layer locomotion only — sit
    // overrides and tester clips own their own heights.
    if (rootMotion && !ov && !activeTest.current) {
      const hw = hipsWorldTmp.current;
      rootMotion.hips.getWorldPosition(hw);
      const dy = grp.worldToLocal(hw).y - rootMotion.restHipsLocalY;
      grp.position.y = baseY - verticalExcess(dy, HIPS_Y_BAND);
    }
  });

  // Leader-line nameplate (Jim's callout design): a dot pinned to the
  // head top (the Html anchor, container centre), a thin oblique line
  // rising out of it, then a horizontal segment with the name sitting
  // on it — drawn in the figure's own accent at low opacity. The whole
  // callout is ONE Html element under distanceFactor, so it scales
  // with distance as a unit (NAMEPLATE_DISTANCE_FACTOR). Unmounted
  // while `hidden` (Ride), like the pill it replaces.
  const tagAccent = accentForFigure(label, index);
  return (
    <group ref={group} position={home}>
      <primitive object={scene} position={[0, fit.lift, 0]} />
      {label && !hidden && (
        <Html
          center
          position={[0, fit.height + 0.02, 0]}
          distanceFactor={NAMEPLATE_DISTANCE_FACTOR}
          zIndexRange={[30, 0]}
        >
          <div className="w-cast-tag" style={{ pointerEvents: "none" }}>
            <svg
              className="w-cast-tag-lines"
              viewBox="0 0 460 150"
              width={460}
              height={150}
              aria-hidden="true"
            >
              <polyline
                points="230,75 268,30 448,30"
                fill="none"
                stroke={tagAccent}
                strokeWidth={3}
                strokeOpacity={0.75}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              <circle cx={230} cy={75} r={5.5} fill={tagAccent} fillOpacity={0.9} />
            </svg>
            <div className="w-cast-name">{label}</div>
          </div>
        </Html>
      )}
    </group>
  );
}
