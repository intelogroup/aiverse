import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { CastFigure } from "./CastFigure";
import { BODY_MAGE, BODY_REMY } from "./bodies";
import { ClipTestState } from "./clips";
import {
  KEEPER_HOME_HEADING,
  KEEPER_POS,
  PATROL_CONFIG,
  PATROL_STOPS,
  createKeeper,
  keeperGesture,
  stepKeeper,
  type KeeperState,
} from "./keeper";
import type { AgentFrame } from "./locomotion";
import type { WalkColliders } from "./walkColliders";
import { newWalkerFrame, useWalkWorld, writeWalkerFrame } from "./walkerBody";
import {
  makeWalker,
  moveToIntent,
  step,
  type WalkInput,
  type WalkerState,
} from "./walker";

// BazaarLife — the first residents of City 3 (which otherwise places no
// cast at all): the stall keeper and the patrol, driven the same way
// CityWalker drives the walk bot — per-frame AgentFrames into
// CastFigure — but self-contained: no Agora bodyController, no crowd.
//
// The keeper (Mage body: the robe-and-hat silhouette reads as a market
// vendor, and he is nobody else in the scene — Summer is the bot,
// Remy walks the patrol) stands idle before stall-0. keeper.ts owns
// the trigger: when a mover (the walk bot, the patrol) comes within
// reach he turns to face them and plays the catalog "Talking" loop
// through a ClipTestState, exactly the channel the Embody panel's clip
// tester uses; when they leave, he settles back to Idle and his
// resting facing.
//
// The patrol (Remy) walks a circuit of stall fronts on the same
// walker step + capsule world the bot uses, pausing at each — longest
// at the keeper's stall, inside his trigger radius, so the two hold
// their conversation whether or not anyone is driving the bot.

/** A tapped Bazaar resident (Mobile Phase 2 figure card / fly-to). */
export interface BazaarFigureTap {
  id: "keeper" | "patrol";
  name: string;
  x: number;
  z: number;
}

