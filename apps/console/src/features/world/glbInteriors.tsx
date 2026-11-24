// City 3 interiors: the room index, the cutaway, and the streamed
// interior rooms (extracted from GlbWorld.tsx, cleanup L2).
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import { extendGltf } from "./gltfExtensions";
import * as THREE from "three";
import { useTileEpoch } from "./tileScenes";
import { buildColliders } from "./CameraCollider";
import { registerCameraObstacle } from "./cameraClearance";
import { CITY3_INDEX_URL, CITY3_LIBRARY_URL, HIDE_WITHIN, INTERIOR_KEEP_WITHIN, INTERIOR_LOAD_WITHIN, MAX_LOADED_INTERIORS, SHOW_BEYOND, roomView, syntheticRooms, type City3Room } from "./city3";
import { boxPlanes, inactivePlanes, pickCutRoom } from "./cutaway";
import { buildInterior, indexLibrary, type InteriorHandle } from "./interiorBuild";
import { TEA_HOUSE_RADIO_ASSET, teaHouseRadio } from "./teaHouseRadio";
import { colUrl, parseColBoxes, planStreaming, type InteriorLayout } from "./interiors";
import { boxesMesh } from "./capsuleWorld";
import { WalkColliders } from "./walkColliders";
import { InteractController, type InteractableDef } from "./interactables";
import { buildInteractableVisual } from "./interactableMesh";
import { teaCutHeight, teaEntranceView, teaViewTargetHeight } from "./teaBuilding";

/** City 3's room index (generated: tools/city3/out/interiors/index.json); empty until fetched. */
export function useCity3Rooms(enabled: boolean): City3Room[] {
  const [rooms, setRooms] = useState<City3Room[]>([]);
  useEffect(() => {
    if (!enabled || rooms.length) return;
    let live = true;
    fetch(CITY3_INDEX_URL)
      .then((r) => r.json() as Promise<City3Room[]>)
      .then((r) => live && setRooms(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [enabled, rooms.length]);
  return rooms;
}

/**
 * City 3 cutaway: opens one building at a time with a clipping box. Every room building's upper
 * floors and roof sit in the merged city meshes, so instead of hiding objects the city materials get
 * six shared clipping planes with clipIntersection (a fragment is discarded only inside the box);
 * moving the box updates uniforms and never recompiles a shader. `focus` flies to a room.
 */
export function ClipCutaway({
  rooms,
  focus,
  teaFloor,
  walking,
}: {
  rooms: City3Room[];
  focus: { id: string; nonce: number } | null;
  teaFloor: number | null;
  walking: boolean;
}) {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const controls = useThree((s) => s.controls) as unknown as {
    target: THREE.Vector3;
    update: () => void;
  } | null;
  const planes = useMemo(
    () => inactivePlanes().map(([x, y, z, c]) => new THREE.Plane(new THREE.Vector3(x, y, z), c)),
    [],
  );
  const open = useRef<string | null>(null);
  const cutRooms = useMemo(() => rooms.filter(r => r.id !== "tea" || (focus?.id === "tea" && teaFloor !== null)).map((r) => ({ id: r.id, center: r.center, rect: r.rect, cut: r.cut })), [rooms, teaFloor, focus]);
  const cutHeight = useRef<number | null>(null);
  useEffect(() => {
    open.current = null;
    cutHeight.current = null;
    gl.localClippingEnabled = true;
    const mats = new Set<THREE.Material>();
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh) return; // library furnishings are never clipped
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) if(!mat.userData.noCutaway) mats.add(mat);
    });
    for (const mat of mats) {
      mat.clippingPlanes = planes;
      mat.clipIntersection = true;
      mat.clipShadows = true;
      mat.needsUpdate = true;
    }
    return () => {
      for (const mat of mats) {
        mat.clippingPlanes = null;
        mat.clipIntersection = false;
        mat.clipShadows = false;
        mat.needsUpdate = true;
      }
      gl.localClippingEnabled = false;
    };
  }, [scene, gl, planes]);
  // Tile mode: geometry streams in after the effect above ran, so its materials never got the clip planes. Give every
  // tile material the shared planes as it arrives (same rule as above; no reset of the open room).
  const tileEpoch = useTileEpoch();
  useEffect(() => {
    if (!tileEpoch) return;
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh) return;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        if (mat.userData.noCutaway || mat.clippingPlanes === planes) continue;
        mat.clippingPlanes = planes; mat.clipIntersection = true; mat.clipShadows = true; mat.needsUpdate = true;
      }
    });
  }, [scene, planes, tileEpoch]);
  useEffect(() => {
    const room = focus && rooms.find((r) => r.id === focus.id);
    if (!room || !controls || walking) return;
    const v = roomView(room);
    if (room.id === "tea") {
      if (teaFloor === 0) {
        // Ground floor: stand in the entrance and look in, eye level.
        const e = teaEntranceView(room);
        v.position = e.position;
        v.target = e.target;
      } else {
        const y = teaFloor === null ? 7.5 : teaViewTargetHeight(teaFloor);
        v.target[1] = y;
        v.position[1] = teaFloor === null ? 24 : y + 15;
      }
    }
    camera.position.set(...v.position);
    controls.target.set(...v.target);
    controls.update();
  }, [focus, rooms, camera, controls, teaFloor, walking]);
  useFrame(() => {
    // What the camera is looking at decides which building opens, not where the camera stands
    // (from a street-side viewpoint the nearest building centre is often across the road).
    const target = controls?.target;
    if (!target) return;
    const candidate = pickCutRoom(
      cutRooms,
      { x: target.x, z: target.z },
      camera.position.distanceTo(target),
      open.current,
      HIDE_WITHIN,
      SHOW_BEYOND,
    );
    const next = walking ? null : candidate;
    const height = next === "tea" && teaFloor !== null ? teaCutHeight(teaFloor) : null;
    if (next === open.current && height === cutHeight.current) return;
    open.current = next;
    cutHeight.current = height;
    const box = next ? rooms.find((r) => r.id === next)!.cut : null;
    const spec = box ? boxPlanes(height === null ? box : { ...box, y: height }) : inactivePlanes();
    spec.forEach(([x, y, z, c], i) => {
      planes[i].normal.set(x, y, z);
      planes[i].constant = c;
    });
  });
  return null;
}

