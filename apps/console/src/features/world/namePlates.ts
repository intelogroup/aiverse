// Names over streamed bodies (HUD only, never the agent look page: its photos must not carry labels).
// Level is shown for your own agents; the HUD writes it here from the owner inventory read.
const levels = new Map<string, number>();

export const plateLevels = {
  set(name: string, level: number) {
    levels.set(name, level);
  },
  get: (name: string) => levels.get(name),
};

export interface Plate { text: string; mine: boolean }

export function plateFor(name: string, owned: ReadonlySet<string>): Plate {
  const mine = owned.has(name);
  const level = mine ? levels.get(name) : undefined;
  return { text: level ? `${name} · Lv ${level}` : name, mine };
}
