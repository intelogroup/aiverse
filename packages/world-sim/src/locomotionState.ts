/** "run" is produced only by gait-driven frames (the City 3 walker); the crowd emits idle/walk. Lives here (not in the console's
 * locomotion.ts, which pulls in the Recast WASM) so the pure walk-override module can name it. */
export type LocomotionState = "idle" | "walk" | "run";
