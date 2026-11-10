// remoteFrames.ts — the console's side of the viewer stream: keep the last few server poses per body and answer "where is it NOW?".
// Pure (no React, no three) so it is unit tested. The server sends 5-10 poses a second; CastFigure draws every render frame from an
// AgentFrame with no smoothing of its own, so this buffer renders the world a little in the past and interpolates between samples.
import { decodePose, type FramesMessage, type RemotePose, type RosterMessage } from "@aiverse/world-sim/streamProtocol";
import type { AgentFrame } from "./locomotion";

/** Render this far behind the newest server time (s): about 1.3 frame intervals, so there are normally two samples to blend. */
export const RENDER_DELAY_S = 0.2;
const KEEP = 4;
/** Above this speed (m/s) the figure plays Walk. */
const WALK_SPEED = 0.05;

interface Sample { t: number; pose: RemotePose }

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
function lerpAngle(a: number, b: number, k: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

export class RemoteBodies {
  private samples = new Map<number, Sample[]>();
  private info = new Map<number, { name: string; body: string }>();
  private epoch = "";
  /** serverTime - localTime, smoothed: maps the local clock onto the server's. */
  private offset: number | null = null;
  /** Bumped whenever the set of bodies or names changes, so React re-renders only then. */
  rev = 0;

  /** Local clock (s) -> the server time to draw at. Null until the first frame. */
  renderTime(localS: number): number | null {
    return this.offset === null ? null : localS + this.offset - RENDER_DELAY_S;
  }

  applyRoster(r: RosterMessage): void {
    this.info.clear();
    for (const b of r.bodies) this.info.set(b.n, { name: b.name, body: b.body });
    this.rev++;
  }

  applyFrames(m: FramesMessage, localS: number): void {
    if (m.epoch !== this.epoch || (m.key && this.offset !== null && m.t < this.lastT())) { this.samples.clear(); this.offset = null; this.epoch = m.epoch; }
    const est = m.t - localS;
    this.offset = this.offset === null ? est : lerp(this.offset, est, 0.1);
    if (m.key) {
      const keep = new Set(m.b.map((t) => t[0]));
      for (const n of [...this.samples.keys()]) if (!keep.has(n)) { this.samples.delete(n); this.rev++; }
    }
    for (const n of m.gone) if (this.samples.delete(n)) this.rev++;
    for (const tup of m.b) {
      const pose = decodePose(tup);
      let list = this.samples.get(pose.n);
      if (!list) { this.samples.set(pose.n, (list = [])); this.rev++; }
      list.push({ t: m.t, pose });
      if (list.length > KEEP) list.shift();
    }
  }

  clear(): void { this.samples.clear(); this.info.clear(); this.offset = null; this.rev++; }

  private lastT(): number {
    let t = -Infinity;
    for (const l of this.samples.values()) t = Math.max(t, l[l.length - 1]?.t ?? -Infinity);
    return t;
  }

  /** Bodies that have a position and a roster entry (the figure needs both: the model and the name). */
  list(): { n: number; name: string; body: string }[] {
    const out: { n: number; name: string; body: string }[] = [];
    for (const n of this.samples.keys()) { const i = this.info.get(n); if (i) out.push({ n, ...i }); }
    return out.sort((a, b) => a.n - b.n);
  }

  /** The pose at server time `t`: blended between the two samples that bracket it, held at the ends (never extrapolated). */
  sample(n: number, t: number): RemotePose | null {
    const list = this.samples.get(n);
    if (!list?.length) return null;
    if (t <= list[0].t) return list[0].pose;
    const last = list[list.length - 1];
    if (t >= last.t) return last.pose;
    for (let i = list.length - 1; i > 0; i--) {
      const a = list[i - 1], b = list[i];
      if (t >= a.t) {
        const k = (t - a.t) / (b.t - a.t || 1);
        return {
          n, x: lerp(a.pose.x, b.pose.x, k), y: lerp(a.pose.y, b.pose.y, k), z: lerp(a.pose.z, b.pose.z, k),
          heading: lerpAngle(a.pose.heading, b.pose.heading, k),
          speed: lerp(a.pose.speed, b.pose.speed, k),
          // Discrete state does not blend: take the earlier sample's until the later one is reached.
          posture: a.pose.posture, clip: a.pose.clip,
        };
      }
    }
    return last.pose;
  }
}

/** Write a pose into the AgentFrame CastFigure reads (in place; the figure holds the same object). Height is the caller's. */
export function writeRemoteFrame(f: AgentFrame, p: RemotePose): AgentFrame {
  const moving = p.speed > WALK_SPEED;
  f.position[0] = p.x;
  f.position[1] = p.z;
  f.velocity[0] = Math.sin(p.heading) * p.speed;
  f.velocity[1] = Math.cos(p.heading) * p.speed;
  f.speed = p.speed;
  f.heading = p.heading;
  f.state = moving ? "walk" : "idle";
  f.gait = { reverse: false };
  return f;
}
