// Ground-floor lounge table in the shipped Tea House interior, beside the radio.
export const TEA_CUP = {
  id: "tea-cup",
  position: [-21.35, 1.26, -76.13] as [number, number, number],
  approach: [-20.55, -75.9] as [number, number],
  floorY: 0.48,
  reach: 1.4,
} as const;

export const CUP_ACTIONS = ["take", "drink", "put_down"] as const;
export type CupAction = typeof CUP_ACTIONS[number];
