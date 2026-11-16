import * as THREE from "three";
import { collectItems, IN_SCOPE, sliceGroup, type Item } from "./bazaarBatch";

/**
 * Tree / repeated-prop instancing trial (tmp/instancing-on-batching,
 * ?instance=1 only — nothing here runs in the default console path).
 * Sits ON TOP of the batching trial (PR #183): where batching bakes
 * every repeated placement into merged (material, signature, cell)
 * buckets, this pass claims the repeated groups and renders each as
 * ONE THREE.InstancedMesh — the dev.to city-scene shape (buildings
 * merged, trees instanced).
 *
 * Claim order (the brief's): TREES FIRST — every tree group (ancestor
 * chain matches Tree_packtree* / ls_tree: the LIB_hero_tall /
 * LIB_hero_full / LIB_hero_birch trunk+branches prims) is instanced
 * regardless of count. Then any other repeated static group whose
 * placement count reaches MIN_PLACEMENTS. A group is keyed by
 * (slice geometry, material): one glTF mesh prim + one material,
 * shared across every node that uses it — per-instance
 * position/rotation/scale variation is the placements' own world
 * matrices, carried verbatim.
 *
 * Composition with batching: DistrictWorld plans the claims BEFORE
 * applying ?batch= and passes the claimed objects as the batch
 * pass's `exclude` predicate, so a claimed item is never also baked.
 * An item is claimed only when EVERY one of its material slices
 * lands in a claimed group — a partially-claimed item stays with
 * batching whole, so no prim can fall between the two passes.
 *
 * Collider/navmesh safety (the batching trial's hard trap, same
 * discipline): originals stay in the tree, hidden, never removed or
 * mutated; this pass runs after addColliders, reads world matrices,
 * and only ADDS InstancedMeshes that reference the source geometries
 * (slices are fresh copies; whole geometries are referenced, never
 * written). Collision keeps using the pristine meshes.
 *
 * Culling honesty: one InstancedMesh per group spans the city, so a
 * claimed group frustum-culls as a whole — its triangles render
 * whenever any part of it is on screen. That is the article's shape
 * and the measured trade of this trial: draw calls fall by the
 * per-cell buckets the group used to occupy; triangles at a local
 * pose can rise by the group's out-of-view share.
 */

export const MIN_PLACEMENTS = 25;
const CELL_SIZE = 128; // matches bazaarBatch's cell split, for the buckets-avoided stat
const TREE_CHAIN = /Tree_packtree|ls_tree/i;

