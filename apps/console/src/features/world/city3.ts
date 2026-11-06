// city3.ts — City 3 (Sunstone Bazaar) facts the console needs, plus the
// cutaway rule for its hero building. Three-free and DOM-free, so the
// rule runs headless under vitest.
//
// The values come from the generator (tools/city3/out/hero.json): the
// Matchmaker's Tea House stands on the north side of the plaza, its
// ground floor furnished; every object named HeroUpper_* in the GLB is
// its upper floors, roof and ceiling — hide them and the room shows.

/** Hero building centre, XZ in three.js space (rect_three [-37.5, -84.5, -12.5, -72.5]). */
export const CITY3_HERO_CENTER: [number, number] = [-25, -78.5];
export const CITY3_HERO_NAME = "Matchmaker's Tea House";
export const CITY3_HERO_PREFIX = "HeroUpper_";

/** Camera preset that looks into the cut-away room from the street side. */
export const CITY3_HERO_VIEW = {
  position: [-6, 17, -54] as [number, number, number],
  target: [-25, 0.6, -78.5] as [number, number, number],
};

/** Hide the upper floors inside HIDE_WITHIN m, show them again past SHOW_BEYOND m. */
export const HIDE_WITHIN = 48;
export const SHOW_BEYOND = 60;

/**
 * Whether the hero building's upper floors should be hidden for this
 * camera distance. The two thresholds give hysteresis, so a camera that
 * hovers around one distance doesn't flicker the roof on and off.
 */
export function cutawayHidden(distance: number, wasHidden: boolean): boolean {
  if (distance < HIDE_WITHIN) return true;
  if (distance > SHOW_BEYOND) return false;
  return wasHidden;
}
