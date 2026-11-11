// RemoteCast — draws the agents whose bodies live on the server (apps/sim), from the viewer stream. The figure, its animation, foot
// lock and scale are the same CastFigure everything else uses; only the driver differs: instead of a local walker it is fed
// AgentFrames interpolated from the server's poses (remoteFrames.ts). Each body also registers as a mover so the human walker
// collides with it.
//
// Departures linger: when the stream drops a body (visit end, pause, kill — the sim just stops sending it) the figure does not
// vanish the same frame. It stays mounted, settles to Idle, and dissolves over ~1.5 s (dissolve.ts); a body that appears runs
// the same ramp backwards and materializes. The figures map below is therefore the render source of truth, not the stream's
// live list — it holds live bodies plus the ones still burning away.
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { Suspense, useMemo, useRef, useState } from "react";
import type * as THREE from "three";
import { BODIES, BODY_REMY } from "./bodies";
import { CastFigure } from "./CastFigure";
import { ClipTestState } from "./clips";
import { createDissolve, type Dissolve } from "./dissolve";
import type { AgentFrame } from "./locomotion";
import { RemoteBodies, writeRemoteFrame } from "./remoteFrames";
import { useWorldStream } from "./useWorldStream";
import { newWalkerFrame } from "./walkerBody";
import type { WalkColliders } from "./walkColliders";

const BODY_HEIGHT = 1.7;
const BODY_RADIUS = 0.4;
/** Movers are republished at this period (s); the registry's TTL is 2 s. */
const PUBLISH_EVERY_S = 0.1;

interface Figure {
  group: THREE.Group | null;
  clips: ClipTestState;
  /** The last clip the server reported, so a one-shot that expired locally is not re-fired while the server still says it. */
  lastClip: string | null;
  /** The body key this figure wears — kept on the figure so a leaving body still renders after the stream drops it. */
  body: string;
  /** This body's materialize/dissolve ramp (dissolve.ts). Never shared between figures. */
  dissolve: Dissolve;
  /** True once the stream has dropped the body: it lingers, dissolving, until the ramp completes. */
  leaving: boolean;
  /** Follows the body at head height; carries the speech bubble. */
  bubble: THREE.Group | null;
}

export function RemoteCast({ walk }: { walk?: WalkColliders }) {
  const bodies = useMemo(() => new RemoteBodies(), []);
  useWorldStream(true, bodies);

  const frames = useRef<AgentFrame[]>([]);
  const figures = useRef(new Map<number, Figure>());
  /** What React renders: live bodies plus bodies still dissolving out. */
  const [cast, setCast] = useState<{ n: number; body: string }[]>([]);
  const publishAt = useRef(0);
  /** Body number -> the line over its head (null when none). Changes only when a line starts or expires. */
  const [said, setSaid] = useState<Record<number, string>>({});

  useFrame((_, delta) => {
    const nowS = performance.now() / 1000;
    const dt = Math.min(delta, 0.1);
    let castChanged = false;

    // Sync the figure set with the stream. Appearing bodies materialize
    // (their Dissolve starts at 1 and damps to 0); dropped bodies are marked
    // leaving, lose their mover at once (a dissolving ghost does not
    // collide), settle to Idle, and unmount when the ramp completes. A body
    // that reappears mid-leave cancels it.
    const live = new Map(bodies.list().map((b) => [b.n, b.body] as const));
    for (const [n, bodyKey] of live) {
      let fig = figures.current.get(n);
      if (fig && fig.body !== bodyKey) {
        // The stream reused the slot for a different body: retire the old figure whole.
        figures.current.delete(n);
        delete frames.current[n];
        fig = undefined;
        castChanged = true;
      }
      if (!fig) {
        fig = { group: null, clips: new ClipTestState(), lastClip: null, body: bodyKey, dissolve: createDissolve(), leaving: false, bubble: null };
        figures.current.set(n, fig);
        const p = bodies.sample(n, Infinity)!; // draw the first frame where it is, not at the origin
        frames.current[n] = writeRemoteFrame(newWalkerFrame(p.x, p.z, p.heading), p);
        castChanged = true;
      } else if (fig.leaving) {
        fig.leaving = false;
        fig.dissolve.arrive();
      }
    }
    for (const [n, fig] of figures.current) {
      if (!live.has(n) && !fig.leaving) {
        fig.leaving = true;
        fig.dissolve.leave();
        walk?.actors.remove(`remote-${n}`);
        const f = frames.current[n];
        if (f) {
          f.speed = 0;
          f.state = "idle";
          f.velocity[0] = 0;
          f.velocity[1] = 0;
        }
      }
      if (fig.dissolve.update(dt) && fig.leaving) {
        figures.current.delete(n);
        delete frames.current[n];
        castChanged = true;
      }
    }
    if (castChanged) setCast([...figures.current].map(([n, f]) => ({ n, body: f.body })));

    const nowMs = nowS * 1000, next: Record<number, string> = {};
    for (const n of figures.current.keys()) { const line = bodies.bubble(n, nowMs); if (line) next[n] = line; }
    setSaid((prev) => {
      const a = Object.keys(prev), b = Object.keys(next);
      return a.length === b.length && b.every((k) => prev[Number(k)] === next[Number(k)]) ? prev : next;
    });

    const t = bodies.renderTime(nowS);
    if (t === null) return;
    const publish = nowS - publishAt.current >= PUBLISH_EVERY_S;
    if (publish) publishAt.current = nowS;
    for (const b of bodies.list()) {
      const fig = figures.current.get(b.n);
      const p = bodies.sample(b.n, t);
      if (!fig || !p) continue;
      writeRemoteFrame((frames.current[b.n] ??= newWalkerFrame(p.x, p.z, p.heading)), p);
      if (fig.group) fig.group.position.y = p.y;
      fig.bubble?.position.set(p.x, 2.1, p.z); // the parent group already sits at p.y
      if (p.clip !== fig.lastClip) {
        fig.lastClip = p.clip;
        if (p.clip) fig.clips.fire(p.clip); else fig.clips.clear();
      }
      if (publish && walk) {
        walk.actors.publishWalker(`remote-${b.n}`, { x: p.x, y: p.y, z: p.z, vx: Math.sin(p.heading) * p.speed, vz: Math.cos(p.heading) * p.speed }, BODY_RADIUS, BODY_HEIGHT, true);
      }
    }
  }, -1);

  return (
    <>
      {cast.map(({ n, body }) => {
        const fig = figures.current.get(n);
        if (!fig) return null;
        return (
          <group key={n} ref={(g) => { fig.group = g; }}>
            <Suspense fallback={null}>
              <CastFigure framesRef={frames} index={n} baseY={0} home={[0, 0, 0]} body={BODIES[body] ?? BODY_REMY} clipTester={fig.clips} dissolve={fig.dissolve} />
            </Suspense>
            <group ref={(g) => { fig.bubble = g; }}>
              {said[n] ? <Html center><span className="w-said" data-testid="remote-said">{said[n]}</span></Html> : null}
            </group>
          </group>
        );
      })}
    </>
  );
}