/**
 * Streams City 3's interiors by camera distance. One shared asset library is
 * fetched the first time any room is near; each room is a small layout JSON
 * built into instanced meshes over that library. At most MAX_LOADED_INTERIORS
 * stay resident: farther or surplus rooms are dropped and their instance
 * buffers disposed (geometry and materials stay with the library).
 *
 * `?streamDebug=1` exposes window.__city3Stream (counters, renderer memory,
 * teleport) for the memory test; `&fake=N` adds N synthetic rooms to arbitrate.
 */
export function InteriorStreamer({ rooms: realRooms, walk, interact }: { rooms: City3Room[]; walk?: WalkColliders; interact?: InteractController }) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const controls = useThree((s) => s.controls) as unknown as {
    target: THREE.Vector3;
    update: () => void;
  } | null;
  const debug = useMemo(() => new URLSearchParams(window.location.search).get("streamDebug") === "1", []);
  const heroes = useMemo<City3Room[]>(() => {
    const n = Number(new URLSearchParams(window.location.search).get("fake") ?? 0);
    const src = realRooms.find((r) => r.id === "press") ?? realRooms[0];
    return debug && n > 0 && src ? [...realRooms, ...syntheticRooms(n, src)] : realRooms;
  }, [debug, realRooms]);
  const [wanted, setWanted] = useState<string[]>([]);
  const wantedRef = useRef<string[]>([]);
  const layouts = useRef(new Map<string, InteriorLayout>());
  const inflight = useRef(new Set<string>());
  const [layoutsReady, setLayoutsReady] = useState<string[]>([]);
  const acc = useRef(1);
  const stats = useRef({ loads: 0, evictions: 0, maxResident: 0, builds: 0 });
  const handles = useRef(new Map<string, InteriorHandle>());

  useFrame((_, dt) => {
    acc.current += dt;
    if (acc.current < 0.25) return;
    acc.current = 0;
    const plan = planStreaming({
      cam: camera.position,
      heroes: heroes.map((h) => ({ id: h.id, center: h.center })),
      loaded: wantedRef.current,
      loadWithin: INTERIOR_LOAD_WITHIN,
      keepWithin: INTERIOR_KEEP_WITHIN,
      maxLoaded: MAX_LOADED_INTERIORS,
    });
    if (!plan.load.length && !plan.evict.length) return;
    stats.current.loads += plan.load.length;
    stats.current.evictions += plan.evict.length;
    wantedRef.current = wantedRef.current.filter((id) => !plan.evict.includes(id)).concat(plan.load);
    stats.current.maxResident = Math.max(stats.current.maxResident, wantedRef.current.length);
    setWanted(wantedRef.current);
    for (const id of plan.load) {
      const hero = heroes.find((h) => h.id === id);
      if (!hero || layouts.current.has(hero.layout) || inflight.current.has(hero.layout)) continue;
      const url = hero.layout;
      inflight.current.add(url); // rooms that share a layout fetch it once
      fetch(url)
        .then((r) => r.json() as Promise<InteriorLayout>)
        .then((l) => {
          layouts.current.set(url, l);
          setLayoutsReady((r) => (r.includes(url) ? r : [...r, url]));
        })
        .catch(() => {})
        .finally(() => inflight.current.delete(url));
    }
  });

  useEffect(() => {
    if (!debug) return;
    const w = window as unknown as Record<string, unknown>;
    w.__city3Stream = {
      /** World position + bounding box of the first scene object with this name (e.g. "interactable:tea-radio", "tea-radio:pilot"). */
      probe: (name: string) => {
        const o = scene.getObjectByName(name);
        if (!o) return null;
        o.updateWorldMatrix(true, true);
        const pos = new THREE.Vector3();
        o.getWorldPosition(pos);
        const box = new THREE.Box3().setFromObject(o);
        return { pos: pos.toArray(), min: box.min.toArray(), max: box.max.toArray(), children: o.children.map((c) => c.name) };
      },
      snapshot: () => ({
        resident: [...wantedRef.current],
        built: [...handles.current.keys()],
        ...stats.current,
        drawCallsInteriors: [...handles.current.values()].reduce((a, h) => a + h.drawCalls, 0),
        memory: { geometries: gl.info.memory.geometries, textures: gl.info.memory.textures },
        render: { calls: gl.info.render.calls, triangles: gl.info.render.triangles },
        scene: (() => {
          const ims: THREE.InstancedMesh[] = [];
          scene.traverse((o) => {
            if ((o as THREE.InstancedMesh).isInstancedMesh) ims.push(o as THREE.InstancedMesh);
          });
          const f = ims[0];
          const m = new THREE.Matrix4();
          const p = new THREE.Vector3();
          if (f) f.getMatrixAt(0, m);
          p.setFromMatrixPosition(m);
          return {
            instancedMeshes: ims.length,
            visible: ims.filter((i) => i.visible).length,
            first: f ? { name: f.name, count: f.count, pos0: p.toArray(), sphere: f.boundingSphere ? [f.boundingSphere.center.toArray(), f.boundingSphere.radius] : null, parent: f.parent?.name, matWorldPos: new THREE.Vector3().setFromMatrixPosition(f.matrixWorld).toArray() } : null,
          };
        })(),
      }),
      teleport: (x: number, y: number, z: number) => {
        camera.position.set(x, y, z);
        controls?.target.set(x, 0, z - 20);
        controls?.update();
      },
    };
    return () => {
      delete w.__city3Stream;
    };
  }, [debug, gl, scene, camera, controls]);

  return (
    <Suspense fallback={null}>
      {wanted.length ? (
        <StreamedRooms
          ids={wanted}
          heroes={heroes}
          layouts={layouts.current}
          ready={layoutsReady}
          handles={handles.current}
          stats={stats.current}
          walk={walk}
          interact={interact}
        />
      ) : null}
    </Suspense>
  );
}

