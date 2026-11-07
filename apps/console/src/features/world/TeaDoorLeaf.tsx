/**
 * TeaDoorLeaf — the Tea House door pilot's visual assembly (TeaDoor.tsx).
 *
 * The Bazaar's 77 door leaves ship as static instances inside
 * world-city3.glb (node `inst_door_double`, 8 instances of the DI_2
 * double-leaf mesh). For this one door the pilot:
 *
 *   1. zero-scales the tea instance (index 6 — verified against the
 *      measured origin before touching it) in BOTH primitive meshes,
 *      leaving the other 76 leaves untouched;
 *   2. rebuilds that leaf as a standalone assembly on the same spot:
 *      frame + transom static, the two leaf panels split out of the
 *      source geometry by triangle classification and hung on pivots
 *      at their jambs, and a knob added on both faces of the active
 *      (left) leaf at the study's 0.80 m height, 0.06 m proud;
 *   2b. finds the painted leaf (panels, rails, mullions — baked into the
 *      shared palette mesh by tools/city3, see bakedLeaf.ts), copies its
 *      triangles onto the same pivots and degenerates the originals;
 *   3. drives the pivots from the TeaDoorController's angles every
 *      frame (active rotation.y = +angle into the room, passive
 *      mirrored at -angle — see teaDoor.ts for the hinge geometry).
 *
 * On unmount the original instance matrices are restored and the
 * split geometries disposed (the source geometry/materials are the
 * GLB's shared ones and are never mutated or disposed here).
 */

import { useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { findBakedLeaf, type BakedLeaf } from "./bakedLeaf";
import {
  TEA_DOOR_ORIGIN,
  TEA_GROUND_Y,
  TEA_HINGE_ACTIVE_X,
  TEA_HINGE_PASSIVE_X,
  TEA_KNOB_INTERIOR_Z,
  TEA_KNOB_STREET_Z,
  TEA_KNOB_WORLD_Y,
  TEA_KNOB_X,
  TEA_SLAB_MID_Z,
  type TeaDoorController,
} from "./teaDoor";

/** Same asset DistrictWorld renders resident (GlbWorld's CITY3_URL);
 * useGLTF's cache hands back the SAME scene object, so the instance
 * edit below is what the resident render shows. */
const WORLD_URL = "/assets/world-city3.glb";
/** Tea's instance index inside inst_door_double (decoded + verified
 * against the measured translation at runtime before any edit). */
const TEA_INSTANCE = 6;

const DEG = Math.PI / 180;

type Bucket = "static" | "left" | "right";

/** Triangle classification over the DI_2 source geometry (door-local
 * coords, from the survey's triangle dump): the frame posts, sill,
 * lintel/transom and porch are static; the two leaf panels (low panel
 * + glass pane + centre-stile mouldings) split by centroid x sign.
 * The band y 0.58-1.00 is open in the authored geometry — nothing to
 * classify there; the invisible blocker is what makes it solid. */
function classify(cx: number, cy: number, cz: number): Bucket {
  if (cz > -0.05 || cy < 0.32 || Math.abs(cx) > 0.7 || cy > 2.38) return "static";
  if (cx < -0.02) return "left";
  if (cx > 0.02) return "right";
  return "static";
}

/** Split one source (indexed) geometry into static/left/right
 * non-indexed geometries, copying position/normal/uv per triangle. */
function splitGeometry(src: THREE.BufferGeometry): Record<Bucket, THREE.BufferGeometry> {
  const pos = src.getAttribute("position");
  const nor = src.getAttribute("normal");
  const uv = src.getAttribute("uv");
  const idx = src.getIndex();
  const triCount = (idx ? idx.count : pos.count) / 3;
  const buckets: Record<Bucket, number[]> = { static: [], left: [], right: [] };
  const v = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    const a = idx ? idx.getX(t * 3) : t * 3;
    const b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    let cx = 0, cy = 0, cz = 0;
    for (const i of [a, b, c]) {
      v.fromBufferAttribute(pos, i);
      cx += v.x; cy += v.y; cz += v.z;
    }
    buckets[classify(cx / 3, cy / 3, cz / 3)].push(a, b, c);
  }
  const out = {} as Record<Bucket, THREE.BufferGeometry>;
  for (const key of ["static", "left", "right"] as Bucket[]) {
    const list = buckets[key];
    const g = new THREE.BufferGeometry();
    const np = new Float32Array(list.length * 3);
    list.forEach((vi, k) => {
      np[k * 3] = pos.getX(vi); np[k * 3 + 1] = pos.getY(vi); np[k * 3 + 2] = pos.getZ(vi);
    });
    g.setAttribute("position", new THREE.BufferAttribute(np, 3));
    if (nor) {
      const nn = new Float32Array(list.length * 3);
      list.forEach((vi, k) => {
        nn[k * 3] = nor.getX(vi); nn[k * 3 + 1] = nor.getY(vi); nn[k * 3 + 2] = nor.getZ(vi);
      });
      g.setAttribute("normal", new THREE.BufferAttribute(nn, 3));
    }
    if (uv) {
      const nu = new Float32Array(list.length * 2);
      list.forEach((vi, k) => {
        nu[k * 2] = uv.getX(vi); nu[k * 2 + 1] = uv.getY(vi);
      });
      g.setAttribute("uv", new THREE.BufferAttribute(nu, 2));
    }
    out[key] = g;
  }
  return out;
}

