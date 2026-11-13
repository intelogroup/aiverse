import { splitTeaPanels } from "./teaDoorPanels";
import { registerCameraObstacle } from "./cameraClearance";
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
 *   3. drives the pivots from the TeaDoorController's angles every
 *      frame (active rotation.y = +angle into the room, passive
 *      mirrored at -angle — see teaDoor.ts for the hinge geometry).
 *
 * On unmount the original instance matrices are restored and the
 * split geometries disposed (the source geometry/materials are the
 * GLB's shared ones and are never mutated or disposed here).
 */

import { useGLTF } from "@react-three/drei";
import { assetUrl } from "../../lib/assetUrl";
import { extendGltf } from "./gltfExtensions";
import { useFrame, useThree } from "@react-three/fiber";
import { useLayoutEffect, useState } from "react";
import { TILES } from "./tilesMode";
import { useTileScene } from "./tileScenes";
import * as THREE from "three";
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
const WORLD_URL = assetUrl("/assets/world-city3.glb");
/** The tea tile (tools/city3/build_tiles.sh --hero): the tile that holds the whole Tea House, door instance included. */
const TEA_TILE = "tea";

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
  restore: () => void;
}

/** Exported for tests/tea-tile.test.ts (the shipped tea tile must still yield a door). */
export function buildDoor(scene: THREE.Object3D): BuiltDoor | null {
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

  // Find the tea instance by where the survey measured it, in every primitive mesh, before touching anything — a different
  // build of the world must fail safe (leave the static door alone) rather than hide the wrong leaf. The index is found, not
  // assumed: the monolith had it at 6, a world tile keeps only the instances that fall inside it.
  const probe = new THREE.Matrix4();
  const tp = new THREE.Vector3();
  const tq = new THREE.Quaternion();
  const ts = new THREE.Vector3();
  const teaIndex = new Map<THREE.InstancedMesh, number>();
  for (const m of instanced) {
    const hits: number[] = [];
    for (let i = 0; i < m.count; i++) {
      m.getMatrixAt(i, probe);
      probe.decompose(tp, tq, ts);
      if (Math.abs(tp.x - TEA_DOOR_ORIGIN.x) <= 0.02 && Math.abs(tp.y - TEA_GROUND_Y) <= 0.02 && Math.abs(tp.z - TEA_DOOR_ORIGIN.z) <= 0.02) hits.push(i);
    }
    if (hits.length !== 1) return null;
    teaIndex.set(m, hits[0]);
  }

  // Hide the tea instance in every primitive mesh; remember the
  // originals for restore-on-unmount.
  const originals: { mesh: THREE.InstancedMesh; matrix: THREE.Matrix4; index: number }[] = [];
  const zero = new THREE.Matrix4().compose(
    new THREE.Vector3(TEA_DOOR_ORIGIN.x, TEA_GROUND_Y, TEA_DOOR_ORIGIN.z),
    new THREE.Quaternion(),
    new THREE.Vector3(0, 0, 0),
  );
  for (const m of instanced) {
    const orig = new THREE.Matrix4();
    const index = teaIndex.get(m)!;
    m.getMatrixAt(index, orig);
    originals.push({ mesh: m, matrix: orig, index });
    m.setMatrixAt(index, zero);
    m.instanceMatrix.needsUpdate = true;
  }

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
  const knobMat = new THREE.MeshStandardMaterial({ color: 0xc29a53, metalness: 0.72, roughness: 0.32 });

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

  // Colour-dependent green timber is in the baked palette, not inst_door_double.
  // Swap geometry rather than mutate shared position buffers; restore on unmount.
  const panels: { mesh: THREE.Mesh; geometry: THREE.BufferGeometry }[] = [];
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh || mesh.name !== "Props") return;
    const split = splitTeaPanels(mesh.geometry, mesh.matrixWorld);
    if (!split) return;
    panels.push({ mesh, geometry: mesh.geometry });
    mesh.geometry = split.remaining;
    disposables.push(split.remaining, split.left, split.right);
    split.left.translate(-TEA_HINGE_ACTIVE_X, 0, -TEA_SLAB_MID_Z);
    split.right.translate(-TEA_HINGE_PASSIVE_X, 0, -TEA_SLAB_MID_Z);
    activePivot.add(new THREE.Mesh(split.left, mesh.material));
    passivePivot.add(new THREE.Mesh(split.right, mesh.material));
  });

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
    ball.scale.set(1, 1, 0.82);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, Math.abs(centre), 10), knobMat);
    stem.rotation.x = Math.PI / 2;
    stem.position.set(0, 0, centre / 2);
    const rosette = new THREE.Mesh(new THREE.CylinderGeometry(0.047, 0.047, 0.008, 24), knobMat);
    rosette.rotation.x = Math.PI / 2;
    rosette.position.z = centre - Math.sign(centre) * 0.031;
    // The fixed grasp point is inside the glazed opening. A plate extends to the meeting stile.
    const backplate = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.095, 0.012), knobMat);
    backplate.position.set(0.05, 0, centre - Math.sign(centre) * 0.055);
    knob.add(ball, stem, rosette, backplate);
    disposables.push(ball.geometry, stem.geometry, rosette.geometry, backplate.geometry);
  }
  activePivot.add(knob);
  group.userData.knobMaterial = knobMat;

  return {
    group,
    activePivot,
    passivePivot,
    disposables,
    restore: () => {
      for (const { mesh, geometry } of panels) mesh.geometry = geometry;
      for (const { mesh, matrix, index } of originals) {
        mesh.setMatrixAt(index, matrix);
        mesh.instanceMatrix.needsUpdate = true;
      }
    },
  };
}

export function TeaDoorLeaf({ controller }: { controller: TeaDoorController }) {
  return TILES ? <TeaDoorLeafTile controller={controller} /> : <TeaDoorLeafMono controller={controller} />;
}
function TeaDoorLeafMono({ controller }: { controller: TeaDoorController }) {
  const gl = useThree((s) => s.gl);
  const gltf = useGLTF(WORLD_URL, true, true, extendGltf(gl));
  return <TeaDoorLeafView controller={controller} scene={gltf.scene} />;
}
/** Tile mode: wait for the tea tile to stream in; the door leaf appears once it has. */
function TeaDoorLeafTile({ controller }: { controller: TeaDoorController }) {
  const scene = useTileScene(TEA_TILE);
  return scene ? <TeaDoorLeafView controller={controller} scene={scene} /> : null;
}
function TeaDoorLeafView({ controller, scene }: { controller: TeaDoorController; scene: THREE.Object3D }) {
  const [built, setBuilt] = useState<BuiltDoor | null>(null);

  useLayoutEffect(() => {
    const built = buildDoor(scene);
    setBuilt(built);
    if (!built) return;
    const unregister = registerCameraObstacle(built.group);
    return () => {
      unregister();
      built.restore();
      for (const g of built.disposables) g.dispose();
      (built.group.userData.knobMaterial as THREE.Material | undefined)?.dispose();
    };
  }, [scene]);

  useFrame(() => {
    if (!built) return;
    built.activePivot.rotation.y = controller.angle * DEG;
    built.passivePivot.rotation.y = -controller.passiveAngle * DEG;
  });

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
