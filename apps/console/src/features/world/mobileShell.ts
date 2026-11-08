// mobileShell.ts — the bridge between the two halves of the mobile
// shell (MOBILE-PLAN.md Phase 2). WorldView owns the tab bar and the
// Feed / You / Search sheets (it holds the shell's data), but Places
// data and the walk actions live inside GlbWorld (city3Rooms, camMode,
// the walk spawn). GlbWorld registers a PlacesSource here while City 3
// is on stage; WorldView's Places sheet reads it through
// useSyncExternalStore. GlbWorld also reports "a touch walk is live"
// so the tab bar gets out of the walk layer's way.
//
// The spawn-request helpers are pure and three-free (unit-tested): a
// Walk there tap becomes a probe centre for CityWalker's findSpawn —
// just outside the room's door, on the street — plus the point the
// bot should face once it spawns.

import { frontVector, type City3Room } from "./city3";

export interface PlacesSource {
  rooms: City3Room[];
  /** Fly the spectator camera to the room (heroFocus flight). */
  flyTo: (room: City3Room) => void;
  /** Enter walk mode spawned at the room's doorstep. */
  walkTo: (room: City3Room) => void;
}

/** A pending walk spawn: probe centre + the point to face. */
export interface WalkSpawnRequest {
  x: number;
  z: number;
  faceX: number;
  faceZ: number;
}

/** How far out from the door the spawn probe centres (metres). */
export const SPAWN_DOOR_OFFSET = 2.2;

export function spawnRequestForRoom(room: City3Room): WalkSpawnRequest {
  const [fx, fz] = frontVector(room.front);
  const [dx, dz] = room.door;
  return {
    x: dx + fx * SPAWN_DOOR_OFFSET,
    z: dz + fz * SPAWN_DOOR_OFFSET,
    faceX: dx,
    faceZ: dz,
  };
}

export function spawnRequestForPoint(x: number, z: number): WalkSpawnRequest {
  return { x, z, faceX: x, faceZ: z };
}

interface ShellSnapshot {
  places: PlacesSource | null;
  walkLive: boolean;
}

let snapshot: ShellSnapshot = { places: null, walkLive: false };
const listeners = new Set<() => void>();

function emit(next: ShellSnapshot) {
  if (next.places === snapshot.places && next.walkLive === snapshot.walkLive) return;
  snapshot = next;
  for (const fn of listeners) fn();
}

export const mobileShell = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  getSnapshot(): ShellSnapshot {
    return snapshot;
  },
  setPlaces(places: PlacesSource | null): void {
    emit({ ...snapshot, places });
  },
  setWalkLive(walkLive: boolean): void {
    emit({ ...snapshot, walkLive });
  },
};
