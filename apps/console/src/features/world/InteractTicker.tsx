import { useFrame } from "@react-three/fiber";
import type { InteractController } from "./interactables";

/**
 * Ticks the interactable controller once per frame in walk mode (actor expiry); in agent mode (frameloop "demand")
 * Scout's sim interval ticks it instead, exactly like TeaDoorTicker for the door.
 */
export function InteractTicker({ controller }: { controller: InteractController }) {
  useFrame((_, delta) => controller.tick(Math.min(delta, 0.25)));
  return null;
}