function trisOfGeometry(g: THREE.BufferGeometry): number {
  return (g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3;
}

function geometryBytes(g: THREE.BufferGeometry): number {
  let n = 0;
  for (const attr of Object.values(g.attributes)) n += (attr as THREE.BufferAttribute).array.byteLength;
  if (g.index) n += g.index.array.byteLength;
  return n;
}

function isTreeItem(item: Item): boolean {
  let o: THREE.Object3D | null = item.obj;
  while (o) {
    if (TREE_CHAIN.test(o.name)) return true;
    o = o.parent;
  }
  return false;
}

interface Slice {
  key: string;
  geo: THREE.BufferGeometry;
  material: THREE.Material;
  sliced: boolean;
}

/** Local-space material slices of one item — mirrors bazaarBatch's piecesOf. */
function slicesOf(item: Item, cache: Map<string, Slice>): Slice[] {
  const obj = item.obj;
  const geo = obj.geometry as THREE.BufferGeometry;
  const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
  const out: Slice[] = [];
  if (Array.isArray(obj.material) && geo.groups.length > 0 && geo.index) {
    for (const grp of geo.groups) {
      const mat = mats[grp.materialIndex ?? 0];
      if (!mat) continue;
      const key = `${geo.uuid}#g${grp.start}:${grp.count}|${mat.uuid}`;
      let s = cache.get(key);
      if (!s) {
        s = { key, geo: sliceGroup(geo, grp.start, grp.count), material: mat, sliced: true };
        cache.set(key, s);
      }
      out.push(s);
    }
  } else if (mats[0]) {
    const key = `${geo.uuid}#whole|${mats[0].uuid}`;
    let s = cache.get(key);
    if (!s) {
      s = { key, geo, material: mats[0], sliced: false };
      cache.set(key, s);
    }
    out.push(s);
  }
  return out;
}

interface Placement {
  item: Item;
  matrix: THREE.Matrix4;
  color: THREE.Color | null;
}

interface GroupAcc {
  slice: Slice;
  label: string;
  tree: boolean;
  placements: Placement[];
  items: Set<Item>;
}

export interface InstanceGroupInfo {
  label: string;
  material: string;
  tree: boolean;
  placements: number;
  tris: number;
  cells: number;
}

export interface InstanceCensus {
  groups: number;
  claimedItems: number;
  placements: number;
  tris: number;
  perGroup: InstanceGroupInfo[];
}

export interface BazaarInstanceHandle {
  census: () => InstanceCensus;
  stats: Record<string, number>;
  showAll: () => void;
  dispose: () => void;
}

declare global {
  interface Window {
    __bazaarInstance?: BazaarInstanceHandle;
  }
}

export interface BazaarInstancePlan {
  claimedObjs: Set<THREE.Object3D>;
  apply: (root: THREE.Object3D, scene: THREE.Scene) => BazaarInstanceHandle;
}

/**
 * Compute the claim set for a resident scene without changing it.
 * DistrictWorld passes claimedObjs to the batch pass as its exclude
 * predicate, then calls apply() to build the InstancedMeshes.
 */
export function planBazaarInstance(root: THREE.Object3D): BazaarInstancePlan {
  root.updateWorldMatrix(true, true);
  const items = collectItems(root).filter((it) => IN_SCOPE(it.category));
  const cache = new Map<string, Slice>();
  const groups = new Map<string, GroupAcc>();
  const itemSlices = new Map<Item, Slice[]>();

  const _m = new THREE.Matrix4();
  const _c = new THREE.Color();
  for (const item of items) {
    const slices = slicesOf(item, cache);
    itemSlices.set(item, slices);
    if (!slices.length) continue;
    // Placements of this item: one per node, or one per GPU instance.
    const mats: THREE.Matrix4[] = [];
    const cols: (THREE.Color | null)[] = [];
    const im = item.obj as THREE.InstancedMesh;
    if (im.isInstancedMesh) {
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, _m);
        mats.push(_m.clone().premultiply(item.obj.matrixWorld));
        if (im.instanceColor) {
          im.getColorAt(i, _c);
          cols.push(_c.clone());
        } else {
          cols.push(null);
        }
      }
    } else {
      mats.push(item.obj.matrixWorld.clone());
      cols.push(null);
    }
    const tree = isTreeItem(item);
    for (const slice of slices) {
      let g = groups.get(slice.key);
      if (!g) {
        g = { slice, label: item.obj.name || slice.geo.name || "?", tree: false, placements: [], items: new Set() };
        groups.set(slice.key, g);
      }
      g.tree = g.tree || tree;
      g.items.add(item);
      for (let i = 0; i < mats.length; i++) g.placements.push({ item, matrix: mats[i], color: cols[i] });
    }
  }

  const claimedGroups = new Set<string>();
  for (const [key, g] of groups) {
    if (g.tree || g.placements.length >= MIN_PLACEMENTS) claimedGroups.add(key);
  }
  const claimedItems = items.filter((it) => {
    const slices = itemSlices.get(it) ?? [];
    return slices.length > 0 && slices.every((s) => claimedGroups.has(s.key));
  });
  const claimedSet = new Set(claimedItems);
  const claimedObjs = new Set<THREE.Object3D>(claimedItems.map((it) => it.obj));

  const apply = (rootArg: THREE.Object3D, scene: THREE.Scene): BazaarInstanceHandle => {
    void rootArg;
    const t0 = performance.now();
    const group3d = new THREE.Group();
    group3d.name = "__bazaarInstance";
    const added: THREE.InstancedMesh[] = [];
    const perGroup: InstanceGroupInfo[] = [];
    const stats: Record<string, number> = {};
    let totalPlacements = 0;
    let totalTris = 0;
    let bucketsAvoided = 0;
    let geoBytesOnce = 0;
    let geoBytesSaved = 0;

    const _p = new THREE.Vector3();
    for (const key of claimedGroups) {
      const g = groups.get(key)!;
      const placements = g.placements.filter((p) => claimedSet.has(p.item));
      if (!placements.length) continue;
      const geo = g.slice.geo;
      const mesh = new THREE.InstancedMesh(geo, g.slice.material, placements.length);
      mesh.name = `instance:${g.label}`;
      let cast = false;
      let recv = false;
      const cells = new Set<string>();
      placements.forEach((p, i) => {
        mesh.setMatrixAt(i, p.matrix);
        if (p.color) mesh.setColorAt(i, p.color);
        cast = cast || p.item.obj.castShadow;
        recv = recv || p.item.obj.receiveShadow;
        _p.setFromMatrixPosition(p.matrix);
        cells.add(`${Math.floor(_p.x / CELL_SIZE)},${Math.floor(_p.z / CELL_SIZE)}`);
      });
      mesh.castShadow = cast;
      mesh.receiveShadow = recv;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      group3d.add(mesh);
      added.push(mesh);
      const tris = trisOfGeometry(geo) * placements.length;
      totalPlacements += placements.length;
      totalTris += tris;
      bucketsAvoided += cells.size;
      const bytes = geometryBytes(geo);
      geoBytesOnce += bytes;
      geoBytesSaved += bytes * (placements.length - 1);
      perGroup.push({
        label: g.label,
        material: g.slice.material.name || g.slice.material.uuid,
        tree: g.tree,
        placements: placements.length,
        tris,
        cells: cells.size,
      });
    }
    perGroup.sort((a, b) => b.placements - a.placements);

    // Hide the claimed originals — they stay in the tree for the
    // collider system, exactly as the batch pass leaves its originals.
    for (const it of claimedItems) {
      if (it.obj.userData.__instancePrevVisible === undefined) {
        it.obj.userData.__instancePrevVisible = it.obj.visible;
      }
      it.obj.visible = false;
    }
    if (added.length) scene.add(group3d);

    stats.groups = added.length;
    stats.claimedItems = claimedItems.length;
    stats.placements = totalPlacements;
    stats.tris = totalTris;
    stats.bucketsAvoided = bucketsAvoided;
    stats.geoBytesOnce = geoBytesOnce;
    stats.geoBytesSavedVsBaked = geoBytesSaved;
    stats.buildMs = Math.round(performance.now() - t0);

    const census = (): InstanceCensus => ({
      groups: added.length,
      claimedItems: claimedItems.length,
      placements: totalPlacements,
      tris: totalTris,
      perGroup,
    });

    const handle: BazaarInstanceHandle = {
      census,
      stats,
      showAll: () => {
        for (const it of claimedItems) {
          if (it.obj.userData.__instancePrevVisible !== undefined) {
            it.obj.visible = it.obj.userData.__instancePrevVisible as boolean;
            delete it.obj.userData.__instancePrevVisible;
          }
        }
      },
      dispose: () => {
        for (const m of added) {
          m.parent?.remove(m);
          m.dispose();
        }
        group3d.parent?.remove(group3d);
        // Only the slice copies are ours to dispose; whole geometries
        // belong to the source scene.
        for (const s of cache.values()) if (s.sliced) s.geo.dispose();
        handle.showAll();
        if (typeof window !== "undefined" && window.__bazaarInstance === handle) delete window.__bazaarInstance;
      },
    };
    if (typeof window !== "undefined") window.__bazaarInstance = handle;
    return handle;
  };

  return { claimedObjs, apply };
}
