import { TeaElevator, TeaElevatorHud } from "./TeaElevatorView";
import { TeaElevatorController } from "./teaElevator";
import { VerseRecorder } from "./VerseRecorder";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, useGLTF, useProgress } from "@react-three/drei";
import * as THREE from "three";
import { DistrictWorld } from "./DistrictWorld";
import { buildColliders } from "./CameraCollider";
import { registerCameraObstacle } from "./cameraClearance";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { BazaarLife, type BazaarFigureTap } from "./BazaarLife";
import { MiraResident } from "./MiraResident";
import {
  mobileShell,
  spawnRequestForPoint,
  spawnRequestForRoom,
  type WalkSpawnRequest,
} from "./mobileShell";
import { TeaBartender } from "./TeaBartender";
import { BARTENDER_LINES } from "./bartender";
import { CityWalker } from "./CityWalker";
import { TouchWalkSource, setLookPrefs } from "./walkTouch";
import {
  InteractHighlight,
  TouchTapPicker,
  TouchWalkLayer,
  useTouchUi,
  type TapPicker,
} from "./TouchWalkLayer";
import { ScoutAgent } from "./ScoutAgent";
import { WalkClipOverride, type WalkFrameInfo } from "./walkOverride";
import { SoundDirector } from "./soundDirector";
import { VOICE_BARTENDER, benchPhonon, phononWarmth, synthLine, warmPhonon } from "./phononTts";
import { GREETING_SCRIPT, createPlazaGreeting, type PlazaGreeting } from "./plazaTts";
import { type CameraMode } from "./cameraRig";
import { FpsMeter } from "./fpsMeter";
import { QualityGovernor, dprForTier, qualityStore, shadowMapForTier } from "./quality";
import {
  LONG_PRESS_MAX_MOVE_PX,
  LONG_PRESS_MS,
  coachSeen,
  comfortStore,
  hapticTick,
  isReducedMotion,
  markCoachSeen,
} from "./comfort";
import {
  CITY3_INDEX_URL,
  CITY3_LIBRARY_URL,
  HIDE_WITHIN,
  INTERIOR_KEEP_WITHIN,
  INTERIOR_LOAD_WITHIN,
  MAX_LOADED_INTERIORS,
  SHOW_BEYOND,
  roomView,
  syntheticRooms,
  type City3Room,
} from "./city3";
import { boxPlanes, inactivePlanes, pickCutRoom } from "./cutaway";
import { buildInterior, indexLibrary, type InteriorHandle } from "./interiorBuild";
import { colUrl, parseColBoxes, planStreaming, type InteriorLayout } from "./interiors";
import { boxesMesh } from "./capsuleWorld";
import { WalkColliders } from "./walkColliders";
import { PLAYER, TEA_BLOCKER_BOX, TeaDoorController } from "./teaDoor";
import { InteractController, type InteractableDef } from "./interactables";
import { buildInteractableVisual } from "./interactableMesh";
import { InteractTicker } from "./InteractTicker";
import { TeaDoorLeaf, TeaDoorTicker } from "./TeaDoorLeaf";
import { loadPercent, worldLoadPhase } from "./worldLoad";
import { TEA_FLOORS, teaCutHeight, teaEntranceView, teaViewTargetHeight } from "./teaBuilding";

// GlbWorld — the modeled world (Blender-authored GLB) as the console's
// default stage: City 3, the Sunstone Bazaar — a 360 m island (generated
// by the city3 pipeline), plaza at the origin, every walkable surface
// flush at y = 0.2.
//
//   (The Agora — the lobby island whose crowd walked a deck disc — was
//   removed 2026-11-08 at Jim's word, the way City 1 and City 2 were:
//   its GLB, its deck crowd and the embody spike are gone, and a lobby
//   returns later as a planned feature. ?world=agora — like the removed
//   city/city2 — now lands on City 3, the only world.)
//
// Spectator framing throughout: a perspective camera + OrbitControls,
// no avatar driving. The stage opens at an elevated three-quarter view
// that frames the whole island; OrbitControls stays above the horizon
// so nobody can duck under the world. The stage is lit for PBR with
// three's built-in RoomEnvironment. One shadow-casting key light for
// grounding, and a modest ambient fill.

const CITY3_URL = "/assets/world-city3.glb";

// The island's plaza origin.
const CITY3_CENTER: [number, number] = [0, 0];

/** City 3's room index (generated: tools/city3/out/interiors/index.json); empty until fetched. */
function useCity3Rooms(enabled: boolean): City3Room[] {
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
function ClipCutaway({
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
function InteriorStreamer({ rooms: realRooms, walk, interact }: { rooms: City3Room[]; walk?: WalkColliders; interact?: InteractController }) {
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
  const library = useGLTF(CITY3_LIBRARY_URL);
  const assets = useMemo(() => indexLibrary(library.scene), [library]);
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

/**
 * Environment for the stage. City 3 uses three's built-in
 * RoomEnvironment: with no environment at all, AgX + the single key
 * light washed the district foliage pale (the districts' palette data
 * was intact in the GLBs). DistrictWorld drives
 * scene.environmentIntensity from the blended theme's envIntensity, so
 * the 0.6 set here is only the pre-first-tick value.
 */
function StageEnvironment() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    // Matched tone-curve pair with the Blender authoring (AgX view transform):
    // R3F otherwise defaults to ACES Filmic, which grades the stage on a
    // different curve than the one it was authored under.
    gl.toneMapping = THREE.AgXToneMapping;
    gl.toneMappingExposure = 1.1;
    const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envMap;
    scene.environmentIntensity = 0.6;
    return () => {
      scene.environment = null;
      envMap.dispose();
      pmrem.dispose();
    };
  }, [gl, scene]);
  return null;
}

/**
 * The stage's one shadow-casting key light, its ortho shadow camera
 * fitted to City 3's span. The target is added to the scene graph
 * explicitly — three only tracks a light's aim if the target's
 * matrixWorld updates.
 */
function KeyLight({ lightRef }: { lightRef?: React.RefObject<THREE.DirectionalLight | null> }) {
  const ownRef = useRef<THREE.DirectionalLight>(null!);
  const light = (lightRef ?? ownRef) as React.RefObject<THREE.DirectionalLight>;
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const l = light.current;
    l.target.position.set(CITY3_CENTER[0], 0, CITY3_CENTER[1]);
    scene.add(l.target);
    l.target.updateMatrixWorld();
    return () => {
      l.target.removeFromParent();
    };
  }, [scene]);
  // Mobile Phase 3: the tier sizes (or kills) the shadow map. The
  // store only moves on the touch path, so desktop reads "full"
  // forever — 2048 and casting, exactly as before. The key remounts
  // the light when the map size changes (three will not realloc a
  // live shadow map).
  const quality = useSyncExternalStore(qualityStore.subscribe, qualityStore.getSnapshot);
  const shadowMap = shadowMapForTier(quality.tier);
  return (
    <directionalLight
      key={shadowMap}
      ref={light}
      castShadow={shadowMap > 0}
      position={[120, 220, 90]}
      intensity={2.6}
      shadow-mapSize-width={Math.max(shadowMap, 1)}
      shadow-mapSize-height={Math.max(shadowMap, 1)}
      shadow-camera-left={-220}
      shadow-camera-right={220}
      shadow-camera-top={220}
      shadow-camera-bottom={-220}
      shadow-camera-near={10}
      shadow-camera-far={800}
      shadow-bias={-0.0004}
      // City 3 spans 440 m of shadow frustum on one map: its flat roofs and
      // plaza need a wide normal bias or the soft shadow shows acne rings.
      shadow-normalBias={0.8}
    />
  );
}

