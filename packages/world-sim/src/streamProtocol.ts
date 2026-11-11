// streamProtocol.ts — the wire format of the viewer stream (sim -> gateway -> spectators). Pure; shared by all three sides.
//
// A pose is one tuple of integers so a frame of 200 bodies stays small:
//   [n, x_cm, y_cm, z_cm, heading_mrad, speed_cms, posture, clip?]
// `n` is an opaque body number the sim hands out per attached body (never reused within one sim run). It is NOT the agent id: the
// agent id never leaves the gateway. Names and body models travel separately in the roster.
import type { AgentPose } from "./agentBody";
import type { Posture } from "./scout";

export type PoseTuple = [n: number, x: number, y: number, z: number, h: number, s: number, p: number, clip?: string];

/** Posture codes (index = wire value). */
export const POSTURES: readonly Posture[] = ["standing", "sitting-down", "seated", "standing-up"];

/** A decoded pose in metres / radians (what the console draws from). */
export interface RemotePose {
  n: number;
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  posture: Posture;
  clip: string | null;
}

const TWO_PI = Math.PI * 2;

export function encodePose(n: number, p: AgentPose): PoseTuple {
  // Wrap heading into [0, 2pi) so equal headings quantise equally (a stationary body must produce an identical tuple every tick).
  const h = ((p.heading % TWO_PI) + TWO_PI) % TWO_PI;
  const t: PoseTuple = [n, Math.round(p.x * 100), Math.round(p.y * 100), Math.round(p.z * 100), Math.round(h * 1000), Math.round(p.speed * 100), Math.max(0, POSTURES.indexOf(p.posture))];
  if (p.clip) t.push(p.clip);
  return t;
}

export function decodePose(t: PoseTuple): RemotePose {
  return {
    n: t[0], x: t[1] / 100, y: t[2] / 100, z: t[3] / 100,
    heading: t[4] / 1000,
    speed: t[5] / 100,
    posture: POSTURES[t[6]] ?? "standing",
    clip: t[7] ?? null,
  };
}

export const sameTuple = (a: PoseTuple, b: PoseTuple): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** What the gateway sends spectators for the poses. `key` frames carry every body; the others only what changed (+ `gone`). */
export interface FramesMessage {
  epoch: string;
  /** Sim time, s: the clock to interpolate on (never wall time). */
  t: number;
  key: boolean;
  b: PoseTuple[];
  gone: number[];
}

/** Who the numbers are: display name and body model only. */
export interface RosterMessage {
  epoch: string;
  bodies: { n: number; name: string; body: string }[];
}

/** Lines spoken in the world, for the speech bubble over the speaker. Public text: already cut to 140 characters. */
export interface SayMessage {
  epoch: string;
  say: { seq: number; n: number; text: string }[];
}

export const WORLD_FRAMES = "world_frames";
export const WORLD_SAY = "world_say";
export const WORLD_ROSTER = "world_roster";
export const SUBSCRIBE_WORLD = "subscribe_world";

/**
 * Turns successive full snapshots into key / delta frames. A stationary body costs nothing between key frames; a body that
 * disappeared is reported once in `gone`.
 */
export class FrameDiffer {
  private last = new Map<number, PoseTuple>();
  private epoch = "";
  private lastKeyAtMs = -Infinity;

  private readonly keyEveryMs: number;
  constructor(keyEveryMs = 2000) { this.keyEveryMs = keyEveryMs; }

  /** Forget everything: the next frame is a key frame. */
  reset(): void { this.last.clear(); this.lastKeyAtMs = -Infinity; }

  next(epoch: string, t: number, snapshot: PoseTuple[], nowMs: number): FramesMessage {
    if (epoch !== this.epoch) { this.epoch = epoch; this.reset(); }
    const key = nowMs - this.lastKeyAtMs >= this.keyEveryMs;
    const seen = new Set<number>();
    const b: PoseTuple[] = [];
    for (const tup of snapshot) {
      seen.add(tup[0]);
      const prev = this.last.get(tup[0]);
      if (key || !prev || !sameTuple(prev, tup)) b.push(tup);
      this.last.set(tup[0], tup);
    }
    const gone: number[] = [];
    for (const n of this.last.keys()) if (!seen.has(n)) { gone.push(n); this.last.delete(n); }
    if (key) this.lastKeyAtMs = nowMs;
    return { epoch, t, key, b, gone };
  }

  /** The current state as one key frame (for a spectator that just subscribed). */
  full(t: number): FramesMessage | null {
    if (!this.last.size) return null;
    return { epoch: this.epoch, t, key: true, b: [...this.last.values()], gone: [] };
  }
}