/** Mounts one InteriorRoom per resident id once the shared library has loaded. */
function StreamedRooms({
  ids,
  heroes,
  layouts,
  ready,
  handles,
  stats,
  walk,
  interact,
}: {
  ids: string[];
  heroes: City3Room[];
  layouts: Map<string, InteriorLayout>;
  ready: string[];
  handles: Map<string, InteriorHandle>;
  stats: { builds: number };
  walk?: WalkColliders;
  interact?: InteractController;
}) {
  const gl = useThree((s) => s.gl);
  const library = useGLTF(CITY3_LIBRARY_URL, true, true, extendGltf(gl));
  const assets = useMemo(() => {
    const indexed = indexLibrary(library.scene);
    indexed.set(TEA_HOUSE_RADIO_ASSET, teaHouseRadio());
    return indexed;
  }, [library]);
  // Pay the texture-upload cost once, here, instead of as a hitch the first time a room draws.
  useEffect(() => {
    const seen = new Set<THREE.Texture>();
    library.scene.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      const tex = mat?.map;
      if (tex && !seen.has(tex)) {
        seen.add(tex);
        gl.initTexture(tex);
      }
    });
  }, [library, gl]);
  return (
    <>
      {ids.map((id) => {
        const hero = heroes.find((h) => h.id === id);
        const layout = hero ? layouts.get(hero.layout) : undefined;
        if (!hero || !layout || !ready.length) return null;
        return (
          <InteriorRoom key={id} id={id} layout={layout} layoutUrl={hero.layout} assets={assets} offset={hero.shift ?? ZERO_SHIFT} handles={handles} stats={stats} walk={walk} interactables={hero.interactables} interact={interact} />
        );
      })}
    </>
  );
}

