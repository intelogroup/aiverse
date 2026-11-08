// TeaBartender — the Tea House bartender (bartender.ts holds the pure trigger/placement). Remy stands behind the bar, turns to
// whoever comes up to it, waves, and greets them out loud in the "Hugh" voice. Like the stall keeper he TALKS only while his
// line is actually playing (keeperGesture), and the line never waits on the speech engine (prepareLine: warm cache -> live ->
// pre-rendered clip). Without sound consent he still turns and waves; he never mouths a silent line.
import { useFrame } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef } from "react";
import { CastFigure } from "./CastFigure";
import { BODY_REMY } from "./bodies";
import { boxesMesh } from "./capsuleWorld";
import { ClipTestState } from "./clips";
import { keeperGesture } from "./keeper";
import type { AgentFrame } from "./locomotion";
import { VOICE_BARTENDER } from "./phononTts";
import { playLine, prepareLine } from "./plazaTts";
import type { SoundDirector } from "./soundDirector";
import type { WalkColliders } from "./walkColliders";
import { newWalkerFrame } from "./walkerBody";
import {
  BARTENDER_COLLIDER,
  BARTENDER_FLOOR_Y,
  BARTENDER_PLATFORM_H,
  BARTENDER_PLATFORM_HALF,
  BARTENDER_HOME_HEADING,
  BARTENDER_POS,
  BartenderGreeter,
  type BartenderLine,
} from "./bartender";

type PosRef = { current: { x: number; z: number } | null };

export interface BartenderLogEntry {
  line: string;
  /** How it was spoken: "live" (cache/synth), "clip", "silent" (no consent / nothing playable). */
  shape: string;
  seconds: number;
  atMs: number;
}

export function TeaBartender({
  visitors,
  walk,
  getDirector,
}: {
  /** Everyone who can be greeted: the player's bot, Scout, ... (null while absent). */
  visitors: PosRef[];
  walk?: WalkColliders;
  /** The live sound director (it is re-created on remount; never hold an old one). */
  getDirector: () => SoundDirector | null;
}) {
  const greeter = useMemo(() => new BartenderGreeter(), []);
  const clips = useMemo(() => new ClipTestState(), []);
  const frames = useRef<AgentFrame[]>([newWalkerFrame(BARTENDER_POS[0], BARTENDER_POS[1], BARTENDER_HOME_HEADING)]);
  const voice = useRef(false);
  const log = useRef<BartenderLogEntry[]>([]);
  const voiceTimer = useRef<number | null>(null);

  // His body is solid: nobody walks through him behind the bar.
  useEffect(() => {
    if (!walk) return;
    const m = boxesMesh([BARTENDER_COLLIDER], [0, 0], "npc:bartender");
    if (m) walk.set("npc:bartender", [m]);
    return () => walk.drop("npc:bartender");
  }, [walk]);

  useEffect(() => () => {
    if (voiceTimer.current !== null) window.clearTimeout(voiceTimer.current);
  }, []);

  const speak = (line: BartenderLine) => {
    const director = getDirector();
    const t0 = performance.now();
    if (!director || director.consent !== "granted") {
      log.current.push({ line: line.id, shape: "silent", seconds: 0, atMs: 0 });
      return;
    }
    void prepareLine(director, line.text, VOICE_BARTENDER, `/assets/tts/lines/${line.id}.mp3`).then((prepared) => {
      const seconds = playLine(director, prepared, { x: BARTENDER_POS[0], z: BARTENDER_POS[1] }, "bartender");
      log.current.push({ line: line.id, shape: prepared.shape, seconds, atMs: Math.round(performance.now() - t0) });
      if (seconds <= 0) return;
      voice.current = true;
      if (voiceTimer.current !== null) window.clearTimeout(voiceTimer.current);
      voiceTimer.current = window.setTimeout(() => {
        voice.current = false;
        voiceTimer.current = null;
      }, seconds * 1000);
    });
  };

  // ?walkDebug=1 / ?agent=1 checks: what he is doing.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (!q.has("walkDebug") && !q.has("agent") && !q.has("ttsDebug")) return;
    const w = window as unknown as Record<string, unknown>;
    w.__bartender = {
      info: () => ({ engaged: greeter.engaged, heading: +greeter.heading.toFixed(3), voice: voice.current, clip: clips.current, log: [...log.current] }),
    };
    return () => { delete w.__bartender; };
  }, [greeter, clips]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    const movers: [number, number][] = [];
    for (const v of visitors) {
      const p = v.current;
      if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) movers.push([p.x, p.z]);
    }
    const step = greeter.step(dt, movers);
    if (step.greet) speak(step.greet);
    const g = keeperGesture(clips.current, voice.current, step.greet !== null);
    if (g === "clear") clips.clear();
    else if (g) clips.fire(g);
    frames.current[0].heading = greeter.heading;
  });

  return (
    <>
      {/* a duckboard only where a bar needs one (bartender.ts): plain wood, hidden from the room by the counter */}
      {BARTENDER_PLATFORM_H > 0 ? <mesh position={[BARTENDER_POS[0], BARTENDER_FLOOR_Y + BARTENDER_PLATFORM_H / 2, BARTENDER_POS[1]]} receiveShadow>
        <boxGeometry args={[BARTENDER_PLATFORM_HALF[0] * 2, BARTENDER_PLATFORM_H, BARTENDER_PLATFORM_HALF[1] * 2]} />
        <meshStandardMaterial color="#5a3d26" roughness={0.85} />
      </mesh> : null}
      <group position={[0, BARTENDER_FLOOR_Y + BARTENDER_PLATFORM_H, 0]}>
      <Suspense fallback={null}>
        <CastFigure
          framesRef={frames}
          index={0}
          baseY={0}
          home={[BARTENDER_POS[0], 0, BARTENDER_POS[1]]}
          body={BODY_REMY}
          clipTester={clips}
        />
      </Suspense>
      </group>
    </>
  );
}