/**
 * Flags every mesh in the stage as a shadow caster/receiver. The world
 * GLB and the cast figures both arrive as raw primitives (neither sets
 * shadow flags), so the stage tags them itself: opaque meshes cast and
 * receive, transparent ones (the hologlobe shell) only receive. The
 * walk is throttled and skips meshes it has already tagged, so after the
 * first pass it costs a few hundred no-op node visits a few times a
 * second — cast members load async, hence the repeats.
 */
function ShadowTagger() {
  const scene = useThree((s) => s.scene);
  const acc = useRef(1); // first frame tags immediately
  useFrame((_, delta) => {
    acc.current += delta;
    if (acc.current < 0.3) return;
    acc.current = 0;
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.__glbShadowTagged) return;
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      mesh.castShadow = !mat?.transparent;
      mesh.receiveShadow = true;
      mesh.userData.__glbShadowTagged = true;
    });
  });
  return null;
}

/**
 * Render-rate tracker: one timestamp per rendered frame into the
 * shared FpsMeter (fpsMeter.ts), which the touch QualityDriver reads
 * to govern the quality tier. Mounted on the touch path — the meter
 * costs one array push per frame.
 */
function FpsTracker({ meterRef }: { meterRef: RefObject<FpsMeter | null> }) {
  useFrame((state) => {
    meterRef.current?.push(state.clock.elapsedTime * 1000);
  });
  return null;
}

/**
 * Mobile Phase 3: the quality governor's driver. Once a second it
 * feeds the FpsMeter's rolling rate to a QualityGovernor and lands
 * verdicts on the shared quality store (which the Canvas props and
 * the You sheet read). Mounted on the touch path only — desktop
 * quality never moves.
 */
function QualityDriver({ meterRef }: { meterRef: RefObject<FpsMeter | null> }) {
  const governor = useRef<QualityGovernor | null>(null);
  if (governor.current === null) governor.current = new QualityGovernor("reduced");
  const acc = useRef(0);
  useFrame((_, delta) => {
    acc.current += delta;
    if (acc.current < 1) return;
    acc.current = 0;
    const meter = meterRef.current;
    if (!meter) return;
    const verdict = governor.current?.sample(meter.fps(), performance.now());
    if (verdict) qualityStore.govern(verdict);
  });
  return null;
}

/** Fires once when the Suspense subtree it sits in actually mounts —
 * the "the world is on screen" signal the loading overlay waits for. */
function PresentedSignal({ onPresented }: { onPresented: () => void }) {
  useEffect(() => {
    onPresented();
  }, [onPresented]);
  return null;
}

/**
 * E1 — the stage's loading state (worldLoad.ts decides the phase;
 * skeleton-states.md is the rulebook). The Suspense fallback inside
 * the Canvas stays null — a DOM overlay is where a human-facing
 * state belongs: world name, skeleton, the LoadingManager's real
 * progress, and an honest error with a retry when it fails.
 * Cross-fades out once the world presents; never traps the user.
 */
