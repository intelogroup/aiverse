// Named places for the location strip and the minimap, from the same files the world loads.
import { useQuery } from "@tanstack/react-query";
import { CITY3_INDEX_URL, type City3Room } from "../city3";

export interface NamedPlace { name: string; x: number; z: number }

/** A place farther than this (metres) is not called "near". */
export const NEAR_M = 40;

export function nearestPlace(places: readonly NamedPlace[], x: number, z: number): NamedPlace | null {
  let best: NamedPlace | null = null;
  let bestD = NEAR_M;
  for (const p of places) {
    const d = Math.hypot(p.x - x, p.z - z);
    if (d <= bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/** Unnamed entries (stalls) carry their id as the name; they are drawn but never named. */
export function parsePlaces(raw: { id: string; name: string; pos: [number, number] }[]) {
  return {
    named: raw.filter((p) => p.name !== p.id).map((p) => ({ name: p.name, x: p.pos[0], z: p.pos[1] })),
    stalls: raw.filter((p) => p.name === p.id).map((p) => ({ x: p.pos[0], z: p.pos[1] })),
  };
}

const getJson = async <T,>(url: string): Promise<T> => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return (await r.json()) as T;
};

export function useMapData() {
  const places = useQuery({
    queryKey: ["map", "places"],
    queryFn: async () => parsePlaces(await getJson("/assets/city3-places.json")),
    staleTime: Infinity,
  });
  const rooms = useQuery({ queryKey: ["map", "rooms"], queryFn: () => getJson<City3Room[]>(CITY3_INDEX_URL), staleTime: Infinity });
  return { named: places.data?.named ?? [], stalls: places.data?.stalls ?? [], rooms: rooms.data ?? [] };
}
