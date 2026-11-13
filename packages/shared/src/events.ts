// Public agent event log: what an agent visibly DID. Actions only; goals, reasoning and memory never enter it.
// The client may report the first group (the gateway cannot see the sim); the server alone writes the second.
export const CLIENT_EVENT_TYPES = ["said", "gesture", "sat", "activated", "toy", "visited"] as const;
export const SERVER_EVENT_TYPES = ["claimed", "cheered"] as const;
export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];
export type AgentEventType = ClientEventType | (typeof SERVER_EVENT_TYPES)[number];

export const EVENT_DETAIL_MAX = 140;

/** Cheers a spectator can send. Fixed set: no free text from strangers reaches the world. */
export const CHEERS = ["heart", "clap", "fire", "wow"] as const;
export type Cheer = (typeof CHEERS)[number];

/** Wearable rewards from eggs. Cosmetic only: never money. */
export const COSMETICS = {
  ember: { label: "Ember aura", color: "#ff7a3d" },
  tide: { label: "Tide aura", color: "#3dc7ff" },
  moss: { label: "Moss aura", color: "#7be07b" },
  dusk: { label: "Dusk aura", color: "#a779ff" },
  gilt: { label: "Gilt aura", color: "#ffd24a" },
  rose: { label: "Rose aura", color: "#ff7ab6" },
} as const;
export type CosmeticId = keyof typeof COSMETICS;
const COSMETIC_IDS = Object.keys(COSMETICS) as CosmeticId[];

export function isCosmetic(id: unknown): id is CosmeticId {
  return typeof id === "string" && Object.hasOwn(COSMETICS, id);
}

/** Stable pick per egg (djb2 hash), so the server and any client agree without a table. */
export function cosmeticForEgg(eggId: string): CosmeticId {
  let h = 5381;
  for (let i = 0; i < eggId.length; i++) h = ((h << 5) + h + eggId.charCodeAt(i)) >>> 0;
  return COSMETIC_IDS[h % COSMETIC_IDS.length]!;
}

/** Strip control characters, collapse whitespace, cap length. Used on every free-text detail. */
export function cleanDetail(s: unknown): string {
  if (typeof s !== "string") return "";
  const t = s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return t.length > EVENT_DETAIL_MAX ? t.slice(0, EVENT_DETAIL_MAX - 1) + "…" : t;
}

const BASE_SCORE: Record<AgentEventType, number> = {
  claimed: 100, toy: 60, cheered: 50, said: 40, gesture: 30, activated: 25, visited: 20, sat: 15,
};

/** How clip-worthy an event is. Wandering is not a clip, so low scores never offer one. */
export function momentScore(type: AgentEventType, detail = ""): number {
  const base = BASE_SCORE[type] ?? 0;
  return type === "said" && detail.length < 12 ? base - 20 : base;
}
export const MOMENT_MIN_SCORE = 25;

/** Caption burned into a clip: readable with sound off. */
export function momentCaption(type: AgentEventType, detail: string, name: string): string {
  switch (type) {
    case "claimed": return `${name} found a secret: ${detail}`;
    case "said": return `${name}: "${detail}"`;
    case "gesture": return `${name} ${detail || "waves"}`;
    case "activated": return `${name} switched on ${detail || "something"}`;
    case "toy": return `${name} ${detail || "played with a toy"}`;
    case "cheered": return `${name} got a ${detail || "cheer"}`;
    case "visited": return `${name} arrived in ${detail || "a new place"}`;
    case "sat": return `${name} took a seat`;
  }
}

export type AgentEvent = { id: string; type: AgentEventType; detail: string; at: string };

/** Best N events by score, newest first among ties. Per-type cap keeps one noisy behaviour from filling the list. */
export function topMoments(events: readonly AgentEvent[], n: number, perType = 2): AgentEvent[] {
  const seen = new Map<string, number>();
  return [...events]
    .filter(e => momentScore(e.type, e.detail) >= MOMENT_MIN_SCORE)
    .sort((a, b) => momentScore(b.type, b.detail) - momentScore(a.type, a.detail) || b.at.localeCompare(a.at))
    .filter(e => { const k = seen.get(e.type) ?? 0; seen.set(e.type, k + 1); return k < perType; })
    .slice(0, n);
}

export type Passport = {
  agentId: string;
  name: string;
  eggsFound: number;
  eggsTotal: number;
  cosmetics: CosmeticId[];
  counts: Partial<Record<AgentEventType, number>>;
  best: AgentEvent | null;
};
