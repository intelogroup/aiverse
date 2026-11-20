// Fixed-time signal plan for the Bazaar junctions: north-south and east-west alternate, each with green, yellow, then a
// shared all-red clearance so the two never show green together. Pure, so it tests without WebGL.
export type Lamp = "red" | "yellow" | "green";
export const SIGNAL_PLAN = { green: 12, yellow: 3, clearance: 1.5 } as const;
export const SIGNAL_PERIOD = 2 * (SIGNAL_PLAN.green + SIGNAL_PLAN.yellow + SIGNAL_PLAN.clearance);

function phase(t: number): Lamp {
  const { green, yellow } = SIGNAL_PLAN;
  return t < green ? "green" : t < green + yellow ? "yellow" : "red";
}

/** Lamp shown to each approach pair at `seconds` into the plan. */
export function signalState(seconds: number): { ns: Lamp; ew: Lamp } {
  const half = SIGNAL_PERIOD / 2;
  const t = ((seconds % SIGNAL_PERIOD) + SIGNAL_PERIOD) % SIGNAL_PERIOD;
  return t < half ? { ns: phase(t), ew: "red" } : { ns: "red", ew: phase(t - half) };
}
