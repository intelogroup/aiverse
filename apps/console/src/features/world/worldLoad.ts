/**
 * worldLoad — the GLB stage's loading state as pure logic (E1).
 *
 * The stage used to suspend into `fallback={null}`: for the whole
 * asset download (38 MB for the Agora, ~15 MB for City 3 + library)
 * the human stared at an empty gradient, indistinguishable from a
 * crashed page, on entry and on every world switch. This module
 * decides what the loading overlay shows instead, following the
 * corpus loading rules (skeleton-states.md):
 *
 *   < 300 ms        nothing yet — a fast load must not flash chrome
 *   300 ms – 4 s    skeleton (layout known, wait is noticeable)
 *   4 s – 10 s      determinate progress (real measured progress)
 *   > 10 s          progress + a way out (switch world)
 *   > 30 s          failed — never spin forever: error + retry
 *
 * Progress is drei's `useProgress` (the THREE LoadingManager's real
 * loaded/total), never a fabricated ramp — a bar that jumps to 99%
 * and stalls is worse than none (skeleton-states: "No fake progress").
 */

export type WorldLoadPhase =
  | "waiting"
  | "skeleton"
  | "progress"
  | "stalled"
  | "ready"
  | "failed";

export interface WorldLoadInput {
  /** The world subtree has actually mounted (presented) at least once. */
  presented: boolean;
  /** The loading manager reported an error for this load. */
  failed: boolean;
  /** Milliseconds since this place's load started. */
  elapsedMs: number;
}

/** Show the skeleton within 300 ms of the load starting (Clay). */
export const LOAD_SKELETON_MS = 300;
/** Beyond 4 s the wait earns determinate progress (grimoire-core). */
export const LOAD_PROGRESS_MS = 4_000;
/** Beyond 10 s the user gets progress + a way out (grimoire-core). */
export const LOAD_ESCAPE_MS = 10_000;
/** Never run an indicator indefinitely: 30 s, then error + retry. */
export const LOAD_TIMEOUT_MS = 30_000;

export function worldLoadPhase(i: WorldLoadInput): WorldLoadPhase {
  // Presented wins over everything: trailing streams (interiors,
  // textures) keep loading under their own boundaries once the world
  // itself is on screen — the human is in, the overlay is done.
  if (i.presented) return "ready";
  if (i.failed) return "failed";
  if (i.elapsedMs >= LOAD_TIMEOUT_MS) return "failed";
  if (i.elapsedMs >= LOAD_ESCAPE_MS) return "stalled";
  if (i.elapsedMs >= LOAD_PROGRESS_MS) return "progress";
  if (i.elapsedMs >= LOAD_SKELETON_MS) return "skeleton";
  return "waiting";
}

/** Determinate progress for display: a 0–100 integer, clamped. */
export function loadPercent(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.min(100, Math.max(0, Math.round(progress)));
}
