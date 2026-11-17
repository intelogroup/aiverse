import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * Bazaar/city batching trial (tmp/batching-statics, ?batch=<mode> only —
 * nothing here runs in the default console path). Follow-up to the LOD
 * trial (tmp/lod-bazaar), which cut triangles but left draw calls flat:
 * merging/batching is the lever that moves calls.
 *
 * Scope (BATCHING-PLAN.md): STATIC geometry of the resident city GLB only —
 * stalls, buildings, repeated props. Excluded, always: door-category nodes
 * (TeaDoorLeaf / TeaElevator drive their instance matrices — state),
 * water/sea materials (DistrictWorld hides them; a merge must never
 * resurrect them), anything invisible at collect time, skinned meshes,
 * and every other root (interiors, links, shell, characters never enter
 * this function — it is handed the resident scene only).
 *
 * Tooling note: @zkmake/three-batch was evaluated first (per plan). Its
 * bake() refuses instanced and multi-material meshes — the majority of
 * this scene's in-scope draw items (70 instanced prop nodes carrying
 * 1,006 instances; ~2,000 multi-primitive nodes) — and its chunkInstances
 * disposes the source's instance buffers, which fights the collider
 * system's hold on the pristine scene. So the merge is hand-rolled on
 * three's own BufferGeometryUtils, following the bazaarLod.ts pattern
 * (run after addColliders; originals stay in the tree, hidden).
 *
 * Modes:
 *   census — collect + classify only; the handle also exposes
 *            hideInScope()/hideDoors()/showAll() so the rig can attribute
 *            rendered draw calls by category (hide-diff at a settled pose).
 *   merge  — (a) every in-scope primitive baked in world space and merged
 *            per (material, attribute signature): one mesh per bucket,
 *            world-spanning bounds, no per-object culling.
 *   cells  — (b) every single-material InstancedMesh split into ~128 m
 *            grid cells (x/z of each instance's world position), one
 *            InstancedMesh per cell with its own computed bounds, so
 *            frustum culling can skip whole cells. Plain meshes already
 *            cull individually and are left untouched.
 *   both   — (a) partitioned by cell: baked pieces merged per
 *            (material, signature, cell), each merged mesh tightly
 *            bounded — the three-batch shape, hand-rolled.
 *
 * No quantization anywhere: attribute values are copied float-for-float
 * from the decoded source; only the bucketing changes.
 */

export type BatchMode = "census" | "merge" | "cells" | "both";

const CELL_SIZE = 128;
const PROP_NAME = /^(SK_med_stall|inst_goods_|FountainClayPot)/;
const DOOR_NAME = /door/i;
const STATEFUL_NAME = /radio|interactable/i;

type Category = "propFamily" | "otherStatic" | "door" | "waterSea" | "stateful" | "hidden";

interface Item {
  obj: THREE.Mesh | THREE.InstancedMesh;
  category: Category;
  prims: number;
  instances: number;
  tris: number;
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();

function trisOfGeometry(g: THREE.BufferGeometry): number {
  return (g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3;
}

function attributeSignature(g: THREE.BufferGeometry): string {
  return Object.keys(g.attributes).sort().join(",");
}

function cellKeyOf(x: number, z: number): string {
  return `${Math.floor(x / CELL_SIZE)},${Math.floor(z / CELL_SIZE)}`;
}

/**
 * Collect every render item of the resident root with its category.
 * Visibility is the chain state at collect time (DistrictWorld's own
 * effect has already hidden the water/sea surfaces by the time the
 * batch hook runs — those items land in `hidden`/`waterSea` and are
 * never touched).
 */
function collectItems(root: THREE.Object3D): Item[] {
  const items: Item[] = [];
  // Category tests run against the item's FULL ancestor name chain:
  // GLTFLoader nests multi-primitive meshes under a Group, so a leaf
  // mesh's own name (the glTF mesh name) and its immediate parent can
  // both miss the node name that carries the semantics (inst_door_double,
  // L1_door, SK_med_stall...). The chain never misses it.
  const walk = (o: THREE.Object3D, ancestorVisible: boolean, ancestors: string[]) => {
    const visible = ancestorVisible && o.visible;
    const chain = [...ancestors, o.name];
    const chainStr = chain.join("/");
    const mesh = o as THREE.Mesh;
    if ((mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh) && !(mesh as THREE.SkinnedMesh).isSkinnedMesh) {
      const im = mesh as THREE.InstancedMesh;
      const isInstanced = !!im.isInstancedMesh;
      const instances = isInstanced ? im.count : 1;
      const geo = mesh.geometry as THREE.BufferGeometry;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      let category: Category;
      if (!visible) category = "hidden";
      else if (chain.some((n) => PROP_NAME.test(n))) category = "propFamily";
      else if (DOOR_NAME.test(chainStr)) category = "door";
      else if (STATEFUL_NAME.test(chainStr)) category = "stateful";
      else if (mats.some((mt) => mt?.name === "water" || mt?.name === "sea")) category = "waterSea";
      else category = "otherStatic";
      const prims = geo.groups.length > 0 && Array.isArray(mesh.material) ? geo.groups.length : 1;
      items.push({ obj: mesh, category, prims, instances, tris: trisOfGeometry(geo) * instances });
    }
    for (const c of o.children) walk(c, visible, chain);
  };
  walk(root, true, []);
  return items;
}

export interface BatchCensus {
  mode: BatchMode;
  items: number;
  byCategory: Record<string, { items: number; prims: number; instances: number; tris: number }>;
  inScope: { items: number; prims: number; instances: number; tris: number };
  distinctMaterialsInScope: number;
  multiMaterialItems: number;
  instancedInScope: number;
}

export interface BazaarBatchHandle {
  mode: BatchMode;
  census: () => BatchCensus;
  stats: Record<string, number>;
  hideInScope: () => number;
  hideDoors: () => number;
  showAll: () => void;
  dispose: () => void;
}

declare global {
  interface Window {
    __bazaarBatch?: BazaarBatchHandle;
  }
}

const IN_SCOPE = (c: Category) => c === "propFamily" || c === "otherStatic";

/** Slice one material group out of an indexed geometry, compacting vertices. */
function sliceGroup(geo: THREE.BufferGeometry, start: number, count: number): THREE.BufferGeometry {
  const index = geo.index!;
  const used = new Map<number, number>();
  const newIndex: number[] = [];
  for (let i = start; i < start + count; i++) {
    const v = index.getX(i);
    let n = used.get(v);
    if (n === undefined) {
      n = used.size;
      used.set(v, n);
    }
    newIndex.push(n);
  }
  const order = [...used.keys()];
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geo.attributes)) {
    const a = attr as THREE.BufferAttribute;
    const arr = new (a.array.constructor as new (n: number) => typeof a.array)(order.length * a.itemSize);
    for (let i = 0; i < order.length; i++) {
      for (let k = 0; k < a.itemSize; k++) arr[i * a.itemSize + k] = a.array[order[i] * a.itemSize + k];
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize));
  }
  out.setIndex(newIndex);
  return out;
}