function WorldLoadOverlay({
  presented,
  onRetry,
}: {
  presented: boolean;
  onRetry: () => void;
}) {
  const { progress, errors } = useProgress();
  const [startedAt] = useState(() => performance.now());
  const [now, setNow] = useState(() => performance.now());
  const [gone, setGone] = useState(false);
  const phase = worldLoadPhase({
    presented,
    failed: errors.length > 0,
    elapsedMs: now - startedAt,
  });
  useEffect(() => {
    if (phase === "ready") {
      const id = setTimeout(() => setGone(true), 380);
      return () => clearTimeout(id);
    }
    const id = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(id);
  }, [phase]);
  if (gone || phase === "waiting") return null;
  const pct = loadPercent(progress);
  return (
    <div className={`w-load${phase === "ready" ? " leaving" : ""}`} role="status" aria-live="polite">
      {phase !== "ready" ? (
        <div className="w-load-card">
          <div className="w-load-eyebrow">Entering the verse</div>
          {phase === "failed" ? (
            <>
              <div className="w-load-title">The world didn’t load</div>
              <p className="w-load-sub">
                Something interrupted the download. Check your connection, then try again.
              </p>
              <div className="w-load-actions">
                <button type="button" className="w-load-primary" onClick={onRetry}>
                  Retry
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="w-load-title">City 3</div>
              <p className="w-load-sub">
                {phase === "stalled"
                  ? "Still loading — this is a large world and a real download."
                  : "Loading the world and its cast."}
              </p>
              <div className="w-load-shimmer w-load-line-lg" aria-hidden="true" />
              <div className="w-load-shimmer w-load-line-sm" aria-hidden="true" />
              {phase === "progress" || phase === "stalled" ? (
                <div
                  className="w-load-bar"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={pct}
                  aria-label="Loading City 3"
                >
                  <i style={{ width: `${pct}%` }} />
                </div>
              ) : null}
              {phase === "progress" || phase === "stalled" ? (
                <div className="w-load-pct">{pct}%</div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * F1 — the central-PA banner at the shell level. It used to render
 * only inside the walk HUD panel, so a spectator in the default wide
 * view never saw an announcement. One banner, above the stage, fed
 * by the same director: listener-scoped while walking, viewing-
 * district-scoped while spectating (SoundDirector.tickSpectator).
 */
function ShellPaBanner({
  sound,
  spectator,
}: {
  sound: SoundDirector;
  spectator: boolean;
}) {
  const [, setPulse] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setPulse((p) => p + 1), 400);
    return () => clearInterval(id);
  }, []);
  const text = spectator ? sound.spectatorBannerText() : sound.bannerText();
  if (!text) return null;
  return (
    <div className="w-pa-banner w-pa-shell" role="status">
      📣 {text}
    </div>
  );
}

/** The ?soundDebug=1 surface, shared by the walk and spectator drives. */
function soundDebugSurface(sound: SoundDirector) {
  return {
    snapshot: () => sound.snapshot(),
    announce: (text: string, scope: string, clip?: string) =>
      sound.announce(text, scope, clip ?? null),
    setMuted: (m: boolean) => sound.setMuted(m),
    arm: () => sound.arm(),
    grantConsent: () => sound.grantConsent(),
    declineConsent: () => sound.declineConsent(),
  };
}

/**
 * Walk-mode clip HUD (City 3, shown while walking, ride and follow
 * alike): Jim's test buttons for the clips speed alone cannot reach on
 * the walk bot — the Run loop (the bot's walk pace never crosses the
 * run threshold) and the two door one-shots the door work performs
 * with. The buttons drive a WalkClipOverride (walkOverride.ts); the
 * bot's CastFigure consumes it as its clip tester, the same
 * clip-firing path as the Embody panel's tester below.
 */
function WalkHudPanel({
  override,
  frameRef,
  door,
  interact,
  sound,
}: {
  /** The shared override state the buttons drive (walkOverride.ts). */
  override: WalkClipOverride;
  /** The walker's latest frame (state + speed), written per frame by CityWalker — read on the 400 ms pulse. */
  frameRef: RefObject<WalkFrameInfo | null>;
  /**
   * Tea House door pilot: when present, the door buttons request a
   * full door session (align + performance + step-through) from the
   * controller instead of firing the raw one-shot; the controller's
   * status (aligning / opening / too far …) joins the status line.
   */
  door?: TeaDoorController;
  /** Usable props: the status line shows the E prompt / session state. */
  interact?: InteractController;
  /** Sound v1: consent + mute state come from the director (the PA banner itself renders at the shell — see ShellPaBanner). */
  sound?: SoundDirector;
}) {
  const [, setPulse] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setPulse((p) => p + 1), 400);
    return () => clearInterval(id);
  }, []);
  const bump = () => setPulse((p) => p + 1);
  const fr = frameRef.current;
  const doorStatus = door?.status() ?? null;
  const interactStatus = interact?.status(PLAYER) ?? null;
  // The PA banner no longer renders here (F1): it moved to the shell
  // (ShellPaBanner in GlbWorld) so spectators in the wide view see
  // platform announcements too, not only walkers.
  return (
    <div className="w-embody-panel w-walk-panel">
      <div className="w-embody-title">Walk clips — test</div>
      <div className="w-embody-row" role="group" aria-label="Walk clip tests">
        <button
          type="button"
          className={override.runHeld ? "active" : ""}
          onClick={() => {
            override.toggleRun();
            bump();
          }}
        >
          Run
        </button>
        <button
          type="button"
          className={override.doorClip === "OpenDoorInwards" ? "active" : ""}
          onClick={() => {
            if (door) door.request("OpenDoorInwards");
            else override.fireDoor("OpenDoorInwards");
            bump();
          }}
        >
          Open door in
        </button>
        <button
          type="button"
          className={override.doorClip === "OpenDoorOutwards" ? "active" : ""}
          onClick={() => {
            if (door) door.request("OpenDoorOutwards");
            else override.fireDoor("OpenDoorOutwards");
            bump();
          }}
        >
          Open door out
        </button>
      </div>
      {sound && sound.consent === "unknown" ? (
        <div className="w-embody-row" role="group" aria-label="Sound permission">
          <span className="w-sound-ask">Hear the verse on this device?</span>
          <button
            type="button"
            className="w-sound-enable"
            onClick={() => {
              // Inside this click's call stack on purpose: the
              // director creates + resumes its AudioContext here,
              // which is what unlocks audio on iOS Safari.
              sound.grantConsent();
              bump();
            }}
          >
            Enable sound
          </button>
          <button
            type="button"
            onClick={() => {
              sound.declineConsent();
              bump();
            }}
          >
            No thanks
          </button>
        </div>
      ) : null}
      {sound && sound.consent === "granted" ? (
        <div className="w-embody-row" role="group" aria-label="Sound">
          <button
            type="button"
            className={sound.muted ? "" : "active"}
            onClick={() => {
              sound.setMuted(!sound.muted);
              bump();
            }}
          >
            {sound.muted ? "Sound: off" : "Sound: on"}
          </button>
        </div>
      ) : null}
      <div className="w-embody-status">
        {fr
          ? `anim ${override.displayClip(fr.state)} · ${fr.speed.toFixed(2)} m/s`
          : "anim — · no frame yet"}
        {override.doorPlaying
          ? " · door one-shot — bot standing"
          : override.runHeld
            ? " · Run held"
            : ""}
        {doorStatus ? ` · ${doorStatus}` : ""}
        {interactStatus ? ` · ${interactStatus}` : ""}
      </div>
    </div>
  );
}

/**
 * Mobile Phase 2: the double-tap fly-to for a tapped figure. When the
 * shared ref gains a point, fly the spectator camera to a three-quarter
 * view of it over ~1.1 s (smoothstep), moving OrbitControls' target
 * with it — the same write-the-controls pattern the room flights use.
 */
function FigureFlyRig({
  flyRef,
}: {
  flyRef: { current: { x: number; z: number } | null };
}) {
  // Mobile Phase 4: reduced motion turns the flight into a cut — the
  // goal state applies in the first frame instead of easing over 1.1 s.
  const reduced = isReducedMotion();
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as {
    target: THREE.Vector3;
    update?: () => void;
  } | null;
  const anim = useRef<{
    t: number;
    fromPos: THREE.Vector3;
    fromTgt: THREE.Vector3;
    toPos: THREE.Vector3;
    toTgt: THREE.Vector3;
  } | null>(null);
  useFrame((_, delta) => {
    const goal = flyRef.current;
    if (goal && !anim.current) {
      flyRef.current = null;
      const toTgt = new THREE.Vector3(goal.x, 1.1, goal.z);
      const away = camera.position.clone().sub(toTgt);
      away.y = 0;
      if (away.lengthSq() < 0.01) away.set(1, 0, 1);
      away.normalize();
      anim.current = {
        t: 0,
        fromPos: camera.position.clone(),
        fromTgt: controls?.target.clone() ?? new THREE.Vector3(),
        toPos: toTgt.clone().add(away.multiplyScalar(6.5)).add(new THREE.Vector3(0, 3.2, 0)),
        toTgt,
      };
      if (reduced) anim.current.t = 0.999; // one frame: the cut
    }
    const a = anim.current;
    if (!a) return;
    a.t = Math.min(1, a.t + delta / 1.1);
    const k = a.t * a.t * (3 - 2 * a.t);
    camera.position.lerpVectors(a.fromPos, a.toPos, k);
    if (controls) {
      controls.target.lerpVectors(a.fromTgt, a.toTgt, k);
      controls.update?.();
    }
    if (a.t >= 1) anim.current = null;
  });
  return null;
}

export function GlbWorld() {
  // City 3 is the only world: the Agora was deleted 2026-11-08 (Jim's
  // order — a planned lobby will bring back world navigation later).
  // Any ?world= value, stale or current, lands here.
  // Walk-mode HUD (City 3): one shared override state — the panel's
  // Run/door buttons drive it, the walk bot's CastFigure consumes it as
  // its clip tester. Plus the walker's latest frame for the status line.
  const [miraVisitNonce, setMiraVisitNonce] = useState(0);
  const walkOverrideRef = useRef<WalkClipOverride | null>(null);
  if (walkOverrideRef.current === null) walkOverrideRef.current = new WalkClipOverride();
  const walkFrameRef = useRef<WalkFrameInfo | null>(null);
  const elevator = useMemo(() => new TeaElevatorController(), []);
  // Mobile Phase 1 (touch walk MVP): the touch intent source the DOM
  // layer writes and CityWalker merges, the tap raycast picker the
  // in-Canvas TouchTapPicker fills, and the touch-UI detection. On a
  // desktop viewport none of this renders or merges — the walk HUD
  // and keyboard path are exactly as before.
  const touchSourceRef = useRef<TouchWalkSource | null>(null);
  if (touchSourceRef.current === null) touchSourceRef.current = new TouchWalkSource();
  const tapPickRef = useRef<TapPicker | null>(null);
  const touchUi = useTouchUi();
  // Mobile Phase 2 (spectator touch + shell): a pending Walk-there
  // spawn for CityWalker, the figure flight target for FigureFlyRig,
  // and the tapped figure whose card is showing. Places registration
  // and walk-live reporting for WorldView's tab bar live just below
  // (after `walking` is known).
  // Mobile Phase 3: the shared quality tier (governor-driven on this
  // path, pinned "full" on desktop). Read here for the Canvas DPR;
  // KeyLight and CastFigure subscribe themselves.
  const quality = useSyncExternalStore(qualityStore.subscribe, qualityStore.getSnapshot);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("qualityDebug") === "1") {
      (window as unknown as Record<string, unknown>).__quality = qualityStore;
    }
  }, []);
  const walkSpawnRef = useRef<WalkSpawnRequest | null>(null);
  const figureFlyRef = useRef<{ x: number; z: number } | null>(null);
  const [figureCard, setFigureCard] = useState<BazaarFigureTap | null>(null);
  const walkToPoint = (x: number, z: number) => {
    walkSpawnRef.current = spawnRequestForPoint(x, z);
    setFigureCard(null);
    setCamMode("ride");
  };
  // Render-rate meter: FpsTracker (in-Canvas) writes, the panel reads.
  const fpsMeterRef = useRef<FpsMeter | null>(null);
  if (fpsMeterRef.current === null) fpsMeterRef.current = new FpsMeter();
  // The stage's key light — DistrictWorld borrows it for its shadow
  // setup.
  const keyLightRef = useRef<THREE.DirectionalLight | null>(null);
  const city3Rooms = useCity3Rooms(true);
  // ?walk=1 deep-links straight into the walkable bot's first-person view.
  const walkLink = useMemo(
    () => new URLSearchParams(window.location.search).get("walk") === "1",
    [],
  );
  // ?agent=1: the Phase 0 agent-experiment harness — Scout spawns at
  // the fountain and window.__scout drives it (scout.ts). Dev-only:
  // without the flag nothing mounts and behavior is unchanged. Agent
  // mode wins over walk mode if both flags are set (one bot, one
  // camera owner).
  const agentOn = useMemo(
    () => new URLSearchParams(window.location.search).get("agent") === "1",
    [],
  );
  const [camMode, setCamMode] = useState<CameraMode>(walkLink ? "ride" : "wide");
  // City 3 collider meshes (DistrictWorld fills it), read by the walker.
  const colliderMeshesRef = useRef<(() => THREE.Mesh[]) | null>(null);
  const getColliderMeshes = useCallback(() => colliderMeshesRef.current?.() ?? [], []);
  // The walker's own collision list (collision GLBs + interior boxes), separate from the camera's.
  const walkColliders = useMemo(() => new WalkColliders(), []);
  // Tea House door pilot: one controller per GlbWorld mount. Its clip
  // channel is the walk override (the #31 HUD path); its blocker sink
  // registers/drops the doorway box in the walker's collision list.
  // The constructor syncs the initial (closed) blocker immediately.
  const teaDoorRef = useRef<TeaDoorController | null>(null);
  if (teaDoorRef.current === null) {
    teaDoorRef.current = new TeaDoorController({
      channel: walkOverrideRef.current,
      selfTick: false, // ticked once per frame by TeaDoorTicker (walk mode) or by Scout's sim clock (agent mode)
      setBlocker: (on) => {
        if (on) {
          const m = boxesMesh([TEA_BLOCKER_BOX], [0, 0], "door:tea");
          if (m) walkColliders.set("door:tea", [m]);
        } else {
          walkColliders.drop("door:tea");
        }
      },
    });
  }
  // Usable props (interactables.ts): one controller per mount. Definitions come from the room index (static, known before a
  // room streams in); on/off state lives here, so the sound layer plays a radio nobody is looking at.
  const interactRef = useRef<InteractController | null>(null);
  if (interactRef.current === null) interactRef.current = new InteractController();
  useEffect(() => {
    interactRef.current?.register(city3Rooms.flatMap((r) => r.interactables ?? []));
  }, [city3Rooms]);
  // Sound (soundDirector.ts): one director per mount. It arms only
  // on the user's explicit sound consent (the HUD button below),
  // is driven at ~10 Hz from the walker's frame + the tea door
  // machine while walking, and by the spectator drive (below) while
  // watching — the shell PA banner reads it either way.
  const soundRef = useRef<SoundDirector | null>(null);
  if (soundRef.current === null) soundRef.current = new SoundDirector();
  // Plaza TTS probe (plazaTts.ts): the Mage↔Summer greeting. One
  // runner per mount; the 100 ms driver below feeds it the bot's
  // position (its trigger is the keeper's greeting radius) and it
  // speaks through the director's voice emitter — but only after
  // the user grants sound consent (the runner checks, the director
  // enforces). Summer's Talking clip rides the walk override, the
  // same channel the HUD's clip tests use.
  // The Mage's voice state: true while one of his lines plays; BazaarLife's keeper talks only then.
  const mageVoiceRef = useRef(false);
  const plazaRef = useRef<PlazaGreeting | null>(null);
  // Bound to the director it was built with: the director is disposed and re-created when its unmount effect runs (React
  // StrictMode runs that once on every dev mount), so a greeting kept from before would ask a DEAD director for consent
  // ("unknown" for ever) and never speak. Rebuild it whenever the director instance changes.
  const plazaDirectorRef = useRef<SoundDirector | null>(null);
  if (plazaRef.current === null || plazaDirectorRef.current !== soundRef.current) {
    plazaDirectorRef.current = soundRef.current;
    plazaRef.current = createPlazaGreeting(
      soundRef.current,
      (on) => {
        const ov = walkOverrideRef.current;
        if (!ov) return;
        if (on) ov.fire("Talking");
        else ov.clear();
      },
      (on) => {
        mageVoiceRef.current = on;
      },
    );
  }
  // Keep speech warm, once the visitor has said yes to sound: the click on "Enable sound" starts the engine load (64.5 MB)
  // and the pre-synthesis of every scripted line in the background. Nobody who declines sound downloads the model; until it
  // is warm the pre-rendered clips speak every line at once (prepareLine), so greetings never wait either way.
  useEffect(() => {
    const id = window.setInterval(() => {
      const consent = soundRef.current?.consent;
      if (consent === "declined") { window.clearInterval(id); return; }
      if (consent !== "granted") return;
      window.clearInterval(id);
      void warmPhonon([
        ...GREETING_SCRIPT.map((m) => ({ text: m.text, voice: m.voiceId })),
        ...BARTENDER_LINES.map((l) => ({ text: l.text, voice: VOICE_BARTENDER })),
      ]).catch((e: unknown) => {
        console.warn("[tts] warm-up failed; the pre-rendered clips will speak", e);
      });
    }, 500); // the consent lives on the director (no React state): a cheap poll until it is answered
    return () => window.clearInterval(id);
  }, []);
  const walking = camMode !== "wide";
  // Mobile Phase 2: register this world's Places with the shell bridge
  // while City 3 is on stage (WorldView's Places sheet reads them),
  // and tell the shell when a touch walk owns the screen so the tab
  // bar hides. Desktop never registers — the sheet is touch-only.
  useEffect(() => {
    if (!touchUi) return;
    mobileShell.setPlaces({
      rooms: city3Rooms,
      flyTo: (room) => setHeroFocus((f) => ({ id: room.id, nonce: (f?.nonce ?? 0) + 1 })),
      walkTo: (room) => {
        walkSpawnRef.current = spawnRequestForRoom(room);
        setCamMode("ride");
      },
    });
    return () => mobileShell.setPlaces(null);
  }, [touchUi, city3Rooms]);
  useEffect(() => {
    if (!touchUi) return;
    mobileShell.setWalkLive(walking);
    return () => mobileShell.setWalkLive(false);
  }, [touchUi, walking]);
  useEffect(() => {
    if (walking) setFigureCard(null);
  }, [walking]);

  // Mobile Phase 4: comfort sync + long-press context sheet + the
  // long-press coach mark. Comfort values flow one way — the store
  // (Settings) → the look prefs and the sound director here.
  const rootRef = useRef<HTMLDivElement>(null);
  const longPressRef = useRef(0);
  // When the context sheet was last opened. The gesture that opens it
  // ends with a trailing click, and the sheet (plus its backdrop)
  // commits synchronously on the pointerup — so that click lands on
  // the brand-new backdrop and dismisses the sheet it just opened
  // (observed live: sheet mounted and gone 22 ms later). The backdrop
  // ignores dismiss clicks inside this window.
  const sheetOpenedAtRef = useRef(0);
  const [contextSheet, setContextSheet] = useState<
    | { kind: "stage" }
    | { kind: "figure"; fig: BazaarFigureTap }
    | null
  >(null);
  const [coachLongSeen, setCoachLongSeen] = useState(() => coachSeen("longpress"));
  useEffect(() => {
    const apply = () => {
      const c = comfortStore.getSnapshot();
      setLookPrefs({ sensitivity: c.lookSensitivity, invertY: c.invertY });
      const s = soundRef.current;
      if (s) {
        s.setMasterVolume(c.masterVolume);
        s.setMusicVolume(c.musicVolume);
        s.setWindVolume(c.windVolume);
        s.setPaVolume(c.paVolume);
      }
    };
    apply();
    return comfortStore.subscribe(apply);
  }, []);
  const noteLongPress = () => {
    markCoachSeen("longpress");
    setCoachLongSeen(true);
    hapticTick();
  };
  const openContextSheet = (
    s: { kind: "stage" } | { kind: "figure"; fig: BazaarFigureTap },
  ) => {
    sheetOpenedAtRef.current = Date.now();
    setContextSheet(s);
  };
  // Stage long-press (touch spectator): observe presses on the world
  // root without ever intercepting them — a ≥500 ms press that stays
  // within the move tolerance opens the stage context sheet, unless a
  // figure's own long-press just claimed it.
  useEffect(() => {
    if (!touchUi || walking) return;
    // Listeners live on the document (capture), gated by a contains()
    // check against the CURRENT root — the world tree swaps its root
    // element as load states change (PR #43), and a listener pinned
    // to an early root dies with it. That was the Phase 4 proof's
    // first long-press failure; this shape is immune.
    let press: { x: number; y: number; t: number } | null = null;
    const inRoot = (e: PointerEvent) => {
      const root = rootRef.current;
      return !!root && e.target instanceof Node && root.contains(e.target);
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || !inRoot(e)) return;
      press = { x: e.clientX, y: e.clientY, t: Date.now() };
    };
    const up = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || !press || !inRoot(e)) return;
      const held = Date.now() - press.t;
      const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y);
      press = null;
      if (held < LONG_PRESS_MS || moved > LONG_PRESS_MAX_MOVE_PX) return;
      if (Date.now() - longPressRef.current < 1000) return; // a figure claimed it
      noteLongPress();
      openContextSheet({ kind: "stage" });
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
    };
  }, [touchUi, walking]);
  // The walk bot's latest position, published by CityWalker per stepped
  // frame and read by BazaarLife (the stall keeper's approach trigger).
  // Cleared when walk mode ends so a stale position can't hold a
  // conversation open forever.
  const botPosRef = useRef<{ x: number; y?: number; z: number } | null>(null);
  // Scout's latest position (agent mode), for the Tea House bartender.
  const scoutPosRef = useRef<{ x: number; z: number } | null>(null);
  useEffect(() => {
    if (!walking) botPosRef.current = null;
  }, [walking]);
  // City 3: which hero building to fly to (cutaway shows on arrival); nonce re-fires a repeat click.
  const initialTea = new URLSearchParams(window.location.search).get("teaFloor");
  const [heroFocus, setHeroFocus] = useState<{ id: string; nonce: number } | null>(() => initialTea !== null ? { id: "tea", nonce: 1 } : null);
  const [teaFloor, setTeaFloor] = useState<number | null>(() => initialTea === null || initialTea === "exterior" ? null : Math.min(3, Math.max(0, Number(initialTea) || 0)));
  // Sound lifecycle: the director arms ONLY from the walk HUD's
  // Enable-sound consent (its click is the gesture that creates +
  // resumes the AudioContext — the iOS rule); the pointer/key
  // listeners below merely re-call arm() on later gestures, which
  // resumes a granted context and stays a no-op before consent.
  // A 100 ms driver feeds the director the listener + door + room
  // facts; entering walk mode starts a fresh session (the tea
  // announcement re-arms).
  useEffect(() => {
    if (!walking) return;
    const sound = soundRef.current;
    if (!sound) return;
    sound.resetSession();
    const arm = () => sound.arm();
    window.addEventListener("pointerdown", arm);
    window.addEventListener("keydown", arm);
    let last = performance.now();
    const id = setInterval(() => {
      const nowMs = performance.now();
      const dt = (nowMs - last) / 1000;
      last = nowMs;
      const fr = walkFrameRef.current;
      const door = teaDoorRef.current;
      const tea = city3Rooms.find((r) => r.id === "tea");
      sound.tick({
        dt,
        listener: fr && fr.x !== undefined && fr.z !== undefined ? { x: fr.x, z: fr.z } : null,
        doorAngle: door?.angle ?? 0,
        doorState: door?.state ?? "closed",
        teaRect: tea?.rect ?? null,
        emitters: (interactRef.current?.list() ?? [])
          .filter((d) => d.kind === "radio")
          .map((d) => ({ id: d.id, x: d.pos[0], z: d.pos[2], on: interactRef.current!.isOn(d.id) })),
      });
      // Plaza TTS: the greeting's trigger reads the same frame.
      plazaRef.current?.maybeTrigger(
        fr && fr.x !== undefined && fr.z !== undefined ? { x: fr.x, z: fr.z } : null,
      );
    }, 100);
    // ?soundDebug=1: drive/inspect the sound layer from tests.
    const debug = new URLSearchParams(window.location.search).has("soundDebug");
    if (debug) {
      const w = window as unknown as Record<string, unknown>;
      w.__sound = soundDebugSurface(sound);
    }
    // ?ttsDebug=1: drive/inspect the plaza greeting + Phonon bench.
    const ttsDebug = new URLSearchParams(window.location.search).has("ttsDebug");
    if (ttsDebug) {
      const w = window as unknown as Record<string, unknown>;
      w.__tts = {
        start: () =>
          plazaRef.current?.start(() => {
            const fr = walkFrameRef.current;
            return fr && fr.x !== undefined && fr.z !== undefined
              ? { x: fr.x, z: fr.z }
              : null;
          }),
        log: () => plazaRef.current?.log ?? [],
        status: () => plazaRef.current?.status ?? "none",
        warmth: () => phononWarmth(),
        /** Synthesize one line (tools: render pre-recorded fallback clips with the same engine + voice). */
        synth: async (text: string, voice: string) => {
          const r = await synthLine(text, voice);
          return { sampleRate: r.sampleRate, pcm: Array.from(r.pcm) };
        },
        bench: () =>
          benchPhonon(GREETING_SCRIPT.map((m) => ({ text: m.text, voice: m.voiceId }))),
      };
    }
    return () => {
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
      clearInterval(id);
      if (debug) delete (window as unknown as Record<string, unknown>).__sound;
      if (ttsDebug) delete (window as unknown as Record<string, unknown>).__tts;
    };
  }, [walking, city3Rooms]);

  // Spectator drive (F1): while nobody walks, the verse clock still
  // has to advance or platform announcements never fire for the
  // default audience — the wide-view spectator. The director's
  // spectator tick only moves time + clock events (no audio layers);
  // the audience district is the Bazaar — City 3 is the only world.
  useEffect(() => {
    if (walking || agentOn) return;
    const sound = soundRef.current;
    if (!sound) return;
    let last = performance.now();
    const id = setInterval(() => {
      const nowMs = performance.now();
      const dt = (nowMs - last) / 1000;
      last = nowMs;
      sound.tickSpectator(dt, "bazaar");
    }, 250);
    const debug = new URLSearchParams(window.location.search).has("soundDebug");
    if (debug) {
      const w = window as unknown as Record<string, unknown>;
      w.__sound = soundDebugSurface(sound);
    }
    return () => {
      clearInterval(id);
      if (debug) delete (window as unknown as Record<string, unknown>).__sound;
    };
  }, [walking, agentOn]);

  // E1: the stage's load generation + presented flag. A retry
  // remounts the Canvas under a fresh key; `presented`
  // resets with it and PresentedSignal (inside the Suspense
  // boundary) raises it again when the world actually mounts.
  const [loadNonce, setLoadNonce] = useState(0);
  const [worldPresented, setWorldPresented] = useState(false);
  useEffect(() => {
    setWorldPresented(false);
  }, [loadNonce]);
  const markPresented = useCallback(() => setWorldPresented(true), []);
  useEffect(() => {
    return () => {
      soundRef.current?.dispose();
      soundRef.current = null;
    };
  }, []);

  // Elevated three-quarter spectator defaults: City 3 opens wide over
  // the whole island.
  const camera = useMemo(
    () => ({ position: [290, 250, 340] as [number, number, number], fov: 45, near: 0.5, far: 6000 }),
    [],
  );
  const target: [number, number, number] = [CITY3_CENTER[0], 8, CITY3_CENTER[1]];

  return (
    <div ref={rootRef} className={touchUi ? "w-glb-root w-touch-root" : "w-glb-root"}>
      <VerseRecorder root={rootRef} />
      <TeaElevatorHud controller={elevator} frame={walkFrameRef} walking={walking} walk={walkColliders} />
      <Canvas
        key={loadNonce}
        camera={camera}
        dpr={touchUi ? dprForTier(quality.tier) : undefined}
        frameloop={agentOn ? "demand" : "always"}
        shadows={agentOn ? false : "soft"}
        gl={{ antialias: true }}
        onCreated={({ gl }) => {
          // VoiceOver pass (Phase 4): the canvas is the world's window;
          // name it for assistive tech.
          gl.domElement.setAttribute("aria-label", "3D world view");
        }}
        style={{ position: "absolute", inset: 0 }}
      >
        <ambientLight intensity={0.12} color="#8fa3cc" />
        <StageEnvironment />
        <KeyLight lightRef={keyLightRef} />
        <ShadowTagger />
        {touchUi ? <FpsTracker meterRef={fpsMeterRef} /> : null}
        {touchUi ? <QualityDriver meterRef={fpsMeterRef} /> : null}
        <Suspense fallback={null}>
          <PresentedSignal onPresented={markPresented} />
          <DistrictWorld residentUrl={CITY3_URL} light={keyLightRef} collide={camMode === "wide" && !(heroFocus?.id === "tea" && teaFloor === null)} meshesRef={colliderMeshesRef} walk={walkColliders} />
          <>
              <TeaElevator controller={elevator} walk={walkColliders} url={CITY3_URL} frame={walkFrameRef} getDirector={() => soundRef.current} />
              <ClipCutaway rooms={city3Rooms} focus={heroFocus} teaFloor={teaFloor} walking={walking} />
              <InteriorStreamer rooms={city3Rooms} walk={walkColliders} interact={interactRef.current} />
              <BazaarLife
                getMeshes={getColliderMeshes}
                walk={walkColliders}
                botPosRef={botPosRef}
                keeperVoiceRef={mageVoiceRef}
                onFigure={
                  touchUi && !walking
                    ? (fig, dbl) => {
                        if (dbl) figureFlyRef.current = { x: fig.x, z: fig.z };
                        setFigureCard(fig);
                      }
                    : undefined
                }
                onFigureLong={
                  touchUi && !walking
                    ? (fig) => {
                        noteLongPress();
                        openContextSheet({ kind: "figure", fig });
                      }
                    : undefined
                }
                longPressRef={longPressRef}
              />
              <TeaBartender visitors={[botPosRef, scoutPosRef]} walk={walkColliders} getDirector={() => soundRef.current} />
              <MiraResident walk={walkColliders} visitNonce={miraVisitNonce} />
              <TeaDoorLeaf controller={teaDoorRef.current} />
              {!agentOn ? <TeaDoorTicker controller={teaDoorRef.current} /> : null}
              {!agentOn ? <InteractTicker controller={interactRef.current} /> : null}
          </>
          {walking && !agentOn ? (
            <CityWalker
              mode={camMode === "follow" ? "follow" : "ride"}
              onMode={setCamMode}
              onExit={() => setCamMode("wide")}
              onPosition={(x, z, y) => {
                botPosRef.current = { x, y, z };
              }}
              getMeshes={getColliderMeshes}
              walk={walkColliders}
              override={walkOverrideRef.current}
              frameRef={walkFrameRef}
              door={teaDoorRef.current}
              interact={interactRef.current}
              touch={touchUi ? touchSourceRef.current : undefined}
              spawnRef={walkSpawnRef}
            />
          ) : null}
          {walking && !agentOn && touchUi ? (
            <>
              <InteractHighlight interact={interactRef.current ?? undefined} frameRef={walkFrameRef} />
              <TouchTapPicker pickRef={tapPickRef} />
            </>
          ) : null}
          {agentOn ? (
            <ScoutAgent getMeshes={getColliderMeshes} walk={walkColliders} rooms={city3Rooms} door={teaDoorRef.current} positionRef={scoutPosRef} interact={interactRef.current} />
          ) : null}
          {touchUi && !walking ? <FigureFlyRig flyRef={figureFlyRef} /> : null}
        </Suspense>
        <OrbitControls
          makeDefault
          target={target}
          enableDamping
          // Parked while a bot camera mode owns the camera (drei only
          // updates controls when enabled, so the rig never fights it).
          enabled={!walking && !agentOn}
          maxPolarAngle={Math.PI / 2 - 0.04}
          // 3 m close-ups; CameraCollider (in DistrictWorld) keeps the camera out of walls.
          minDistance={heroFocus?.id === "tea" && teaFloor === null ? 24 : 3}
          maxDistance={1100}
        />
      </Canvas>
      {soundRef.current ? (
        <ShellPaBanner sound={soundRef.current} spectator={!walking} />
      ) : null}
      <WorldLoadOverlay
        key={loadNonce}
        presented={worldPresented}
        onRetry={() => {
          useGLTF.clear(CITY3_URL);
          useGLTF.clear(CITY3_LIBRARY_URL);
          setLoadNonce((n) => n + 1);
        }}
      />
      {!(walking && touchUi) ? (
        <div className="w-glb-toggle w-glb-walk" role="group" aria-label="Walk City 3">
          {walking ? (
            <>
              <button type="button" className={camMode === "ride" ? "active" : ""} onClick={() => setCamMode("ride")}>First person</button>
              <button type="button" className={camMode === "follow" ? "active" : ""} onClick={() => setCamMode("follow")}>Follow</button>
              <button type="button" onClick={() => setCamMode("wide")}>Exit (Esc)</button>
            </>
          ) : (
            <button type="button" onClick={() => setCamMode("ride")}>Walk</button>
          )}
        </div>
      ) : null}
      {walking && !touchUi ? (
        <div className="w-walk-hint" aria-hidden="true">
          click to look · W A S D move · Shift run · V camera · Esc leave
        </div>
      ) : null}
      {walking && !touchUi ? (
        <WalkHudPanel override={walkOverrideRef.current} frameRef={walkFrameRef} door={teaDoorRef.current} interact={interactRef.current} sound={soundRef.current} />
      ) : null}
      {walking && touchUi ? (
        <TouchWalkLayer
          source={touchSourceRef.current}
          frameRef={walkFrameRef}
          interact={interactRef.current ?? undefined}
          door={teaDoorRef.current ?? undefined}
          sound={soundRef.current ?? undefined}
          channel={walkOverrideRef.current}
          mode={camMode === "follow" ? "follow" : "ride"}
          onMode={setCamMode}
          onExit={() => setCamMode("wide")}
          tapPickRef={tapPickRef}
        />
      ) : null}
      {touchUi && !walking && !coachLongSeen && !contextSheet ? (
        <div className="w-coach-pill" role="note">
          <span>Tip — long-press the scene for options</span>
          <button
            type="button"
            aria-label="Dismiss tip"
            onClick={() => {
              markCoachSeen("longpress");
              setCoachLongSeen(true);
            }}
          >
            ✕
          </button>
        </div>
      ) : null}
      {touchUi && !walking && contextSheet ? (
        <>
          <div
            className="w-sheet-backdrop"
            onClick={() => {
              // Not the opening gesture's trailing click (see
              // sheetOpenedAtRef) — that one belongs to the press.
              if (Date.now() - sheetOpenedAtRef.current < 500) return;
              setContextSheet(null);
            }}
            aria-hidden="true"
          />
          <section className="w-sheet w-context-sheet" role="dialog" aria-label="Context options">
            <div className="w-sheet-grab" aria-hidden="true" />
            <header className="w-sheet-head">
              <b>{contextSheet.kind === "figure" ? contextSheet.fig.name : "Sunstone Bazaar"}</b>
              <button type="button" onClick={() => setContextSheet(null)}>
                Close
              </button>
            </header>
            <div className="w-sheet-body">
              {contextSheet.kind === "figure" ? (
                <>
                  <button
                    type="button"
                    className="w-sheet-menu"
                    onClick={() => {
                      walkToPoint(contextSheet.fig.x, contextSheet.fig.z);
                      setContextSheet(null);
                    }}
                  >
                    Walk there
                  </button>
                  <button
                    type="button"
                    className="w-sheet-menu"
                    onClick={() => {
                      figureFlyRef.current = { x: contextSheet.fig.x, z: contextSheet.fig.z };
                      setContextSheet(null);
                    }}
                  >
                    Fly to
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="w-sheet-menu"
                    onClick={() => {
                      setContextSheet(null);
                      setCamMode("ride");
                    }}
                  >
                    Walk from the plaza
                  </button>
                  {soundRef.current && soundRef.current.consent === "granted" ? (
                    <button
                      type="button"
                      className="w-sheet-menu"
                      onClick={() => {
                        const s = soundRef.current;
                        if (s) s.setMuted(!s.muted);
                        setContextSheet({ kind: "stage" }); // re-render with the new mute state
                      }}
                    >
                      {soundRef.current.muted ? "Unmute the verse" : "Mute the verse"}
                    </button>
                  ) : null}
                  <p className="w-sheet-note">
                    Quality: {quality.override === "auto" ? `Auto — currently ${quality.tier}` : quality.tier} (
                    {quality.reason})
                  </p>
                </>
              )}
            </div>
          </section>
        </>
      ) : null}
      {touchUi && !walking && figureCard ? (
        <div className="w-figure-card" role="dialog" aria-label={`Figure: ${figureCard.name}`}>
          <span className="w-figure-name">{figureCard.name}</span>
          <button type="button" className="w-figure-act" onClick={() => walkToPoint(figureCard.x, figureCard.z)}>
            Walk there
          </button>
          <button
            type="button"
            className="w-figure-act ghost"
            onClick={() => {
              figureFlyRef.current = { x: figureCard.x, z: figureCard.z };
            }}
          >
            Fly to
          </button>
          <button type="button" className="w-figure-close" aria-label="Close figure card" onClick={() => setFigureCard(null)}>
            ✕
          </button>
        </div>
      ) : null}
      <a className="w-asset-credit" href="/assets/collectibles/credits.html" target="_blank" rel="noreferrer" title="SciFi EasterEgg by Cécile Amstad — CC BY 4.0">3D asset credit</a>
      {!walking ? (
        <div className="w-glb-toggle w-glb-poi" role="group" aria-label="Places in City 3">
          {city3Rooms.filter((r) => r.featured).map((hero) => (
            <button
              key={hero.id}
              type="button"
              onClick={() => setHeroFocus((f) => ({ id: hero.id, nonce: (f?.nonce ?? 0) + 1 }))}
            >
              {hero.name}
            </button>
          ))}
          <button type="button" onClick={() => setMiraVisitNonce((n) => n + 1)}>
            Meet Mira
          </button>
        </div>
      ) : null}
      {!walking && heroFocus?.id === "tea" ? (
        <div className="w-tea-floor-panel">
          <div className="w-glb-toggle w-tea-floors" role="group" aria-label="Tea House floors">
            <button type="button" aria-pressed={teaFloor === null} className={teaFloor === null ? "active" : ""} onClick={() => setTeaFloor(null)}>Exterior</button>
            {TEA_FLOORS.map((floor, i) => <button key={floor.label} type="button" aria-pressed={teaFloor === i} className={teaFloor === i ? "active" : ""} onClick={() => setTeaFloor(i)}>{floor.label}</button>)}
            <button type="button" onClick={() => {
              const room = city3Rooms.find(r => r.id === "tea");
              if (room) { walkSpawnRef.current = spawnRequestForRoom(room); setTeaFloor(null); setCamMode("ride"); }
            }}>Walk from entrance</button>
          </div>
          <div className="w-tea-floor-caption">{teaFloor === null ? "Matchmaker’s House · four floors" : `Inspection cutaway · ${TEA_FLOORS[teaFloor].name}`}</div>
        </div>
      ) : null}
    </div>
  );
}
