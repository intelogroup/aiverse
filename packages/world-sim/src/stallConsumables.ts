// Front edge of BazaarPass_45 and _42: 1.033 m counters plus a 30 mm goods board, so props rest at 1.063.
export const STALL_CONSUMABLES = {
  "stall-apple": { name: "Stall apple", place: "stall-45", verb: "eat", position: [26.15, 1.096, 29.38], approach: [26.31, 28.81], portions: 1, refillS: 60 },
  "stall-water": { name: "Water bottle", place: "stall-42", verb: "drink", position: [17.39, 1.163, 41.38], approach: [17.55, 40.81], portions: 4, refillS: 120 },
} as const;
export type StallConsumableId = keyof typeof STALL_CONSUMABLES;
export function isStallConsumable(id: unknown): id is StallConsumableId {
  return typeof id === "string" && Object.hasOwn(STALL_CONSUMABLES, id);
}

export const STALL_REACH = 1.25;
export const STALL_PICKUP_S = 0.7;
export const STALL_MOUTH_S = 1.55;
export const STALL_LOWER_S = 2.15;
export const STALL_RETURN_S = 3.05;
export const STALL_FINISH_S = 3.5;
export const STALL_BOTTLE_LIP = 0.11;

export interface StallMotion { n: number; startedAt: number }
export interface StallPropFrame { visible: boolean; motion?: StallMotion }
export type StallFrame = Record<StallConsumableId, StallPropFrame>;

export function isStallUse(action: unknown): action is { type: "interact"; target: StallConsumableId; verb: "eat" | "drink" } {
  if (!action || typeof action !== "object") return false;
  const { type, target, verb } = action as { type?: unknown; target?: unknown; verb?: unknown };
  return type === "interact" && isStallConsumable(target) && STALL_CONSUMABLES[target].verb === verb;
}

export function stallEase(value: number): number {
  // Hostile shapes (AIV-STALL-MOTION-SHAPE-001): a non-finite value has no
  // eased position — return the start of the curve instead of leaking NaN
  // into prop frames (Math.min/Math.max propagate NaN).
  if (!Number.isFinite(value)) return 0;
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
}

export function bottleTilt(elapsed: number): number {
  const lift = stallEase((elapsed - STALL_PICKUP_S) / (STALL_MOUTH_S - STALL_PICKUP_S));
  const untilLower = 1 - stallEase((elapsed - STALL_LOWER_S) / (STALL_RETURN_S - STALL_LOWER_S));
  // The neck points back toward the agent as they tip the base up.
  return -1.74 * lift * untilLower;
}