interface Piece {
  geo: THREE.BufferGeometry;
  material: THREE.Material;
  cell: string;
  castShadow: boolean;
  receiveShadow: boolean;
}

/** World-baked single-material pieces of one in-scope item. */
function piecesOf(item: Item): Piece[] {
  const obj = item.obj;
  const geo = obj.geometry as THREE.BufferGeometry;
  const pieces: Piece[] = [];
  const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
  // Primitive pieces in local space: one per material group, or the whole.
  const localPieces: Array<{ geo: THREE.BufferGeometry; material: THREE.Material }> = [];
  if (Array.isArray(obj.material) && geo.groups.length > 0 && geo.index) {
    for (const grp of geo.groups) {
      const mat = mats[grp.materialIndex ?? 0];
      if (mat) localPieces.push({ geo: sliceGroup(geo, grp.start, grp.count), material: mat });
    }
  } else {
    localPieces.push({ geo: geo.clone(), material: mats[0] });
  }
  const push = (g: THREE.BufferGeometry, material: THREE.Material) => {
    g.computeBoundingSphere();
    const c = g.boundingSphere!.center;
    pieces.push({ geo: g, material, cell: cellKeyOf(c.x, c.z), castShadow: obj.castShadow, receiveShadow: obj.receiveShadow });
  };
  if ((obj as THREE.InstancedMesh).isInstancedMesh) {
    const im = obj as THREE.InstancedMesh;
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, _m);
      _m.premultiply(obj.matrixWorld);
      for (const lp of localPieces) push(lp.geo.clone().applyMatrix4(_m), lp.material);
    }
  } else {
    for (const lp of localPieces) push(lp.geo.applyMatrix4(obj.matrixWorld), lp.material);
  }
  return pieces;
}