interface BuiltDoor {
  group: THREE.Group;
  activePivot: THREE.Group;
  passivePivot: THREE.Group;
  disposables: THREE.BufferGeometry[];
  /** Hide the static originals (the tea instance + the baked leaf triangles). Idempotent; React StrictMode runs effects twice. */
  apply: () => void;
  /** Show them again. Idempotent. */
  restore: () => void;
  /** Debug: whether apply() is currently in force, and the tea instance's scale in each primitive mesh. */
  isApplied: () => boolean;
  instanceScales: () => number[];
}

function buildDoor(scene: THREE.Object3D): BuiltDoor | null {
  // Find the instanced double-door meshes (one per GLB primitive).
  const instanced: THREE.InstancedMesh[] = [];
  scene.traverse((o) => {
    const m = o as THREE.InstancedMesh;
    if (!m.isInstancedMesh) return;
    let p: THREE.Object3D | null = m;
    while (p) {
      if (p.name.includes("inst_door_double")) { instanced.push(m); return; }
      p = p.parent;
    }
  });
  if (!instanced.length) return null;

  // Verify the tea instance is where the survey measured it before
  // touching anything — a different build of the world must fail safe
  // (leave the static door alone) rather than hide the wrong leaf.
  const probe = new THREE.Matrix4();
  const tp = new THREE.Vector3();
  const tq = new THREE.Quaternion();
  const ts = new THREE.Vector3();
  for (const m of instanced) {
    if (m.count <= TEA_INSTANCE) return null;
    m.getMatrixAt(TEA_INSTANCE, probe);
    probe.decompose(tp, tq, ts);
    if (
      Math.abs(tp.x - TEA_DOOR_ORIGIN.x) > 0.02 ||
      Math.abs(tp.y - TEA_GROUND_Y) > 0.02 ||
      Math.abs(tp.z - TEA_DOOR_ORIGIN.z) > 0.02
    ) return null;
  }

  // Nothing is mutated here: the originals are only READ (apply()/restore() below hide and show them), so a second mount of the
  // effect (StrictMode in dev) puts the world back exactly as the first one found it.
  const originals: { mesh: THREE.InstancedMesh; matrix: THREE.Matrix4 }[] = [];
  const zero = new THREE.Matrix4().compose(
    new THREE.Vector3(TEA_DOOR_ORIGIN.x, TEA_GROUND_Y, TEA_DOOR_ORIGIN.z),
    new THREE.Quaternion(),
    new THREE.Vector3(0, 0, 0),
  );
  for (const m of instanced) {
    const orig = new THREE.Matrix4();
    m.getMatrixAt(TEA_INSTANCE, orig);
    originals.push({ mesh: m, matrix: orig });
  }

  // The painted LEAF (panels, rails, mullions, raised panels) is not in the instance: tools/city3 bakes it into the shared palette
  // mesh (bakedLeaf.ts). Find it by volume, so it hangs on the same pivots as the glass.
  let baked: BakedLeaf | null = null;
  let bakedMaterial: THREE.Material | THREE.Material[] | null = null;
  scene.traverse((o) => {
    if (baked) return;
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh) return;
    const found = findBakedLeaf(m.geometry, TEA_DOOR_ORIGIN);
    if (found) {
      baked = found;
      bakedMaterial = m.material;
    }
  });

  // Rebuild the leaf set as a pivoted assembly.
  const group = new THREE.Group();
  group.position.set(TEA_DOOR_ORIGIN.x, TEA_GROUND_Y, TEA_DOOR_ORIGIN.z);
  group.name = "tea-door-pilot";
  const activePivot = new THREE.Group();
  activePivot.position.set(TEA_HINGE_ACTIVE_X, 0, TEA_SLAB_MID_Z);
  const passivePivot = new THREE.Group();
  passivePivot.position.set(TEA_HINGE_PASSIVE_X, 0, TEA_SLAB_MID_Z);
  group.add(activePivot, passivePivot);

  const disposables: THREE.BufferGeometry[] = [];
  const knobMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.9, roughness: 0.35 });

  for (const m of instanced) {
    const split = splitGeometry(m.geometry);
    const mat = m.material;
    disposables.push(split.static);
    group.add(new THREE.Mesh(split.static, mat));
    const leftGeo = split.left;
    leftGeo.translate(-TEA_HINGE_ACTIVE_X, 0, -TEA_SLAB_MID_Z);
    disposables.push(leftGeo);
    activePivot.add(new THREE.Mesh(leftGeo, mat));
    const rightGeo = split.right;
    rightGeo.translate(-TEA_HINGE_PASSIVE_X, 0, -TEA_SLAB_MID_Z);
    disposables.push(rightGeo);
    passivePivot.add(new THREE.Mesh(rightGeo, mat));
  }

  if (baked && bakedMaterial) {
    const b = baked as BakedLeaf;
    // World coordinates -> pivot-local: subtract the group origin and the pivot's offset inside the group.
    b.left.translate(-(TEA_DOOR_ORIGIN.x + TEA_HINGE_ACTIVE_X), -TEA_GROUND_Y, -(TEA_DOOR_ORIGIN.z + TEA_SLAB_MID_Z));
    b.right.translate(-(TEA_DOOR_ORIGIN.x + TEA_HINGE_PASSIVE_X), -TEA_GROUND_Y, -(TEA_DOOR_ORIGIN.z + TEA_SLAB_MID_Z));
    disposables.push(b.left, b.right);
    activePivot.add(new THREE.Mesh(b.left, bakedMaterial));
    passivePivot.add(new THREE.Mesh(b.right, bakedMaterial));
  }

  // Knob on BOTH faces of the active leaf (street + interior centres
  // from teaDoor.ts), swinging with the leaf. Pivot-local z: the
  // faces sit at TEA_KNOB_*_Z relative to the door origin; the pivot
  // sits at the slab mid, so subtract TEA_SLAB_MID_Z. Height: the
  // assembly group sits at the leaf base (world 0.20) while the knob
  // centre is TEA_KNOB_WORLD_Y (0.80 above the 0.48 plinth).
  const knob = new THREE.Group();
  knob.position.set(TEA_KNOB_X - TEA_HINGE_ACTIVE_X, TEA_KNOB_WORLD_Y - TEA_GROUND_Y, 0);
  for (const faceZ of [TEA_KNOB_STREET_Z, TEA_KNOB_INTERIOR_Z]) {
    const centre = faceZ - TEA_SLAB_MID_Z;
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.035, 20, 14), knobMat);
    ball.position.set(0, 0, centre);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, Math.abs(centre), 10), knobMat);
    stem.rotation.x = Math.PI / 2;
    stem.position.set(0, 0, centre / 2);
    knob.add(ball, stem);
    disposables.push(ball.geometry, stem.geometry);
  }
  activePivot.add(knob);
  group.userData.knobMaterial = knobMat;

  let applied = false;
  return {
    group,
    activePivot,
    passivePivot,
    disposables,
    isApplied: () => applied,
    instanceScales: () => originals.map(({ mesh }) => {
      const m = new THREE.Matrix4();
      mesh.getMatrixAt(TEA_INSTANCE, m);
      return +new THREE.Vector3().setFromMatrixScale(m).x.toFixed(2);
    }),
    apply: () => {
      applied = true;
      for (const { mesh } of originals) {
        mesh.setMatrixAt(TEA_INSTANCE, zero);
        mesh.instanceMatrix.needsUpdate = true;
      }
      (baked as BakedLeaf | null)?.apply();
    },
    restore: () => {
      applied = false;
      for (const { mesh, matrix } of originals) {
        mesh.setMatrixAt(TEA_INSTANCE, matrix);
        mesh.instanceMatrix.needsUpdate = true;
      }
      (baked as BakedLeaf | null)?.restore();
    },
  };
}

