// walkOverride.ts — the City 3 walk-mode HUD's clip override state.
//
// The walk bot's figure (CityWalker.tsx) is driven by speed: walker.ts
// clipFor(speed) picks idle/walk/run and CastFigure's gait path blends
// them. The HUD's three test buttons need two behaviours speed cannot
// express:
//
//   Run toggle — hold the catalog Run loop regardless of speed (the
//     bot's walk pace never crosses RUNNING_SPEED, so Run is otherwise
//     unreachable on foot).
//   Door one-shots — OpenDoorInwards / OpenDoorOutwards play once
//     while the bot stands still, then the figure returns to whatever
//     the toggle/speed state says.
//
// This class IS a ClipTestState (clips.ts), so the walker's CastFigure
// consumes it through the exact clip-firing path the Embody panel's
// tester uses — no parallel mechanism. The walk layer adds only the
// semantics above: `runHeld` survives a door one-shot (the shot plays
// on top; when it expires, Run resumes), and `doorClip` tells
// CityWalker a one-shot is on stage so it can suppress travel input
// for the performance. Pure and three-free, same discipline as
// clips.ts / walker.ts, so vitest covers it headless.

import { ClipTestState } from "./clips";
import type { LocomotionState } from "./locomotion";

/** The catalog one-shots the HUD's door buttons fire. */
export const WALK_DOOR_CLIPS = ["OpenDoorInwards", "OpenDoorOutwards"] as const;
export type WalkDoorClip = (typeof WALK_DOOR_CLIPS)[number];

const isDoorClip = (name: string): name is WalkDoorClip =>
  (WALK_DOOR_CLIPS as readonly string[]).includes(name);

/** The walker's latest frame, as the HUD status line shows it (CityWalker writes it per frame). */
export interface WalkFrameInfo {
  state: LocomotionState;
  speed: number;
}

export class WalkClipOverride extends ClipTestState {
  /** Run toggle state: while true the Run loop is the figure's rest state. */
  runHeld = false;
  /** The door one-shot currently on stage, if any. */
  private door: WalkDoorClip | null = null;

  /** The door one-shot playing right now (HUD active button; null = none). */
  get doorClip(): WalkDoorClip | null {
    return this.door;
  }

  /** True while a door one-shot plays: the walker stands still for it. */
  get doorPlaying(): boolean {
    return this.door !== null;
  }

  /**
   * The clip name the HUD status line should show: the forced catalog
   * clip while one is on stage, else the speed-driven locomotion
   * state the walker picked this frame.
   */
  displayClip(speedState: LocomotionState): string {
    return this.current ?? speedState;
  }

  /** Flip the Run toggle. A door one-shot on stage plays out first — tick() applies the new toggle state when it expires. */
  toggleRun(): void {
    this.runHeld = !this.runHeld;
    if (this.door) return;
    if (this.runHeld) this.fire("Run");
    else if (this.current === "Run") this.clear();
  }

  /** Fire a door one-shot (latest press wins — it replaces any clip on stage). Returns false for a non-door name. */
  fireDoor(name: string): boolean {
    if (!isDoorClip(name)) return false;
    if (!this.fire(name)) return false;
    this.door = name;
    return true;
  }

  override fire(name: string): boolean {
    const ok = super.fire(name);
    // Any clip fired outside fireDoor retires a door one-shot's claim
    // on the walker (its stage time is over even if it was mid-play).
    if (ok && !isDoorClip(name)) this.door = null;
    return ok;
  }

  override clear(): void {
    super.clear();
    this.door = null;
    // runHeld deliberately survives: ClipTestState.tick() expires a
    // one-shot BY calling clear(), and tick() below needs the toggle
    // state intact to resume Run after a door one-shot. toggleRun()
    // owns the flag.
  }

  override tick(dt: number): void {
    const wasDoor = this.door !== null;
    super.tick(dt);
    if (wasDoor && this.current === null) {
      // The one-shot expired: hand the stage back to the toggle —
      // Run resumes if held, otherwise the figure is speed-driven.
      this.door = null;
      if (this.runHeld) this.fire("Run");
    }
  }
}
