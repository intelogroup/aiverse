// RemoteCast — draws the agents whose bodies live on the server (apps/sim), from the viewer stream. The figure, its animation, foot
// lock and scale are the same CastFigure everything else uses; only the driver differs: instead of a local walker it is fed
// AgentFrames interpolated from the server's poses (remoteFrames.ts). Each body also registers as a mover so the human walker
// collides with it.
import { useFrame } from "@react-three/fiber";
import { Suspense, useMemo, useRef, useState } from "react";
import type * as THREE from "three";
import { BODIES, BODY_REMY } from "./bodies";
import { CastFigure } from "./CastFigure";
import { ClipTestState } from "./clips";
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
}

export function RemoteCast({ walk }: { walk?: WalkColliders }) {
  const bodies = useMemo(() => new RemoteBodies(), []);
  useWorldStream(true, bodies);

  const frames = useRef<AgentFrame[]>([]);
  const figures = useRef(new Map<number, Figure>());
  const [rev, setRev] = useState(0);
  const seenRev = useRef(0);
  const publishAt = useRef(0);

  const list = bodies.list();
  for (const b of list) {
    if (!figures.current.has(b.n)) figures.current.set(b.n, { group: null, clips: new ClipTestState(), lastClip: null });
    if (!frames.current[b.n]) {
      const p = bodies.sample(b.n, Infinity)!; // draw the first frame where it is, not at the origin
      frames.current[b.n] = writeRemoteFrame(newWalkerFrame(p.x, p.z, p.heading), p);
    }
  }

  useFrame(() => {
    const nowS = performance.now() / 1000;
    if (bodies.rev !== seenRev.current) { seenRev.current = bodies.rev; setRev((r) => r + 1); }
    const t = bodies.renderTime(nowS);
    if (t === null) return;
    const publish = nowS - publishAt.current >= PUBLISH_EVERY_S;
    if (publish) publishAt.current = nowS;
    const live = new Set<number>();
    for (const b of bodies.list()) {
      live.add(b.n);
      const fig = figures.current.get(b.n);
      const p = bodies.sample(b.n, t);
      if (!fig || !p) continue;
      writeRemoteFrame((frames.current[b.n] ??= newWalkerFrame(p.x, p.z, p.heading)), p);
      if (fig.group) fig.group.position.y = p.y;
      if (p.clip !== fig.lastClip) {
        fig.lastClip = p.clip;
        if (p.clip) fig.clips.fire(p.clip); else fig.clips.clear();
      }
      if (publish && walk) {
        walk.actors.publishWalker(`remote-${b.n}`, { x: p.x, y: p.y, z: p.z, vx: Math.sin(p.heading) * p.speed, vz: Math.cos(p.heading) * p.speed }, BODY_RADIUS, BODY_HEIGHT, true);
      }
    }
    // Bodies that left: free their slot and their mover.
    for (const n of [...figures.current.keys()]) {
      if (live.has(n)) continue;
      figures.current.delete(n);
      delete frames.current[n];
      walk?.actors.remove(`remote-${n}`);
    }
  }, -1);

  void rev; // re-render when bodies appear or leave
  return (
    <>
      {list.map((b) => {
        const fig = figures.current.get(b.n)!;
        return (
          <group key={b.n} ref={(g) => { fig.group = g; }}>
            <Suspense fallback={null}>
              <CastFigure framesRef={frames} index={b.n} baseY={0} home={[0, 0, 0]} body={BODIES[b.body] ?? BODY_REMY} clipTester={fig.clips} />
            </Suspense>
          </group>
        );
      })}
    </>
  );
}
