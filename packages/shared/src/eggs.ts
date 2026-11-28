import type { CosmeticId } from "./events";
// Egg claims (server side). The public manifest (apps/console/public/assets/collectibles/easter-eggs.json) lists where
// eggs sit; what they GIVE lives only here, so the manifest stays safe to publish. A test keeps ids and positions in sync.
export const EGG_CLAIM_RANGE_M = 2.5;

export type EggPayload = { kind: "lore"; text: string };

export const EGGS: Record<string, { position: [number, number, number]; payload: EggPayload }> = {
  "egg-bazaar-01": { position: [-12.6, 0.2, 1], payload: { kind: "lore", text: "The fountain remembers every coin that was never thrown." } },
  "egg-bazaar-02": { position: [-30.1, 0.2, -70.5], payload: { kind: "lore", text: "Stall owners swear the fruit here ripens when someone laughs." } },
  "egg-bazaar-03": { position: [-28.65, 0.2, -41.6], payload: { kind: "lore", text: "Tea House stairs count back from nine. Nobody knows why." } },
  "egg-bazaar-04": { position: [-30.2, 0.2, 70.9], payload: { kind: "lore", text: "Kronikler Press printed one page that wrote itself." } },
  "egg-bazaar-05": { position: [42, 0.2, 10], payload: { kind: "lore", text: "The eastern plaza bell rings only for newcomers." } },
  "egg-bazaar-06": { position: [-100, 0.2, -68.5], payload: { kind: "lore", text: "Market lanes run west because the first cart did." } },
  // Soak 2026-11-27 seeding (local run branch only): the two special-payload
  // eggs. Their lore carries the run's cross-hints; the prizes themselves
  // live in the pickup system (verseProgress.ts), never in the payload.
  "egg-soak-01": { position: [-17, 0.48, 82], payload: { kind: "lore", text: "A note in careful script: 'One key opens the terminal, and it sleeps where the tea jar watches the valley. What is worth two sleeps in the far south-west grass.'" } },
  "egg-soak-02": { position: [-98, 0.2, 66], payload: { kind: "lore", text: "Scratched inside the shell: 'GOLD HIDES HERE — LOOK CLOSER. THE KEY SLEEPS BY THE TEA JAR. THE MOON KEEPS THE EASTERN PLAZA. A LANTERN BURNS IN THE NORTH-WEST LANE.'" } },
  "egg-soak-03": { position: [48, 0.2, 16], payload: { kind: "lore", text: "A tide chart for a sea that isn't here. Someone underlined the moonrise column twice." } },
  "egg-soak-04": { position: [-36, 0.2, 76], payload: { kind: "lore", text: "A lamplighter's chalk mark: 'This corner first. The dark notices if you skip it.'" } },
};

export type EggClaimResult =
  | { result: "claimed"; payload: EggPayload; cosmetic: CosmeticId }
  | { result: "already_claimed" };
