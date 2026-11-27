import { SCALE_REMY } from "./bodies";

/** One authored City 3 pilot. Stance, contact centre and times come from Remy's Blender sweep. */
export const APPLE_ID = "market-apple-01";
export const APPLE_ASSET = "/assets/props/market-apple.glb";
/** grab/place are accepted this far (m) from the fitted stance; the sim walks the body the rest of the way. */
export const APPLE_APPROACH = 6;
export const APPLE_GROUND = 0.2;
export const APPLE_STANDS = {
  "apple-stand-01": {
    name: "Apple pickup stand", stance: [8, 12], offset: [0.02516887, 0.13844875, 0.33147556],
    height: 0.119, verb: "grab", clip: "PickUp", contact: 59 / 24,
    rotation: [0, 0, 0, 1],
  },
  "apple-stand-02": {
    name: "Apple receiving stand", stance: [11, 12], offset: [0.06238428, 0.09095605, 0.37773874],
    height: 0.0715, verb: "place", clip: "PuttingDown", contact: 140 / 24,
    rotation: [0.01728457, 0.08496375, -0.00699355, 0.99620956],
  },
} as const;
export type AppleStand = keyof typeof APPLE_STANDS;
export const APPLE_PICKUP = "apple-stand-01" satisfies AppleStand;
export const APPLE_RECEIVING = "apple-stand-02" satisfies AppleStand;

export function appleCenter(stand: AppleStand): [number, number, number] {
  const { stance, offset } = APPLE_STANDS[stand];
  return [stance[0] + offset[0] * SCALE_REMY, APPLE_GROUND + offset[1] * SCALE_REMY, stance[1] + offset[2] * SCALE_REMY];
}

export interface AppleMotion {
  n: number;
  stand: AppleStand;
  startedAt: number;
}

export interface AppleFrame {
  stand: AppleStand;
  holder: number | null;
  motion: AppleMotion | null;
}