/** Debug: every visible mesh/instance in the live scene overlapping the door volume (world box around the tea door). */
function nearbyDoorMeshes(root: THREE.Object3D) {
  const box = new THREE.Box3(
    new THREE.Vector3(TEA_DOOR_ORIGIN.x - 0.9, 0.3, TEA_DOOR_ORIGIN.z - 0.45),
    new THREE.Vector3(TEA_DOOR_ORIGIN.x + 0.9, 2.7, TEA_DOOR_ORIGIN.z + 0.3),
  );
  const out: { name: string; parents: string; material: string; instanced: boolean; where: string }[] = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    let vis = true;
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) vis = false;
    if (!vis) return;
    const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material;
    const chain = (() => { const c: string[] = []; for (let p = o.parent; p && c.length < 3; p = p.parent) c.push(p.name || "-"); return c.join("<"); })();
    const im = m as THREE.InstancedMesh;
    if (im.isInstancedMesh) {
      const mt = new THREE.Matrix4();
      const pt = new THREE.Vector3();
      const sc = new THREE.Vector3();
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, mt);
        pt.setFromMatrixPosition(mt);
        sc.setFromMatrixScale(mt);
        if (sc.x > 0.01 && box.containsPoint(pt)) out.push({ name: o.name, parents: chain, material: mat?.name ?? "", instanced: true, where: `inst ${i} @ ${pt.toArray().map((v) => v.toFixed(2)).join(",")} scale ${sc.x.toFixed(2)}` });
      }
      return;
    }
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    const bb = m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld);
    if (bb.intersectsBox(box)) {
      // for the big shared meshes only count triangles that sit inside the door box and have area
      let live = 0;
      const sample: string[] = [];
      const idx = m.geometry.getIndex();
      const pos = m.geometry.getAttribute("position");
      if (idx && pos && idx.count > 3000) {
        const v = new THREE.Vector3();
        for (let t = 0; t < idx.count / 3; t++) {
          const a = idx.getX(t * 3), b = idx.getX(t * 3 + 1), c = idx.getX(t * 3 + 2);
          if (a === b || b === c) continue;
          let inside = true;
          for (const i of [a, b, c]) { v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld); if (!box.containsPoint(v)) { inside = false; break; } }
          if (inside) {
            live++;
            if (sample.length < 6) sample.push([a, b, c].map((i) => v.fromBufferAttribute(pos, i).toArray().map((q) => q.toFixed(3)).join(" ")).join(" | "));
          }
        }
      }
      out.push({ name: o.name, parents: chain, material: mat?.name ?? "", instanced: false, where: idx && idx.count > 3000 ? `${live} live tris in box${live && live <= 6 ? ": " + sample.join(" // ") : ""}` : "small mesh in box" });
    }
  });
  return out;
}

