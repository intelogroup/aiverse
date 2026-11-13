// city3.ts — City 3 (Sunstone Bazaar) facts the console needs: the room index the generator
// writes (tools/city3/out/interiors/index.json), camera presets, and the cutaway/streaming radii.
// Three-free and DOM-free, so it runs headless under vitest.
//
// A "room" is one market-block building with a furnished ground floor. Its layout is a small JSON
// of placements into the shared asset library; only the nearest few are ever resident.
import type { CutBox } from "./cutaway";
import type { InteractableDef } from "./interactables";
import { assetUrl } from "../../lib/assetUrl";

export type Side = "S" | "N" | "E" | "W";

export interface City3Room {
  id: string;
  /** Matching `shop-n` lot id in city3-nav.json (rooms map to places through lots). */
  lot: string;
  name: string;
  template: string;
  /** Street side of the building (blender naming: S faces -Y = +Z in three.js). */
  front: Side;
  /** Building centre, XZ in three.js space. */
  center: [number, number];
  door: [number, number];
  /** [minX, minZ, maxX, maxZ] */
  rect: [number, number, number, number];
  cut: CutBox;
  layout: string;
  featured: boolean;
  /** Debug only: shift a reused layout to this room's place. */
  shift?: [number, number];
  /** Usable props (the Tea House radio): static data from tools/city3, known before the room streams in. */
  interactables?: InteractableDef[];
}

export const CITY3_INDEX_URL = "/assets/interiors/index.json";
/** One shared asset library for every streamed interior (loaded once, kept). */
export const CITY3_LIBRARY_URL = assetUrl("/assets/world-city3-library.glb");

/** Open (cut away) the nearest room within HIDE_WITHIN m; close it again past SHOW_BEYOND m. */
export const HIDE_WITHIN = 48;
export const SHOW_BEYOND = 60;
/** Start streaming an interior once the camera is this close (m). */
export const INTERIOR_LOAD_WITHIN = 140;
/** ...and keep it until the camera is farther than this (m); wider than the load radius so edges don't thrash. */
export const INTERIOR_KEEP_WITHIN = 200;
/** Interiors resident at once; the farthest are evicted first. */
export const MAX_LOADED_INTERIORS = 3;

const FRONT: Record<Side, [number, number]> = { S: [0, 1], N: [0, -1], E: [1, 0], W: [-1, 0] };

/** Unit vector pointing OUT of a room's front (street side), XZ. */
export function frontVector(front: Side): [number, number] {
  return FRONT[front];
}

/** Camera preset that looks into the cut-away room from its street side, three-quarter view. */
export function roomView(room: City3Room): {
  position: [number, number, number];
  target: [number, number, number];
} {
  const [fx, fz] = FRONT[room.front];
  const [tx, tz] = [fz, fx]; // along the street
  return {
    position: [room.center[0] + fx * 24 + tx * 12, 17, room.center[1] + fz * 24 + tz * 12],
    target: [room.center[0], 0.6, room.center[1]],
  };
}

/** Distance from a camera to a room's centre at ground level. */
export function roomDistance(room: Pick<City3Room, "center">, cam: { x: number; y: number; z: number }): number {
  return Math.hypot(cam.x - room.center[0], cam.y, cam.z - room.center[1]);
}

/**
 * Debug/test only (?streamDebug=1&fake=N): N extra rooms that reuse one real layout at
 * deterministic spots across the island, so streaming has competition to arbitrate.
 */
export function syntheticRooms(n: number, source: City3Room): City3Room[] {
  return Array.from({ length: n }, (_, i) => {
    const center: [number, number] = [-150 + (i % 5) * 75, -120 + Math.floor(i / 5) * 80];
    return {
      ...source,
      id: `fake-${i}`,
      lot: `fake-${i}`,
      name: `Fake room ${i}`,
      featured: false,
      center,
      shift: [center[0] - source.center[0], center[1] - source.center[1]],
    };
  });
}