export function applyBazaarBatch(root: THREE.Object3D, scene: THREE.Scene, mode: BatchMode): BazaarBatchHandle {
  const t0 = performance.now();
  root.updateWorldMatrix(true, true);
  const items = collectItems(root);
  const stats: Record<string, number> = {};

  const census = (): BatchCensus => {
    const byCategory: BatchCensus["byCategory"] = {};
    const materials = new Set<string>();
    let multiMaterialItems = 0;
    let instancedInScope = 0;
    for (const it of items) {
      const c = (byCategory[it.category] ??= { items: 0, prims: 0, instances: 0, tris: 0 });
      c.items++;
      c.prims += it.prims;
      c.instances += it.instances;
      c.tris += it.tris;
      if (Array.isArray(it.obj.material)) multiMaterialItems++;
      if (IN_SCOPE(it.category)) {
        const mats = Array.isArray(it.obj.material) ? it.obj.material : [it.obj.material];
        for (const mt of mats) if (mt) materials.add(mt.uuid);
        if ((it.obj as THREE.InstancedMesh).isInstancedMesh) instancedInScope++;
      }
    }
    const inScope = { items: 0, prims: 0, instances: 0, tris: 0 };
    for (const cat of ["propFamily", "otherStatic"] as const) {
      const c = byCategory[cat];
      if (!c) continue;
      inScope.items += c.items;
      inScope.prims += c.prims;
      inScope.instances += c.instances;
      inScope.tris += c.tris;
    }
    return { mode, items: items.length, byCategory, inScope, distinctMaterialsInScope: materials.size, multiMaterialItems, instancedInScope };
  };

  const setVisible = (pred: (it: Item) => boolean, v: boolean): number => {
    let n = 0;
    for (const it of items) {
      if (!pred(it)) continue;
      if (v && it.obj.userData.__batchPrevVisible !== undefined) {
        it.obj.visible = it.obj.userData.__batchPrevVisible as boolean;
        delete it.obj.userData.__batchPrevVisible;
      } else if (!v && it.obj.visible) {
        it.obj.userData.__batchPrevVisible = true;
        it.obj.visible = false;
        n++;
      }
    }
    return n;
  };

  const group = new THREE.Group();
  group.name = "__bazaarBatch";
  const added: THREE.Object3D[] = [];

  if (mode === "merge" || mode === "both") {
    const buckets = new Map<string, { material: THREE.Material; geos: THREE.BufferGeometry[]; cast: boolean; recv: boolean }>();
    let pieceCount = 0;
    for (const it of items) {
      if (!IN_SCOPE(it.category)) continue;
      for (const piece of piecesOf(it)) {
        pieceCount++;
        const key = `${piece.material.uuid}|${attributeSignature(piece.geo)}${mode === "both" ? `|${piece.cell}` : ""}`;
        let b = buckets.get(key);
        if (!b) {
          b = { material: piece.material, geos: [], cast: false, recv: false };
          buckets.set(key, b);
        }
        b.geos.push(piece.geo);
        b.cast = b.cast || piece.castShadow;
        b.recv = b.recv || piece.receiveShadow;
      }
    }
    let fallbacks = 0;
    let bakedVerts = 0;
    let bakedBytes = 0;
    for (const [key, b] of buckets) {
      // mergeGeometries needs a uniform index story per bucket.
      const anyIndexed = b.geos.some((g) => g.index);
      const allIndexed = b.geos.every((g) => g.index);
      const list = anyIndexed && !allIndexed ? b.geos.map((g) => (g.index ? g.toNonIndexed() : g)) : b.geos;
      const merged = mergeGeometries(list, false);
      if (!merged) {
        fallbacks++;
        for (const g of list) {
          const m = new THREE.Mesh(g, b.material);
          m.castShadow = b.cast;
          m.receiveShadow = b.recv;
          m.name = `batch-fallback:${key}`;
          group.add(m);
          added.push(m);
        }
        continue;
      }
      const mesh = new THREE.Mesh(merged, b.material);
      mesh.castShadow = b.cast;
      mesh.receiveShadow = b.recv;
      mesh.name = `batch:${b.material.name || b.material.uuid}`;
      merged.computeBoundingSphere();
      bakedVerts += merged.attributes.position.count;
      for (const attr of Object.values(merged.attributes)) bakedBytes += (attr as THREE.BufferAttribute).array.byteLength;
      if (merged.index) bakedBytes += merged.index.array.byteLength;
      group.add(mesh);
      added.push(mesh);
    }
    stats.buckets = buckets.size;
    stats.pieces = pieceCount;
    stats.mergedMeshes = added.length;
    stats.mergeFallbacks = fallbacks;
    stats.bakedVerts = bakedVerts;
    stats.bakedBytes = bakedBytes;
    setVisible((it) => IN_SCOPE(it.category), false);
  }

  if (mode === "cells") {
    let splitItems = 0;
    let cellMeshes = 0;
    let skippedMultiMaterial = 0;
    for (const it of items) {
      if (!IN_SCOPE(it.category)) continue;
      const im = it.obj as THREE.InstancedMesh;
      if (!im.isInstancedMesh) continue;
      if (Array.isArray(im.material)) {
        skippedMultiMaterial++;
        continue;
      }
      splitItems++;
      const byCell = new Map<string, number[]>();
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, _m);
        _p.setFromMatrixPosition(_m).applyMatrix4(im.matrixWorld);
        const key = cellKeyOf(_p.x, _p.z);
        const arr = byCell.get(key) ?? [];
        arr.push(i);
        byCell.set(key, arr);
      }
      for (const [cell, idxs] of byCell) {
        const cm = new THREE.InstancedMesh(im.geometry, im.material, idxs.length);
        cm.name = `${im.name}#${cell}`;
        cm.position.copy(im.position);
        cm.quaternion.copy(im.quaternion);
        cm.scale.copy(im.scale);
        cm.castShadow = im.castShadow;
        cm.receiveShadow = im.receiveShadow;
        idxs.forEach((src, dst) => {
          im.getMatrixAt(src, _m);
          cm.setMatrixAt(dst, _m);
          if (im.instanceColor) {
            const col = new THREE.Color();
            im.getColorAt(src, col);
            cm.setColorAt(dst, col);
          }
        });
        cm.instanceMatrix.needsUpdate = true;
        if (cm.instanceColor) cm.instanceColor.needsUpdate = true;
        cm.computeBoundingSphere();
        im.parent?.add(cm);
        added.push(cm);
        cellMeshes++;
      }
    }
    stats.splitItems = splitItems;
    stats.cellMeshes = cellMeshes;
    stats.skippedMultiMaterial = skippedMultiMaterial;
    setVisible((it) => IN_SCOPE(it.category) && (it.obj as THREE.InstancedMesh).isInstancedMesh && !Array.isArray(it.obj.material), false);
  }

  if (added.length && mode !== "cells") scene.add(group);
  stats.bakeMs = Math.round(performance.now() - t0);
  stats.addedObjects = added.length;

  const handle: BazaarBatchHandle = {
    mode,
    census,
    stats,
    hideInScope: () => setVisible((it) => IN_SCOPE(it.category), false),
    hideDoors: () => setVisible((it) => it.category === "door", false),
    showAll: () => setVisible(() => true, true),
    dispose: () => {
      for (const o of added) {
        o.parent?.remove(o);
        if (mode !== "cells") (o as THREE.Mesh).geometry?.dispose();
      }
      group.parent?.remove(group);
      setVisible(() => true, true);
      if (typeof window !== "undefined" && window.__bazaarBatch === handle) delete window.__bazaarBatch;
    },
  };
  if (typeof window !== "undefined") window.__bazaarBatch = handle;
  return handle;
}
