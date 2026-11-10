// node/loadWorld.ts — the server sim's IO: read the shipped City 3 world data from disk and fill a VerseSim.
//
// Lives outside src/ on purpose: src/ is the pure half (guarded: no DOM, only three + three-mesh-bvh), this file reads files and uses
// three's GLTFLoader. It mirrors what the console does with fetch: the resident Bazaar collision GLB (key "resident", no offset),
// one collision GLB per other district (offset by the district centre), one furniture-box sidecar per hero room ("interior:<id>"),
// plus the places, anchors and prop definitions. The console streams districts and rooms in by distance; the server holds them all.
import { readFile } from "node:fs/promises";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { bakeCollisionParts, boxesMesh } from "../src/capsuleWorld";
import { CityNav } from "../src/cityNav";
import { colUrl, parseColBoxes } from "../src/colBoxes";
import type { InteractableDef } from "../src/interactables";
import type { ScoutPlace, ScoutRoomShape, Sittable } from "../src/scout";
import { VerseSim } from "../src/verseSim";

interface DistrictRow { id: string; center: [number, number]; resident?: boolean; collisionUrl?: string }
interface RoomRow { id: string; name?: string; door?: [number, number]; rect?: [number, number, number, number]; center?: [number, number]; layout?: string; collision?: string; interactables?: InteractableDef[] }

export interface LoadStats {
  collisionSets: string[];
  interiorSets: number;
  triangles: number;
  ms: number;
}

/** `/assets/foo.glb` (a manifest URL) -> a path under `assetsDir` (apps/console/public/assets). */
const at = (assetsDir: string, url: string) => `${assetsDir.replace(/\/$/, "")}/${url.replace(/^\/?assets\//, "")}`;

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function glbScene(path: string): Promise<THREE.Group> {
  const buf = await readFile(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return (await new GLTFLoader().parseAsync(ab, "")).scene;
}

/** The baked navmesh shipped with the package (see bakeNavmesh.ts). */
export const NAVMESH_BIN = new URL("../data/world-city3-navmesh.bin", import.meta.url).pathname;

/**
 * `opts.navBin`: path of a baked navmesh (default: the package's own); `false` plans with the grid A* instead (slow, blocks the tick:
 * only the navmesh bake itself and the comparison benchmarks use it).
 */
export async function loadVerseSim(assetsDir: string, opts: { navBin?: string | false } = {}): Promise<{ sim: VerseSim; stats: LoadStats }> {
  const t0 = performance.now();
  const sim = new VerseSim();
  if (opts.navBin !== false) sim.nav = await CityNav.create(new Uint8Array(await readFile(opts.navBin ?? NAVMESH_BIN)));
  sim.walk.status = "loading";
  const manifest = await readJson<{ districts: DistrictRow[] }>(at(assetsDir, "/assets/districts.json"));
  const loadCollision = async (key: string, url: string, center: [number, number] | null) => {
    const g = new THREE.Group();
    if (center) g.position.set(center[0], 0, center[1]);
    g.add(await glbScene(at(assetsDir, url)));
    g.updateMatrixWorld(true);
    const meshes = bakeCollisionParts(g, `collision:${key}`);
    if (meshes.length) sim.walk.set(key, meshes);
    return meshes.length > 0;
  };
  const resident = manifest.districts.find((d) => d.resident);
  const residentOk = await loadCollision("resident", resident?.collisionUrl ?? "/assets/world-city3-collision.glb", null).catch(() => false);
  sim.walk.status = residentOk ? "ready" : "failed";
  for (const d of manifest.districts) {
    if (d.resident || !d.collisionUrl) continue;
    await loadCollision(d.id, d.collisionUrl, d.center).catch(() => false);
  }

  const rooms = await readJson<RoomRow[]>(at(assetsDir, "/assets/interiors/index.json"));
  let interiorSets = 0;
  for (const r of rooms) {
    const url = r.collision ?? (r.layout ? colUrl(r.layout) : null);
    if (!url) continue;
    const json = await readJson<unknown>(at(assetsDir, url)).catch(() => null);
    const m = json ? boxesMesh(parseColBoxes(json), [0, 0], `interior:${r.id}`) : null;
    if (m) { sim.walk.set(`interior:${r.id}`, [m]); interiorSets++; }
  }

  const places = await readJson<ScoutPlace[]>(at(assetsDir, "/assets/city3-places.json"));
  const sittables = await readJson<Sittable[]>(at(assetsDir, "/assets/city3-anchors.json"));
  const shapes: ScoutRoomShape[] = rooms.flatMap((r) => (r.door && r.rect && r.center ? [{ id: r.id, name: r.name ?? r.id, door: r.door, rect: r.rect, center: r.center }] : []));
  sim.setData({ places, sittables, rooms: shapes }, rooms.flatMap((r) => r.interactables ?? []));

  const s = sim.walk.stats();
  return { sim, stats: { collisionSets: s.sets, interiorSets, triangles: s.triangles, ms: Math.round(performance.now() - t0) } };
}
