import type { CosmeticId } from "./events";
// Egg claims (server side). The public manifest (apps/console/public/assets/collectibles/easter-eggs.json) lists where
// eggs sit; what they GIVE lives only here, so the manifest stays safe to publish. A test keeps ids and positions in sync.
export const EGG_CLAIM_RANGE_M = 2.5;

export type EggPayload = { kind: "lore"; text: string };

export const EGGS: Record<string, { position: [number, number, number]; payload: EggPayload }> = {
  "egg-bazaar-01": { position: [-12.6, 0.2, 1], payload: { kind: "lore", text: "The fountain remembers every coin that was never thrown." } },
  "egg-bazaar-02": { position: [-30.1, 0.2, -70.5], payload: { kind: "lore", text: "Stall owners swear the fruit here ripens when someone laughs." } },
  "egg-bazaar-03": { position: [-27.2, 1.4008, -41.6], payload: { kind: "lore", text: "Tea House stairs count back from nine. Nobody knows why." } },
  "egg-bazaar-04": { position: [-30.2, 0.2, 70.9], payload: { kind: "lore", text: "Kronikler Press printed one page that wrote itself." } },
  "egg-bazaar-05": { position: [42, 0.2, 10], payload: { kind: "lore", text: "The eastern plaza bell rings only for newcomers." } },
  "egg-bazaar-06": { position: [-100, 0.2, -68.5], payload: { kind: "lore", text: "Market lanes run west because the first cart did." } },
};

export type EggClaimResult =
  | { result: "claimed"; payload: EggPayload; cosmetic: CosmeticId }
  | { result: "already_claimed" };