export function TeaDoorLeaf({ controller }: { controller: TeaDoorController }) {
  const gltf = useGLTF(WORLD_URL);
  const built = useMemo(() => buildDoor(gltf.scene), [gltf.scene]);
  const rootScene = useThree((st) => st.scene);

  useEffect(() => {
    if (!built) return;
    built.apply();
    return () => {
      built.restore();
      for (const g of built.disposables) g.dispose();
      (built.group.userData.knobMaterial as THREE.Material | undefined)?.dispose();
    };
  }, [built]);

  useFrame(() => {
    if (!built) return;
    built.activePivot.rotation.y = controller.angle * DEG;
    built.passivePivot.rotation.y = -controller.passiveAngle * DEG;
  });

  // ?walkDebug=1: what the renderer is actually showing (headless checks): pivot angles in degrees, and whether the originals are hidden.
  useEffect(() => {
    if (!built || !new URLSearchParams(window.location.search).has("walkDebug")) return;
    const w = window as unknown as Record<string, unknown>;
    w.__teaDoorLeaf = {
      info: () => ({
        activeDeg: Math.round(built.activePivot.rotation.y / DEG),
        passiveDeg: Math.round(built.passivePivot.rotation.y / DEG),
        hidden: built.isApplied(),
        instances: built.instanceScales(),
        leafMeshes: built.activePivot.children.length + built.passivePivot.children.length,
        inScene: !!built.group.parent,
        nearby: nearbyDoorMeshes(rootScene),
      }),
    };
    return () => { delete w.__teaDoorLeaf; };
  }, [built, rootScene]);

  if (!built) return null;
  return <primitive object={built.group} />;
}

/**
 * Ticks the tea door machine once per rendered frame (leaf swing, auto-close, blocker) whoever is driving it. Mounted in
 * walk mode; in agent mode (frameloop "demand") Scout's sim interval ticks the door instead.
 */
export function TeaDoorTicker({ controller }: { controller: TeaDoorController }) {
  useFrame((_, delta) => controller.tick(Math.min(delta, 0.25)));
  return null;
}