export function BazaarLife({
  getMeshes,
  walk,
  botPosRef,
  keeperVoiceRef,
  onFigure,
  onFigureLong,
  longPressRef,
}: {
  /** Visual/camera meshes: the raycast fallback world if the collision GLB failed to load. */
  getMeshes: () => THREE.Mesh[];
  /** The walker's collision list (capsule world), shared with CityWalker. */
  walk?: WalkColliders;
  /** The walk bot's latest position, published by CityWalker (null while nobody is walking). */
  botPosRef: { current: { x: number; z: number } | null };
  /** True while the Mage's voice line is playing (plazaTts): his Talking clip follows it, so he never talks in silence. */
  keeperVoiceRef?: { current: boolean };
  /**
   * Mobile Phase 2: tap / double-tap on a resident (touch spectator).
   * Handlers attach only when provided, so the desktop path gains no
   * raycast targets. Clicks carry R3F's delta (pointer travel in px);
   * the tap rule (<10 px, plan §1) is applied here.
   */
  onFigure?: (fig: BazaarFigureTap, dbl: boolean) => void;
  /**
   * Mobile Phase 4: long-press on a resident (≥500 ms, plan §1) opens
   * its context sheet. The press also stamps the shared ref so the
   * stage's own long-press listener stands down, and the click that
   * follows the press is swallowed here.
   */
  onFigureLong?: (fig: BazaarFigureTap) => void;
  longPressRef?: { current: number };
}) {
  // Same world stack as CityWalker: capsule shapecast over the collision
  // GLBs, raycast over the visual meshes only if collision failed.
  const staticWorld = useWalkWorld(getMeshes, walk);
  const world = useMemo(() => walk?.actors.wrapWorld(staticWorld, "patrol") ?? staticWorld, [staticWorld, walk]);
  useEffect(() => () => { walk?.actors.remove("patrol"); walk?.actors.remove("keeper"); }, [walk]);

  const keeperClips = useMemo(() => new ClipTestState(), []);
  const keeper = useRef<KeeperState | null>(null);
  if (keeper.current === null) keeper.current = createKeeper(KEEPER_HOME_HEADING);
  const keeperFrames = useRef<AgentFrame[]>([newWalkerFrame(KEEPER_POS[0], KEEPER_POS[1], KEEPER_HOME_HEADING)]);
  const keeperGroup = useRef<THREE.Group>(null);
  const keeperY = useRef<number | null>(null);

  const patrol = useRef<WalkerState | null>(null);
  const patrolDriver = useRef({ stop: 0, dwell: PATROL_STOPS[0].dwell });
  const patrolFrames = useRef<AgentFrame[]>([newWalkerFrame(PATROL_STOPS[0].pos[0], PATROL_STOPS[0].pos[1], PATROL_STOPS[0].face)]);
  const patrolGroup = useRef<THREE.Group>(null);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    const ks = keeper.current;
    if (!ks) return; // initialized above, before the first frame
    const worldUsable = getMeshes().length > 0 && world.kind() !== "pending";

    // ---- patrol ----
    if (worldUsable) {
      let s = patrol.current;
      if (!s) {
        const [x, z] = PATROL_STOPS[0].pos;
        const g = world.groundY(x, z, 20);
        if (g !== null) {
          s = patrol.current = makeWalker(x, g, z, PATROL_STOPS[0].face);
        }
      }
      if (s) {
        const drv = patrolDriver.current;
        const stopDef = PATROL_STOPS[drv.stop];
        if (drv.dwell > 0) {
          drv.dwell -= dt;
          const input: WalkInput = { forward: 0, strafe: 0, turn: 0, run: false, faceHeading: stopDef.face };
          step(s, input, dt, world, PATROL_CONFIG);
          if (drv.dwell <= 0) drv.stop = (drv.stop + 1) % PATROL_STOPS.length;
        } else {
          const { input, arrived } = moveToIntent(s, stopDef.pos, 0.35);
          step(s, input, dt, world, PATROL_CONFIG);
          if (arrived) drv.dwell = stopDef.dwell;
        }
        walk?.actors.publishWalker("patrol", s, PATROL_CONFIG.radius);
        writeWalkerFrame(patrolFrames.current[0], s);
        if (patrolGroup.current) patrolGroup.current.position.y = s.y;
      }
      if (keeperY.current === null) {
        const g = world.groundY(KEEPER_POS[0], KEEPER_POS[1], 20);
        if (g !== null) keeperY.current = g;
      }
    }
    if (keeperGroup.current) keeperGroup.current.position.y = keeperY.current ?? 0.2;
    if (keeperY.current !== null) walk?.actors.publishWalker("keeper", { x: KEEPER_POS[0], y: keeperY.current, z: KEEPER_POS[1], vx: 0, vz: 0 }, 0.4, 1.7, false);

    // ---- keeper trigger ----
    const movers: [number, number][] = [];
    const bot = botPosRef.current;
    if (bot) movers.push([bot.x, bot.z]);
    if (patrol.current) movers.push([patrol.current.x, patrol.current.z]);
    const ev = stepKeeper(ks, dt, KEEPER_POS, movers);
    // Someone walks up: he turns to them and waves at once (a greeting needs no audio). He TALKS only while his voice line
    // actually plays (keeperVoiceRef, set by the speech runner): with nobody speaking (the patrol, no sound consent, a line
    // that could not be made) he never gestures talking in silence.
    const g = keeperGesture(keeperClips.current, keeperVoiceRef?.current ?? false, ev.entered);
    if (g === "clear") keeperClips.clear();
    else if (g) keeperClips.fire(g);
    const kf = keeperFrames.current[0];
    kf.heading = ks.heading;
  });

  const longPressTimer = useRef<number | null>(null);
  const longPressFiredAt = useRef(0);
  const figureHandlers = (fig: () => BazaarFigureTap) =>
    onFigure
      ? {
          onClick: (e: ThreeEvent<MouseEvent>) => {
            if (e.delta > 10) return; // a drag, not a tap (plan §1)
            if (Date.now() - longPressFiredAt.current < 800) return; // the long-press's own click
            e.stopPropagation();
            onFigure(fig(), false);
          },
          onDoubleClick: (e: ThreeEvent<MouseEvent>) => {
            e.stopPropagation();
            onFigure(fig(), true);
          },
          onPointerDown: onFigureLong
            ? () => {
                if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
                longPressTimer.current = window.setTimeout(() => {
                  longPressFiredAt.current = Date.now();
                  if (longPressRef) longPressRef.current = longPressFiredAt.current;
                  onFigureLong(fig());
                }, 500);
              }
            : undefined,
          onPointerUp: onFigureLong
            ? () => {
                if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
                longPressTimer.current = null;
              }
            : undefined,
          onPointerLeave: onFigureLong
            ? () => {
                if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
                longPressTimer.current = null;
              }
            : undefined,
        }
      : {};

  return (
    <>
      <group ref={keeperGroup} {...figureHandlers(() => ({ id: "keeper", name: "The Keeper", x: KEEPER_POS[0], z: KEEPER_POS[1] }))}>
        <Suspense fallback={null}>
          <CastFigure
            framesRef={keeperFrames}
            index={0}
            baseY={0}
            home={[KEEPER_POS[0], 0, KEEPER_POS[1]]}
            body={BODY_MAGE}
            clipTester={keeperClips}
          />
        </Suspense>
      </group>
      <group
        ref={patrolGroup}
        {...figureHandlers(() => {
          const p = patrolFrames.current[0]?.position ?? [PATROL_STOPS[0].pos[0], PATROL_STOPS[0].pos[1]];
          return { id: "patrol", name: "Remy", x: p[0], z: p[1] };
        })}
      >
        <Suspense fallback={null}>
          <CastFigure
            framesRef={patrolFrames}
            index={0}
            baseY={0}
            home={[PATROL_STOPS[0].pos[0], 0, PATROL_STOPS[0].pos[1]]}
            body={BODY_REMY}
          />
        </Suspense>
      </group>
    </>
  );
}
