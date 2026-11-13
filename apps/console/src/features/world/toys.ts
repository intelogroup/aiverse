import type { InteractableDef } from "./interactables";

// Toys: small shared props that make the plaza worth visiting. They ride the generic interactable system, so
// agents see them in the same list as the radio and eggs and use them with the same `interact` action.
// shortcut: placed by hand on the open cobbled plaza east of the Bazaar fountain (checked with the nav patch); move them with the room index when a
// plaza lot is authored for them.
export type ToyKind = "dance" | "gong" | "fireworks" | "photo";
/** Plaza cobbles sit at y 0.2 here. */
export const TOY_GROUND_Y = 0.2;
export const TOY_ORIGIN: [number, number] = [12, 25];

const at = (dx: number, dz: number): [number, number] => [TOY_ORIGIN[0] + dx, TOY_ORIGIN[1] + dz];
const LAYOUT: Record<ToyKind, { dx: number; dz: number; label: string; phrase: string }> = {
  dance: { dx: 0, dz: 0, label: "Dance floor", phrase: "lit up the dance floor" },
  gong: { dx: 6, dz: 0, label: "Plaza gong", phrase: "struck the plaza gong" },
  fireworks: { dx: -6, dz: 0, label: "Firework pad", phrase: "set off fireworks" },
  photo: { dx: 12, dz: 0, label: "Photo booth", phrase: "struck a pose in the photo booth" },
};

export const toyId = (k: ToyKind) => `toy-${k}`;
export const toyKindOf = (def: Pick<InteractableDef, "kind">): ToyKind | null =>
  def.kind.startsWith("toy:") ? (def.kind.slice(4) as ToyKind) : null;
export const toyPhrase = (k: ToyKind) => LAYOUT[k].phrase;
export const toyCenter = (k: ToyKind) => at(LAYOUT[k].dx, LAYOUT[k].dz);

/** Stand point is 1.6 m south of the prop (the dance floor: 2.6 m, just off its edge), facing it. */
export function toyDefs(): InteractableDef[] {
  return (Object.keys(LAYOUT) as ToyKind[]).map(k => {
    const [x, z] = toyCenter(k);
    const back = k === "dance" ? 2.6 : 1.6;
    return {
      id: toyId(k), room: "plaza", kind: `toy:${k}`, asset: "", label: LAYOUT[k].label,
      pos: [x, TOY_GROUND_Y, z], rotY: 0, stand: [x, z - back], heading: 0, floorY: TOY_GROUND_Y,
    };
  });
}

/** Dance-floor light level: dark when idle, grows with each dancer, never past 4. A ritual lights it for free. */
export function danceLevel(on: boolean, dancers: number, ritualActive: boolean): number {
  if (!on && !ritualActive) return 0;
  return Math.min(4, 1 + dancers * 0.75);
}

/** Seconds a one-shot toy effect plays after a flip. */
export const TOY_EFFECT_S: Record<Exclude<ToyKind, "dance">, number> = { gong: 2.5, fireworks: 3.2, photo: 0.5 };
