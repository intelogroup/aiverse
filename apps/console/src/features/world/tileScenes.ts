import { useSyncExternalStore } from "react";
import type * as THREE from "three";
/**
 * Loaded world tiles by id. Components that edit one specific node of the world (the Tea House door leaf and lift) cannot
 * `useGLTF` a 91 MB monolith any more: they wait here for the tile that holds their node. `epoch` also ticks on every
 * mount/unmount, so effects that must touch every material (the cutaway clip planes) can re-run when geometry arrives.
 */
const scenes = new Map<string, THREE.Object3D>();
const subs = new Set<() => void>();
let epoch = 0;
const emit = () => { epoch++; subs.forEach((f) => f()); };
export const tileScenes = {
  set(id: string, root: THREE.Object3D) { scenes.set(id, root); emit(); },
  drop(id: string) { if (scenes.delete(id)) emit(); },
  get: (id: string) => scenes.get(id),
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
  epoch: () => epoch,
};
/** The scene of tile `id`, or undefined until it has streamed in. */
export function useTileScene(id: string): THREE.Object3D | undefined {
  return useSyncExternalStore(tileScenes.subscribe, () => scenes.get(id));
}
/** Ticks whenever any tile mounts or unmounts. */
export function useTileEpoch(): number {
  return useSyncExternalStore(tileScenes.subscribe, tileScenes.epoch);
}
