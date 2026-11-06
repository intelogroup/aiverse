// city3.ts — City 3 (Sunstone Bazaar) facts the console needs, plus the
// cutaway and lazy-load rules for its hero buildings. Three-free and
// DOM-free, so the rules run headless under vitest.
//
// Values come from the generator (tools/city3/out/heroes.json). Each hero
// building has a furnished ground floor; every GLB object whose name
// starts with its prefix is its upper floors, roof and ceiling — hide
// them and the room shows. A hero can ship its furnishings as a separate
// GLB (CC0 library assets), fetched only once the camera comes near.

export interface City3Hero {
  id: string;
  name: string;
  /** Name prefix of the cut-away objects (upper floors, roof, ceiling). */
  prefix: string;
  /** Building centre, XZ in three.js space. */
  center: [number, number];
  /** Camera preset that looks into the cut-away room from the street. */
  view: { position: [number, number, number]; target: [number, number, number] };
  /** Furnishings GLB, loaded on approach; omitted when they live in the city GLB. */
  interiorUrl?: string;
}

export const CITY3_HEROES: City3Hero[] = [
  {
    id: "tea",
    name: "Matchmaker's Tea House",
    prefix: "TeaUpper_",
    center: [-25, -78.5],
    view: { position: [-6, 17, -54], target: [-25, 0.6, -78.5] },
  },
  {
    id: "press",
    name: "Kronikler Press",
    prefix: "PressUpper_",
    center: [-25, 78.5],
    view: { position: [-6, 17, 54], target: [-25, 0.6, 78.5] },
    interiorUrl: "/assets/world-city3-press.glb",
  },
];

/** Hide the upper floors inside HIDE_WITHIN m, show them again past SHOW_BEYOND m. */
export const HIDE_WITHIN = 48;
export const SHOW_BEYOND = 60;
/** Fetch a hero's furnishings GLB once the camera is this close (m). */
export const INTERIOR_LOAD_WITHIN = 140;

/**
 * Whether a hero building's upper floors should be hidden for this camera
 * distance. The two thresholds give hysteresis, so a camera that hovers
 * around one distance doesn't flicker the roof on and off.
 */
export function cutawayHidden(distance: number, wasHidden: boolean): boolean {
  if (distance < HIDE_WITHIN) return true;
  if (distance > SHOW_BEYOND) return false;
  return wasHidden;
}

/** Camera distance to a hero building (3D, building centre at ground level). */
export function heroDistance(hero: City3Hero, cam: { x: number; y: number; z: number }): number {
  return Math.hypot(cam.x - hero.center[0], cam.y, cam.z - hero.center[1]);
}
