/**
 * Foot-plant event sink — the seam between FootLock (footLock.ts)
 * and the sound layer (soundDirector.ts). A leaf module with no
 * imports, so neither side depends on the other: FootLock reports a
 * plant the frame a foot pins; whoever registered a sink (the sound
 * director, while walk mode is live) hears about it. No sink, no
 * sound, no cost beyond the call.
 */

export type PlantSink = (x: number, z: number) => void;

let sink: PlantSink | null = null;

/** Register (or clear, with null) the foot-plant listener. */
export function setPlantSink(fn: PlantSink | null): void {
  sink = fn;
}

/** Report a foot plant at world (x, z). Called by FootLock only. */
export function emitPlant(x: number, z: number): void {
  sink?.(x, z);
}