const ZERO_SHIFT: [number, number] = [0, 0];

function InteriorRoom({
  id,
  layout,
  layoutUrl,
  assets,
  offset,
  handles,
  stats,
  walk,
  interactables,
  interact,
}: {
  id: string;
  layout: InteriorLayout;
  layoutUrl: string;
  assets: Map<string, THREE.Object3D>;
  offset: [number, number];
  handles: Map<string, InteriorHandle>;
  stats: { builds: number };
  walk?: WalkColliders;
  /** Usable props of this room (the radio): cloned from the library, owned by this room's lifecycle. */
  interactables?: InteractableDef[];
  interact?: InteractController;
}) {
  // Built inside the effect, not memoised: React (StrictMode in dev) runs cleanup then the effect
  // again on the same render, and a memoised handle would come back already disposed and empty.
  const [handle, setHandle] = useState<InteriorHandle | null>(null);
  useEffect(() => {
    const h = buildInterior(layout, assets, offset);
    handles.set(id, h);
    stats.builds += 1;
    // Usable props: plain meshes over the shared library + a pilot light of our own, wired to the controller's state.
    const visuals: { stop: () => void; dispose: () => void }[] = [];
    for (const def of interactables ?? []) {
      const v = buildInteractableVisual(def, assets, offset);
      if (!v) continue;
      h.group.add(v.group);
      v.setOn(interact?.isOn(def.id) ?? false);
      const unsub = interact?.subscribe((pid, on) => { if (pid === def.id) v.setOn(on); });
      visuals.push({ stop: () => unsub?.(), dispose: v.dispose });
    }
    buildColliders(h.group);
    const unregisterCamera = registerCameraObstacle(h.group);
    setHandle(h);
    return () => {
      unregisterCamera();
      for (const v of visuals) { v.stop(); v.dispose(); }
      handles.delete(id);
      h.dispose();
      setHandle(null);
    };
  }, [id, layout, assets, offset, handles, stats, interactables, interact]);
  // Invisible furniture boxes for the walker (one merged BVH), fetched with the room and dropped on eviction.
  useEffect(() => {
    if (!walk) return;
    let live = true;
    const key = `interior:${id}`;
    fetch(colUrl(layoutUrl))
      .then((r) => (r.ok ? r.json() : []))
      .then((j) => {
        if (!live) return;
        const m = boxesMesh(parseColBoxes(j), offset, key);
        if (m) walk.set(key, [m]);
      })
      .catch(() => {});
    return () => { live = false; walk.drop(key); };
  }, [id, layoutUrl, offset, walk]);
  return handle ? <primitive object={handle.group} /> : null;
}
