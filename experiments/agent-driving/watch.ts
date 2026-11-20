import type { DriveState } from "./protocol";

// What would make a driver look up: the lamp changes, the stop becomes impossible, the move ends or a person appears near the road.
export function watchKey(state: DriveState) {
  const lesson = state.lesson;
  const line = lesson?.senses?.horizon.find((event) => event.type === "stop_line");
  const walkers = lesson?.senses?.nearby.filter((actor) => actor.kind === "pedestrian").length ?? 0;
  return {
    light: lesson?.signalHead ?? null,
    canStop: line && line.type === "stop_line" ? line.canStop : null,
    moving: Boolean(state.action),
    walkers,
  };
}
export function watchChange(before: ReturnType<typeof watchKey>, after: ReturnType<typeof watchKey>) {
  if (before.light !== after.light) return `light_${after.light}`;
  if (before.canStop === true && after.canStop === false) return "cannot_stop_before_line";
  if (before.moving && !after.moving) return "movement_finished";
  if (after.walkers > before.walkers) return "pedestrian_appeared";
  return null;
}
