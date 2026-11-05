// clips.ts — the full animation catalog every cast body ships.
//
// The five core clips (Idle, Walk, SittingTalking, SitDown, StandUp)
// are wired into the body layer (bodies.ts): locomotion crossfades
// Idle/Walk, the embody sit phases own the sitting family. The 2026-11-05
// catalog wave baked the 43-file Mixamo batch onto all three bodies,
// so every body now carries the SAME 45-clip catalog — skills and the
// Embody panel's clip tester select by name, never per body.
//
// `loop` clips hold until another choice; one-shots play once and the
// figure returns to Idle. Durations are the baked GLB durations
// (source frames @ 30 fps, hips location stripped at bake time — the
// body layer owns placement, so travel/yaw clips like EnterCar or
// TurnLeft90 perform in place until world props publish anchors for
// them). Three-free and DOM-free, same discipline as embody.ts.

export interface ClipDef {
  name: string;
  loop: boolean;
  /** Baked duration, seconds. */
  duration: number;
}

const CORE: ClipDef[] = [
  { name: "Idle", loop: true, duration: 2.6667 },
  { name: "Walk", loop: true, duration: 1.1667 },
  { name: "SittingTalking", loop: true, duration: 44.1 },
  { name: "SitDown", loop: false, duration: 2.2333 },
  { name: "StandUp", loop: false, duration: 2.2667 },
];

/** The batch wave's additions, alphabetical. */
const BATCH: ClipDef[] = [
  { name: "Arguing", loop: false, duration: 20.8 },
  { name: "AttackPunch", loop: false, duration: 0.8667 },
  { name: "Block", loop: false, duration: 2.8667 },
  { name: "Bow", loop: false, duration: 2.7333 },
  { name: "CastSpell", loop: false, duration: 2.3 },
  { name: "Clapping", loop: true, duration: 1.1667 },
  { name: "Death", loop: false, duration: 3.0333 },
  { name: "Drinking", loop: false, duration: 8.8667 },
  { name: "EnterCar", loop: false, duration: 5.4667 },
  { name: "ExitCar", loop: false, duration: 5.8 },
  { name: "Handshake1", loop: false, duration: 4.3667 },
  { name: "Handshake2", loop: false, duration: 4.3667 },
  { name: "HitReaction", loop: false, duration: 0.4333 },
  { name: "IdleLong", loop: true, duration: 9.9333 },
  { name: "Interact", loop: false, duration: 3.2333 },
  { name: "Jump", loop: false, duration: 2.6 },
  { name: "Laughing", loop: false, duration: 9.7667 },
  { name: "LookOverBothShoulders", loop: false, duration: 4.0 },
  { name: "LookOverShoulder", loop: false, duration: 3.7667 },
  { name: "LookingAround", loop: false, duration: 6.3333 },
  { name: "NodYes", loop: false, duration: 2.6 },
  { name: "OpenDoorInwards", loop: false, duration: 6.3667 },
  { name: "OpenDoorOutwards", loop: false, duration: 4.1 },
  { name: "PickUp", loop: false, duration: 9.5667 },
  { name: "Pointing", loop: false, duration: 1.8333 },
  { name: "Run", loop: true, duration: 0.7333 },
  { name: "Salute", loop: false, duration: 2.8333 },
  { name: "ShakeHeadNo", loop: false, duration: 1.8 },
  { name: "Shrug", loop: false, duration: 2.0 },
  { name: "SittingIdle", loop: true, duration: 6.4 },
  { name: "Talking", loop: true, duration: 3.9333 },
  { name: "TalkingFunny", loop: false, duration: 5.9333 },
  { name: "TalkingOnPhone", loop: true, duration: 37.2333 },
  { name: "Texting", loop: true, duration: 18.5333 },
  { name: "Thinking", loop: false, duration: 4.2333 },
  { name: "Throw", loop: false, duration: 2.2 },
  { name: "TurnLeft90", loop: false, duration: 1.8667 },
  { name: "TurnRight90", loop: false, duration: 1.6333 },
  { name: "Victory", loop: false, duration: 8.5333 },
  { name: "Waving", loop: false, duration: 0.5333 },
];

/** Every clip in the catalog: the five core clips first, then the batch. */
export const CLIP_CATALOG: ClipDef[] = [...CORE, ...BATCH];

export const CLIP_BY_NAME: ReadonlyMap<string, ClipDef> = new Map(
  CLIP_CATALOG.map((c) => [c.name, c]),
);

export function clipDef(name: string): ClipDef | undefined {
  return CLIP_BY_NAME.get(name);
}

/**
 * The Embody panel's clip-tester state: which catalog clip is
 * currently fired on the embodied figure (cast[0]).
 *
 * Firing a loop holds it until another clip is fired (or Idle clears
 * the tester — Idle IS the rest state, so firing it just hands the
 * body back to the body layer). Firing a one-shot plays it once:
 * `tick` expires it back to null after its duration, and the figure
 * crossfades home to Idle. The figure layer (CastFigure) ticks this
 * once per frame and blends toward whatever `current` says; the sit
 * choreography always wins over the tester while a sit override is
 * active (the tester never fights a mount).
 */
export class ClipTestState {
  current: string | null = null;
  private elapsed = 0;

  /** Fire a catalog clip. Returns false for an unknown clip name. */
  fire(name: string): boolean {
    if (name === "Idle") {
      this.clear();
      return true;
    }
    const def = CLIP_BY_NAME.get(name);
    if (!def) return false;
    this.current = name;
    this.elapsed = 0;
    return true;
  }

  clear(): void {
    this.current = null;
    this.elapsed = 0;
  }

  tick(dt: number): void {
    if (!this.current) return;
    const def = CLIP_BY_NAME.get(this.current);
    if (!def || def.loop) return;
    this.elapsed += dt;
    if (this.elapsed >= def.duration) this.clear();
  }
}
