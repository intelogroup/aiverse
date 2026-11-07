import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { OrbitControls, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { DistrictWorld } from "./DistrictWorld";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import {
  AGENT_RADIUS,
  buildDeckGeometry,
  buildStreetGeometry,
  clampPositionToRadius,
  createGeometryCrowd,
  type AgentFrame,
  type PlanObstacle,
  type PlatformCrowd,
} from "./locomotion";
import { CITY_FOOTPRINTS, insideFootprint } from "./cityFootprints";
import { CastFigure } from "./CastFigure";
import { BazaarLife } from "./BazaarLife";
import { CityWalker } from "./CityWalker";
import { ScoutAgent } from "./ScoutAgent";
import { BODY_CAST, BODY_SUMMER, bodyForMember, cruiseCapForBody, excludeBody } from "./bodies";
import { CLIP_CATALOG, ClipTestState } from "./clips";
import { WalkClipOverride, type WalkFrameInfo } from "./walkOverride";
import { SoundDirector } from "./soundDirector";
import { benchPhonon } from "./phononTts";
import { GREETING_SCRIPT, createPlazaGreeting, type PlazaGreeting } from "./plazaTts";
import {
  AGORA_BENCH_ANCHORS,
  EmbodyController,
  type FigureOverride,
} from "./embody";
import {
  DAMP_FOV,
  DAMP_HEADING,
  DAMP_LOOK,
  DAMP_POS_FOLLOW,
  DAMP_POS_RIDE,
  FOV_RIDE,
  FOV_WIDE,
  botView,
  damp,
  dampAngle,
  followTarget,
  rideTarget,
  rideTargetFromHead,
  type BotView,
  type CameraMode,
} from "./cameraRig";
import { FpsMeter } from "./fpsMeter";
import { newBodyState, stepBody, type BodyState } from "./bodyController";
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
import {
  PROBE_CADENCES,
  PROBE_HEIGHT,
  PROBE_WIDTH,
  initialProbeStats,
  recordCapture,
  shouldCapture,
  type ProbeStats,
} from "./visionProbe";

// GlbWorld — the modeled worlds (Blender-authored GLBs) as the console's
// default stage. Two places share one cast:
//
//   Agora — the lobby island. The crowd walks the deck disc (r = 9.7 m)
//   with the hologlobe as a central keep-out (r = 2.2 m): the annulus
//   navmesh locomotion.ts builds for exactly this, spike-proven.
//   City — World One's street grid. @recast-navigation/three is not among
//   the console's dependencies, so instead of meshing the whole city the
//   crowd walks a bounded street rectangle in world coordinates over the
//   dense district (geometry-verified from the GLB: roads surface
//   y = 0.2 m, densest fabric around x −210..−120, z −90 in three.js
//   space — the Blender Y axis lands negated in glTF Z). The rectangle's
//   navmesh geometry leaves the building footprints out (cityFootprints
//   .ts, measured from the same GLB), so the cast walks streets and
//   plazas and never passes through a building.
//
// Spectator framing throughout: a perspective camera + OrbitControls,
// no avatar driving. Each place opens at an elevated three-quarter view
// that frames its whole play area; OrbitControls stays above the horizon
// so nobody can duck under the world. The stage is lit for PBR: the
// Agora wears its authored sky (a Blender-baked equirect panorama as
// background + PMREM image-based light, with matched exponential fog);
// the City still uses three's built-in RoomEnvironment. One
// shadow-casting key light per place for grounding, and a modest
// ambient fill. Cast membership comes from WorldView (owned agents
// first, then the public roster) — the same data the ring world's
// figures are drawn from.

export type CastMember = { id: string; name: string; body?: string };
type Place = "agora" | "city" | "city3";

const AGORA_URL = "/assets/world-agora.glb";
const CITY_URL = "/assets/world-city.glb";
const CITY3_URL = "/assets/world-city3.glb";

const AGORA_DECK_RADIUS = 9.7;
const AGORA_KEEP_OUT = 2.2;
const AGORA_GROUND_Y = 0.84; // deck top surface
// The navmesh stops 0.55 m short of the rim, so agent centres (and the
// bodies around them) always keep a visible margin of deck — and the
// per-frame clamp below is the hard backstop if separation ever shoves
// a centre past the mesh edge anyway.
const AGORA_WALK_RADIUS = AGORA_DECK_RADIUS - 0.55;
const AGORA_FRAME_RMAX = AGORA_DECK_RADIUS - AGENT_RADIUS;

const CITY_CENTER: [number, number] = [-165, -95]; // XZ, three.js space
const CITY_RECT_W = 110;
const CITY_RECT_D = 70;
const CITY_GROUND_Y = 0.22; // roads surface (lifted +0.02 over the slab in world2 to end street z-fighting)

// City 3 is the Sunstone Bazaar: a 360 m island (generated by the
// city3 pipeline), plaza at the origin, every walkable surface flush at
// y = 0.2. Viewing world for now — the crowd and its navmesh come later.
const CITY3_CENTER: [number, number] = [0, 0];
const CITY3_GROUND_Y = 0.2;

/** Viewing worlds: no crowd is built and no cast is placed. */
const isViewingWorld = (p: Place): boolean => p === "city3";

/** Deterministic stand-here spots (pre-first-frame + crowd spawn points). */
function homeFor(place: Place, i: number, n: number): [number, number, number] {
  if (place === "agora") {
    const a = (i / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2;
    const r = 6; // inside the annulus walkable band (2.2 keep-out, 9.7 rim)
    return [Math.cos(a) * r, AGORA_GROUND_Y, Math.sin(a) * r];
  }
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const col = i % cols;
  const row = Math.floor(i / cols);
  const x = CITY_CENTER[0] - CITY_RECT_W / 2 + 10 + col * ((CITY_RECT_W - 20) / Math.max(1, cols - 1 || 1));
  const z = CITY_CENTER[1] - CITY_RECT_D / 2 + 10 + row * 20;
  return [x, CITY_GROUND_Y, z];
}

/** City stand-here spots: the home grid, pushed out of building footprints. */
function cityHomeFor(i: number, n: number): [number, number, number] {
  const h = homeFor("city", i, n);
  if (!insideFootprint(h[0], h[2], 1)) return h;
  for (let d = 2; d <= 60; d += 2) {
    for (const [dx, dz] of [[0, d], [0, -d], [d, 0], [-d, 0]] as const) {
      const x = h[0] + dx;
      const z = h[2] + dz;
      if (x < CITY_CENTER[0] - CITY_RECT_W / 2 || x > CITY_CENTER[0] + CITY_RECT_W / 2) continue;
      if (z < CITY_CENTER[1] - CITY_RECT_D / 2 || z > CITY_CENTER[1] + CITY_RECT_D / 2) continue;
      if (!insideFootprint(x, z, 1)) return [x, CITY_GROUND_Y, z];
    }
  }
  return h;
}

function WorldEnv({ url }: { url: string }) {
  const gltf = useGLTF(url);
  return <primitive object={gltf.scene} />;
}

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
}: {
  rooms: City3Room[];
  focus: { id: string; nonce: number } | null;
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
  const cutRooms = useMemo(() => rooms.map((r) => ({ id: r.id, center: r.center, rect: r.rect, cut: r.cut })), [rooms]);
  useEffect(() => {
    gl.localClippingEnabled = true;
    const mats = new Set<THREE.Material>();
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh) return; // library furnishings are never clipped
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mats.add(mat);
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
    if (!room || !controls) return;
    const v = roomView(room);
    camera.position.set(...v.position);
    controls.target.set(...v.target);
    controls.update();
  }, [focus, rooms, camera, controls]);
  useFrame(() => {
    // What the camera is looking at decides which building opens, not where the camera stands
    // (from a street-side viewpoint the nearest building centre is often across the road).
    const target = controls?.target;
    if (!target) return;
    const next = pickCutRoom(
      cutRooms,
      { x: target.x, z: target.z },
      camera.position.distanceTo(target),
      open.current,
      HIDE_WITHIN,
      SHOW_BEYOND,
    );
    if (next === open.current) return;
    open.current = next;
    const spec = next ? boxPlanes(rooms.find((r) => r.id === next)!.cut) : inactivePlanes();
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
    setHandle(h);
    return () => {
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

const SKY_URL = "/assets/sky-equi.jpg";
// Atmosphere values graded against the primary design boards (Blender
// sky pass, 2026-11-04): the mist in the Blender scene blends toward
// #46548c over 25–210 m; FogExp2 at this density reaches the same ~10%
// haze at 100 m, so depth reads identically in renders and live.
const SKY_FOG_COLOR = 0x46548c;
const SKY_FOG_DENSITY = 0.0035;

/**
 * Environment per place (the Canvas remounts per place).
 *
 * Agora wears the authored sky: an equirectangular panorama baked from
 * the Blender scene (gradient + nebula + spire ring) serves as both the
 * visible background and the PMREM image-based light, and a matched
 * FogExp2 supplies the distance haze the Blender mist pass grades with.
 * Environment intensity stays near the old RoomEnvironment level so the
 * worlds' emissive glow rings and eye screens still read as glow, and a
 * slight exposure lift keeps the dark deck plates from washing to black.
 *
 * City keeps the neutral RoomEnvironment for now — it gets its own sky
 * pass later; the Agora fog density would drown its 450 m sightlines.
 */
function StageEnvironment({ place }: { place: Place }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    // Matched tone-curve pair with the Blender authoring (AgX view transform):
    // R3F otherwise defaults to ACES Filmic, which grades the stage on a
    // different curve than the one it was authored under.
    gl.toneMapping = THREE.AgXToneMapping;
    gl.toneMappingExposure = 1.1;
    // City 3 takes the RoomEnvironment path too: with no environment at all,
    // AgX + the single key light washed the district foliage pale (the
    // districts' palette data was intact in the GLBs). DistrictWorld drives
    // scene.environmentIntensity from the blended theme's envIntensity, so
    // the 0.6 set here is only the pre-first-tick value for city3.
    if (place !== "agora") {
      const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environment = envMap;
      scene.environmentIntensity = 0.6;
      return () => {
        scene.environment = null;
        envMap.dispose();
        pmrem.dispose();
      };
    }
    let live = true;
    const tex = new THREE.TextureLoader().load(SKY_URL, (t) => {
      if (!live) return;
      t.mapping = THREE.EquirectangularReflectionMapping;
      t.colorSpace = THREE.SRGBColorSpace;
      const envMap = pmrem.fromEquirectangular(t).texture;
      scene.background = t;
      scene.environment = envMap;
      scene.environmentIntensity = 0.55;
      scene.fog = new THREE.FogExp2(SKY_FOG_COLOR, SKY_FOG_DENSITY);
      tex.userData.envMap = envMap;
    });
    return () => {
      live = false;
      const envMap = tex.userData.envMap as THREE.Texture | undefined;
      scene.background = null;
      scene.environment = null;
      scene.fog = null;
      envMap?.dispose();
      tex.dispose();
      pmrem.dispose();
    };
  }, [gl, scene, place]);
  return null;
}

/**
 * One shadow-casting key light per place, its ortho shadow camera fitted
 * to the play area. The target is added to the scene graph explicitly —
 * three only tracks a light's aim if the target's matrixWorld updates.
 */
function KeyLight({ place, lightRef }: { place: Place; lightRef?: React.RefObject<THREE.DirectionalLight | null> }) {
  const ownRef = useRef<THREE.DirectionalLight>(null!);
  const light = (lightRef ?? ownRef) as React.RefObject<THREE.DirectionalLight>;
  const scene = useThree((s) => s.scene);
  const agora = place === "agora";
  const city3 = place === "city3";
  useEffect(() => {
    const l = light.current;
    const c = agora ? [0, 0] : city3 ? CITY3_CENTER : CITY_CENTER;
    l.target.position.set(c[0], 0, c[1]);
    scene.add(l.target);
    l.target.updateMatrixWorld();
    return () => {
      l.target.removeFromParent();
    };
  }, [agora, city3, scene]);
  return (
    <directionalLight
      ref={light}
      castShadow
      position={agora ? [14, 22, 10] : city3 ? [120, 220, 90] : [-75, 150, -30]}
      intensity={agora ? 1.5 : 2.6}
      shadow-mapSize-width={2048}
      shadow-mapSize-height={2048}
      shadow-camera-left={agora ? -13 : city3 ? -220 : -72}
      shadow-camera-right={agora ? 13 : city3 ? 220 : 72}
      shadow-camera-top={agora ? 13 : city3 ? 220 : 72}
      shadow-camera-bottom={agora ? -13 : city3 ? -220 : -72}
      shadow-camera-near={agora ? 2 : 10}
      shadow-camera-far={agora ? 60 : city3 ? 800 : 340}
      shadow-bias={city3 ? -0.0004 : -0.00015}
      // City 3 spans 440 m of shadow frustum on one map: its flat roofs and
      // plaza need a wide normal bias or the soft shadow shows acne rings.
      shadow-normalBias={agora ? 0.02 : city3 ? 0.8 : 0.06}
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
 * Embody head camera (?embody=1, Agora): drives the Canvas camera in
 * follow/ride modes from the selected bot's crowd frame (+ seat
 * override). Pose math lives in cameraRig.ts; this component is the
 * per-frame glue — damped vectors in refs, never React state. The
 * parent disables OrbitControls while a bot mode is active; in wide
 * mode this rig only eases the FOV back to the house 45°.
 */
function CameraRig({
  framesRef,
  overridesRef,
  groundY,
  camModeRef,
  index = 0,
  headPoseRef,
}: {
  framesRef: RefObject<AgentFrame[]>;
  overridesRef: RefObject<Map<number, FigureOverride>>;
  groundY: number;
  camModeRef: RefObject<CameraMode>;
  /** The selected bot — the panel's focus figure (Summer by default). */
  index?: number;
  /**
   * The focus figure's head-bone world position, streamed per frame
   * by its CastFigure. In ride mode the camera anchors on the bone
   * itself (cameraRig.rideTargetFromHead) whenever a value has
   * landed; until then it falls back to the feet + eye-height pose.
   */
  headPoseRef?: { current: [number, number, number] | null };
}) {
  const camera = useThree((s) => s.camera);
  const rig = useRef<{
    mode: CameraMode;
    camPos: THREE.Vector3;
    lookPos: THREE.Vector3;
    heading: number;
  } | null>(null);

  useFrame((_, delta) => {
    const persp = camera as THREE.PerspectiveCamera;
    const mode = camModeRef.current;
    if (mode === "wide") {
      rig.current = null; // entering a bot mode later starts from its pose
      if (Math.abs(persp.fov - FOV_WIDE) > 0.01) {
        persp.fov = damp(persp.fov, FOV_WIDE, DAMP_FOV, delta);
        persp.updateProjectionMatrix();
      }
      return;
    }
    const view = botView(
      framesRef.current[index] ?? null,
      overridesRef.current.get(index) ?? null,
      groundY,
    );
    if (!view) return;
    const dt = Math.min(delta, 0.05);
    // Ride anchors on the head bone when the figure is streaming it
    // (Summer does — `mixamorig:Head`); the gaze stays level along
    // the damped heading either way.
    const headPos = mode === "ride" ? (headPoseRef?.current ?? null) : null;
    const targetFor = (v: BotView, heading: number) =>
      mode === "ride"
        ? headPos
          ? rideTargetFromHead(headPos, heading)
          : rideTarget(v, heading)
        : followTarget(v);

    let st = rig.current;
    if (!st || st.mode !== mode) {
      // Entering a mode: adopt the bot's pose outright (a cut, like
      // games cut to first person) instead of swooping across the deck
      // from wherever the spectator camera happened to rest.
      const t = targetFor(view, view.heading);
      st = rig.current = {
        mode,
        camPos: new THREE.Vector3(...t.cam),
        lookPos: new THREE.Vector3(...t.look),
        heading: view.heading,
      };
    }
    if (mode === "ride") st.heading = dampAngle(st.heading, view.heading, DAMP_HEADING, dt);
    const target = targetFor(view, st.heading);
    const posRate = mode === "ride" ? DAMP_POS_RIDE : DAMP_POS_FOLLOW;
    st.camPos.set(
      damp(st.camPos.x, target.cam[0], posRate, dt),
      damp(st.camPos.y, target.cam[1], posRate, dt),
      damp(st.camPos.z, target.cam[2], posRate, dt),
    );
    st.lookPos.set(
      damp(st.lookPos.x, target.look[0], DAMP_LOOK, dt),
      damp(st.lookPos.y, target.look[1], DAMP_LOOK, dt),
      damp(st.lookPos.z, target.look[2], DAMP_LOOK, dt),
    );
    camera.position.copy(st.camPos);
    camera.lookAt(st.lookPos);
    const targetFov = mode === "ride" ? FOV_RIDE : FOV_WIDE;
    const fov = damp(persp.fov, targetFov, DAMP_FOV, dt);
    if (Math.abs(fov - persp.fov) > 0.001) {
      persp.fov = fov;
      persp.updateProjectionMatrix();
    }
  });
  return null;
}

/**
 * Render-rate tracker (Embody spike): one timestamp per rendered
 * frame into the shared FpsMeter (fpsMeter.ts); the panel reads the
 * ~0.5 s rolling average off it on its 400 ms pulse while a bot
 * camera mode is active. Mounted only in embody mode — the meter
 * costs one array push per frame.
 */
function FpsTracker({ meterRef }: { meterRef: RefObject<FpsMeter | null> }) {
  useFrame((state) => {
    meterRef.current?.push(state.clock.elapsedTime * 1000);
  });
  return null;
}

/** Owns one Recast crowd for the active place and steps it every frame. */
function CrowdCast({
  place,
  cast,
  embodyOn,
  controllerRef,
  overridesRef,
  camModeRef,
  camMode,
  framesRef,
  clipTester,
  focusIndex,
  headPoseRef,
}: {
  place: Place;
  cast: CastMember[];
  /** Embody v0 spike (?embody=1): skill layer + spike benches, Agora only. */
  embodyOn: boolean;
  /** Clip tester state (panel-fired catalog clips) for the focus figure. */
  clipTester?: ClipTestState;
  /** The panel's focus figure: camera target, clip-tester consumer
   * and head-bone streamer. Defaults to the Summer-bodied member. */
  focusIndex: number;
  /** Focus figure's head-bone world position stream (ride camera). */
  headPoseRef: { current: [number, number, number] | null };
  controllerRef: RefObject<EmbodyController | null>;
  overridesRef: RefObject<Map<number, FigureOverride>>;
  camModeRef: RefObject<CameraMode>;
  /** Reactive camera mode — the ridden figure does not render in ride. */
  camMode: CameraMode;
  /** Latest crowd frames, shared with the Embody panel's test harness. */
  framesRef: RefObject<AgentFrame[]>;
}) {
  const crowdRef = useRef<PlatformCrowd | null>(null);
  // Body controller (bodyController.ts): smooth heading, turn-in-place clips, speed throttle. ?body=legacy
  // restores the old snap-to-velocity behaviour for A/B comparison; ?bodyDebug=1 logs headings for tests.
  const bodyOn = useMemo(() => new URLSearchParams(window.location.search).get("body") !== "legacy", []);
  const bodyDebug = useMemo(() => new URLSearchParams(window.location.search).get("bodyDebug") === "1", []);
  const bodyStates = useRef<BodyState[]>([]);
  const bodyClock = useRef(0);
  const [crowdReady, setCrowdReady] = useState(false);
  const count = cast.length;
  // Latest cast, for the controller's per-member body lookups (the
  // crowd build effect below runs once per place, so it reads the
  // membership through this ref rather than its build-time closure).
  const castRef = useRef(cast);
  castRef.current = cast;

  useEffect(() => {
    let live = true;
    setCrowdReady(false);
    // Viewing world (City 3): no crowd is built and no cast is placed.
    if (isViewingWorld(place)) return () => {};
    const initialPositions: [number, number][] = Array.from({ length: count }, (_, i) => {
      const h = homeFor(place, i, count);
      return [h[0], h[2]];
    });
    const building =
      place === "agora"
        ? (() => {
            // Deck geometry with the spike benches punched out: the
            // benches are solid — the crowd paths around them, and the
            // sit_on stand point (0.62 m in front of the seat) stays on
            // the mesh. Same 0.1 navmesh cells as the old disc path.
            const obstacles: PlanObstacle[] = AGORA_BENCH_ANCHORS.map((a) => ({
              x: a.seat[0],
              z: a.seat[1],
              heading: a.facing,
              w: 1.3,
              d: 0.5,
            }));
            const geo = buildDeckGeometry(AGORA_WALK_RADIUS, AGORA_KEEP_OUT, obstacles);
            return createGeometryCrowd(geo.positions, geo.indices, count, {
              cellSize: 0.1,
              initialPositions,
              // Each slot cruises at its own body's pace, not the
              // slot-blind band (slow bodies were skating at hurry pace).
              maxSpeedForIndex: (i) => {
                const m = castRef.current[i];
                return m ? cruiseCapForBody(bodyForMember(m)) : undefined;
              },
            });
          })()
        : (() => {
            // Streets only: the navmesh geometry leaves every building
            // footprint out (measured from the world GLB), so the cast
            // walks roads and plazas instead of passing through walls.
            // No initialPositions: spawns are sampled on the navmesh
            // itself, which guarantees they land on open ground.
            const geo = buildStreetGeometry(
              CITY_CENTER[0],
              CITY_CENTER[1],
              CITY_GROUND_Y,
              CITY_RECT_W,
              CITY_RECT_D,
              CITY_FOOTPRINTS,
            );
            return createGeometryCrowd(geo.positions, geo.indices, count, {
              cellSize: 0.5,
              maxSpeedForIndex: (i) => {
                const m = castRef.current[i];
                return m ? cruiseCapForBody(bodyForMember(m)) : undefined;
              },
            });
          })();
    building
      .then((c) => {
        if (!live) {
          c.dispose();
          return;
        }
        crowdRef.current = c;
        if (embodyOn && place === "agora") {
          // Embody v0: the skill layer drives this crowd through a
          // BodyPort adapter over the latest frames. Anchors are cloned
          // so occupancy state belongs to this mount.
          const port = {
            frame: (i: number) => {
              const f = framesRef.current[i];
              return f ? { position: f.position, speed: f.speed, heading: f.heading } : null;
            },
            setControlled: (i: number, on: boolean) => crowdRef.current?.setControlled(i, on),
            moveTo: (i: number, x: number, z: number) => crowdRef.current?.moveAgentTo(i, x, z),
            stop: (i: number) => crowdRef.current?.stopAgent(i),
            setHeading: (i: number, h: number) => crowdRef.current?.setHeading(i, h),
          };
          const ctl = new EmbodyController(
            port,
            AGORA_BENCH_ANCHORS.map((a) => ({ ...a, occupiedBy: null })),
            // Seat drops are computed in the wearer's own body.
            { hipsYFor: (i) => bodyForMember(castRef.current[i]).hipsY },
          );
          controllerRef.current = ctl;
          (window as unknown as Record<string, unknown>).__embody = ctl;
        }
        setCrowdReady(true);
      })
      .catch(() => {});
    return () => {
      live = false;
      controllerRef.current = null;
      crowdRef.current?.dispose();
      crowdRef.current = null;
    };
    // Rebuilt per place; membership changes reconcile via setAgentCount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place]);

  useEffect(() => {
    if (crowdReady) crowdRef.current?.setAgentCount(count);
  }, [count, crowdReady]);

  useFrame((_, delta) => {
    const crowd = crowdRef.current;
    if (!crowd) return;
    const dt = Math.min(delta, 0.05);
    framesRef.current = crowd.step(dt);
    // Hard backstop: no Agora frame ever renders past the deck rim.
    if (place === "agora") {
      for (const fr of framesRef.current) {
        fr.position = clampPositionToRadius(fr.position, AGORA_FRAME_RMAX);
      }
    }
    if (bodyOn) {
      const frames = framesRef.current;
      while (bodyStates.current.length < frames.length) {
        bodyStates.current.push(newBodyState(frames[bodyStates.current.length]?.heading ?? 0));
      }
      for (let i = 0; i < frames.length; i++) {
        const fr = frames[i];
        const m = castRef.current[i];
        const out = stepBody(
          bodyStates.current[i],
          {
            vx: fr.velocity[0],
            vz: fr.velocity[1],
            speed: fr.speed,
            // standing: the crowd's retained heading is the wish (a face skill sets it; a reversal leaves it pointing the new way)
            intent: fr.speed > 0.1 ? null : fr.heading,
            walkSpeed: (m ? bodyForMember(m) : BODY_CAST).walkSpeed,
          },
          dt,
        );
        fr.heading = out.heading;
        fr.body = out;
        crowd.setSpeedScale(i, out.speedScale);
      }
      if (bodyDebug) {
        bodyClock.current += dt;
        const w = window as unknown as { __bodyLog?: { t: number; dt: number; h: number[]; v: number[]; p: [number, number][]; turn: number[] }[] };
        const log = (w.__bodyLog ??= []);
        log.push({
          t: bodyClock.current,
          dt,
          h: frames.map((f) => f.heading),
          v: frames.map((f) => f.speed),
          p: frames.map((f) => f.position),
          turn: frames.map((f) => (f.body?.turn ? (f.body.turn.clip === "TurnLeft90" ? 1 : -1) : 0)),
        });
        if (log.length > 6000) log.shift();
      }
    } else if (bodyDebug) {
      bodyClock.current += dt;
      const w = window as unknown as { __bodyLog?: { t: number; dt: number; h: number[]; v: number[]; p: [number, number][]; turn: number[] }[] };
      const log = (w.__bodyLog ??= []);
      log.push({ t: bodyClock.current, dt, h: framesRef.current.map((f) => f.heading), v: framesRef.current.map((f) => f.speed), p: framesRef.current.map((f) => f.position), turn: [] });
      if (log.length > 6000) log.shift();
    }
    const ctl = controllerRef.current;
    if (ctl) {
      ctl.tick(dt);
      overridesRef.current.clear();
      for (let i = 0; i < count; i++) {
        const ov = ctl.overrideFor(i);
        if (ov) overridesRef.current.set(i, ov);
      }
    }
  });

  const groundY =
    place === "agora"
      ? AGORA_GROUND_Y
      : place === "city3"
        ? CITY3_GROUND_Y
        : CITY_GROUND_Y;

  return (
    <>
      {embodyOn && place === "agora" ? (
        <CameraRig
          framesRef={framesRef}
          overridesRef={overridesRef}
          groundY={groundY}
          camModeRef={camModeRef}
          index={focusIndex}
          headPoseRef={headPoseRef}
        />
      ) : null}
      {embodyOn && place === "agora"
        ? AGORA_BENCH_ANCHORS.map((a) => (
            // Spike stand-in bench: the Smart Object and its anchor
            // arrive together. Production benches are shelf assets in
            // the world GLB carrying the same anchor data.
            <group key={a.id} position={[a.seat[0], groundY, a.seat[1]]} rotation={[0, a.facing, 0]}>
              <mesh position={[0, a.seatHeight - 0.035, 0]} castShadow receiveShadow>
                <boxGeometry args={[1.3, 0.07, 0.45]} />
                <meshStandardMaterial color="#454c58" metalness={0.3} roughness={0.5} />
              </mesh>
              <mesh position={[-0.55, a.seatHeight / 2, 0]} castShadow>
                <boxGeometry args={[0.08, a.seatHeight, 0.4]} />
                <meshStandardMaterial color="#363c46" metalness={0.3} roughness={0.55} />
              </mesh>
              <mesh position={[0.55, a.seatHeight / 2, 0]} castShadow>
                <boxGeometry args={[0.08, a.seatHeight, 0.4]} />
                <meshStandardMaterial color="#363c46" metalness={0.3} roughness={0.55} />
              </mesh>
              <mesh position={[0, a.seatHeight + 0.22, -0.22]} castShadow>
                <boxGeometry args={[1.3, 0.44, 0.05]} />
                <meshStandardMaterial color="#454c58" metalness={0.3} roughness={0.5} />
              </mesh>
              <mesh position={[0, a.seatHeight + 0.44, -0.22]}>
                <boxGeometry args={[1.3, 0.03, 0.03]} />
                <meshStandardMaterial color="#0b0e11" emissive="#2fd4ff" emissiveIntensity={2.2} />
              </mesh>
            </group>
          ))
        : null}
      {isViewingWorld(place)
        ? null
        : cast.map((member, i) => (
            <CastFigure
              key={member.id}
              framesRef={framesRef}
              overridesRef={overridesRef}
              index={i}
              baseY={groundY}
              home={place === "city" ? cityHomeFor(i, count) : homeFor(place, i, count)}
              label={member.name}
              body={bodyForMember(member)}
              clipTester={i === focusIndex ? clipTester : undefined}
              headPoseRef={i === focusIndex ? headPoseRef : undefined}
              hidden={embodyOn && i === focusIndex && camMode === "ride"}
            />
          ))}
    </>
  );
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
  /** Sound v1: the PA banner + mute state come from the director. */
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
  const banner = sound?.bannerText() ?? null;
  return (
    <div className="w-embody-panel w-walk-panel">
      {banner ? (
        <div className="w-pa-banner" role="status">
          📣 {banner}
        </div>
      ) : null}
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
 * Embody v0 spike panel (?embody=1, Agora only): hand-drives the first
 * cast member through the skill menu so the body layer can be watched
 * without the gateway. The same controller sits on window.__embody.
 */
function EmbodyPanel({
  cast,
  controllerRef,
  framesRef,
  glCanvasRef,
  camMode,
  onCamMode,
  clipTester,
  focusIndex,
  onFocus,
  fpsMeter,
}: {
  cast: CastMember[];
  /** Clip tester: fires catalog clips on the focus figure (clips.ts). */
  clipTester: ClipTestState;
  /** Which cast member the cameras + clip tester ride (Summer default). */
  focusIndex: number;
  onFocus: (memberId: string) => void;
  /** Shared render-rate meter — read on the panel's 400 ms pulse. */
  fpsMeter: FpsMeter;
  controllerRef: RefObject<EmbodyController | null>;
  /** Latest crowd frames — the harness reads Amara's anim state/speed. */
  framesRef: RefObject<AgentFrame[]>;
  /** The WebGL canvas — the vision probe captures it in Ride mode. */
  glCanvasRef: RefObject<HTMLCanvasElement | null>;
  camMode: CameraMode;
  onCamMode: (m: CameraMode) => void;
}) {
  const [, setPulse] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setPulse((p) => p + 1), 400);
    return () => clearInterval(id);
  }, []);
  const ctl = controllerRef.current;
  const st = ctl?.stateFor(0);
  const last = ctl?.events[ctl.events.length - 1];
  const name = cast[0]?.name ?? "first bot";
  const focusName = cast[focusIndex]?.name ?? name;
  const benchB = AGORA_BENCH_ANCHORS[1];

  // Clip stepping: prev/next walk the catalog in order and fire each
  // clip on the focus figure, so the whole 45 can be auditioned in
  // sequence without hunting the list. Clicking a list entry moves
  // the step position to it.
  const [clipIdx, setClipIdx] = useState(0);
  const stepClip = (d: number) => {
    const next = (clipIdx + d + CLIP_CATALOG.length) % CLIP_CATALOG.length;
    setClipIdx(next);
    clipTester.fire(CLIP_CATALOG[next].name);
    setPulse((p) => p + 1);
  };

  // ---- "Own Amara" test harness -------------------------------------
  // Animation tester: Patrol keeps issuing go_to legs between the two
  // bench approaches whenever Amara is idle, so the Walk clip plays
  // continuously; toggling off issues stop. If she is seated when a leg
  // comes due, the harness stands her up first.
  const [patrolOn, setPatrolOn] = useState(false);
  const patrolLeg = useRef(0);
  useEffect(() => {
    if (!patrolOn) return;
    const id = setInterval(() => {
      const c = controllerRef.current;
      if (!c) return;
      const s = c.stateFor(0);
      if (s.current) return; // a skill is running — the leg waits
      if (s.posture === "seated") {
        c.issue(0, { skill: "stand" });
        return;
      }
      const leg = patrolLeg.current % AGORA_BENCH_ANCHORS.length;
      patrolLeg.current = leg + 1;
      c.issue(0, { skill: "go_to", target: AGORA_BENCH_ANCHORS[leg].approach });
    }, 300);
    return () => clearInterval(id);
  }, [patrolOn, controllerRef]);
  const togglePatrol = () => {
    if (patrolOn) controllerRef.current?.issue(0, { skill: "stop" });
    setPatrolOn(!patrolOn);
  };
  const turn180 = () => {
    const c = controllerRef.current;
    if (!c) return;
    c.issue(0, { skill: "face", target: { heading: c.stateFor(0).heading + Math.PI } });
  };

  // Vision FPS probe ("Amara's eye"): in Ride mode the main camera IS
  // the head camera, so capturing the WebGL canvas measures exactly
  // what a served `look` would cost. Capture = one drawImage into the
  // preview canvas — no encoding, no network (visionProbe.ts owns the
  // cadence gate and the statistics).
  const [probeFps, setProbeFps] = useState(0);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const statsRef = useRef<ProbeStats>(initialProbeStats());
  useEffect(() => {
    if (camMode !== "ride" || probeFps <= 0) return;
    statsRef.current = initialProbeStats();
    const id = setInterval(() => {
      const src = glCanvasRef.current;
      const dst = previewRef.current;
      if (!src || !dst) return;
      const ctx = dst.getContext("2d");
      if (!ctx) return;
      const t0 = performance.now();
      if (!shouldCapture(t0, statsRef.current.lastAt, probeFps)) return;
      ctx.drawImage(src, 0, 0, PROBE_WIDTH, PROBE_HEIGHT);
      statsRef.current = recordCapture(statsRef.current, t0, performance.now() - t0);
    }, 40);
    return () => clearInterval(id);
  }, [camMode, probeFps, glCanvasRef]);
  const stats = statsRef.current;
  const frame0 = framesRef.current[0];

  return (
    <div className="w-embody-panel">
      <div className="w-embody-title">Embody spike — driving {name}</div>
      <div className="w-embody-row">
        <button type="button" onClick={() => ctl?.issue(0, { skill: "sit_on", anchorId: "bench-a" })}>
          Sit on Bench A
        </button>
        <button type="button" onClick={() => ctl?.issue(0, { skill: "stand" })}>
          Stand
        </button>
        <button type="button" onClick={() => ctl?.issue(0, { skill: "face", target: { point: [0, 0] } })}>
          Face the globe
        </button>
        <button type="button" onClick={() => ctl?.issue(0, { skill: "go_to", target: benchB.approach })}>
          Walk to Bench B
        </button>
        <button type="button" onClick={() => ctl?.issue(0, { skill: "stop" })}>
          Stop
        </button>
      </div>
      <div className="w-embody-row" role="group" aria-label="Camera mode">
        <button
          type="button"
          className={camMode === "wide" ? "active" : ""}
          onClick={() => onCamMode("wide")}
        >
          Wide
        </button>
        <button
          type="button"
          className={camMode === "follow" ? "active" : ""}
          onClick={() => onCamMode("follow")}
        >
          Follow
        </button>
        <button
          type="button"
          className={camMode === "ride" ? "active" : ""}
          onClick={() => onCamMode("ride")}
        >
          Ride
        </button>
      </div>
      <div className="w-embody-status">
        {ctl
          ? `${st?.posture ?? "standing"}${st?.current ? ` · ${st.current}` : " · idle"}`
          : "warming up…"}
        {last ? ` — last event: ${last.type} ${last.skill}` : ""}
        {` · camera: ${camMode}`}
      </div>
      {camMode !== "wide" ? (
        <div className="w-embody-status">
          {`render ${fpsMeter.fps().toFixed(0)} fps · 0.5 s rolling average · riding ${focusName}`}
        </div>
      ) : null}
      <div className="w-embody-title w-embody-section">Camera & clip focus</div>
      <div className="w-embody-row" role="group" aria-label="Focus member">
        {cast.map((m, i) => (
          <button
            key={m.id}
            type="button"
            className={i === focusIndex ? "active" : ""}
            onClick={() => onFocus(m.id)}
          >
            {m.name}
          </button>
        ))}
      </div>
      <div className="w-embody-status">
        {`Follow / Ride cameras and the clip tester target ${focusName} — the skill buttons above still drive ${name}`}
      </div>
      <div className="w-embody-title w-embody-section">Test harness — {name}</div>
      <div className="w-embody-row" role="group" aria-label="Animation tester">
        <button
          type="button"
          className={patrolOn ? "active" : ""}
          onClick={togglePatrol}
        >
          Patrol
        </button>
        <button type="button" onClick={turn180}>
          Turn 180°
        </button>
      </div>
      <div className="w-embody-status">
        {frame0
          ? `anim ${frame0.state} · ${frame0.speed.toFixed(2)} m/s · ${st?.posture ?? "standing"} · ${st?.current ?? "no skill"}`
          : "anim — · no frame yet"}
      </div>
      <div className="w-embody-title w-embody-section">Clip tester — {focusName}</div>
      <div className="w-embody-row" role="group" aria-label="Step clips">
        <button type="button" onClick={() => stepClip(-1)}>
          ← Prev clip
        </button>
        <button type="button" onClick={() => stepClip(1)}>
          Next clip →
        </button>
      </div>
      <div className="w-embody-status">
        {`clip ${clipIdx + 1} / ${CLIP_CATALOG.length} — ${CLIP_CATALOG[clipIdx].name}`}
        {clipTester.current ? ` · firing ${clipTester.current} on ${focusName}` : ""}
      </div>
      <div className="w-embody-row w-clip-list" role="group" aria-label="Clip tester">
        {CLIP_CATALOG.map((c, ci) => {
          const active =
            c.name === "Idle" ? clipTester.current === null : clipTester.current === c.name;
          return (
            <button
              key={c.name}
              type="button"
              className={active ? "active" : ""}
              onClick={() => {
                clipTester.fire(c.name);
                setClipIdx(ci);
                setPulse((p) => p + 1);
              }}
            >
              {c.name}
              {c.loop ? " ∞" : ""}
            </button>
          );
        })}
      </div>
      <div className="w-embody-status">
        {clipTester.current
          ? `firing ${clipTester.current} — one-shots return to Idle, loops hold`
          : "no test clip — body layer owns the figure"}
      </div>
      <div className="w-embody-title w-embody-section">{name}'s eye — vision fps probe</div>
      {camMode === "ride" ? (
        <>
          <div className="w-embody-row" role="group" aria-label="Vision capture rate">
            {PROBE_CADENCES.map((f) => (
              <button
                key={f}
                type="button"
                className={probeFps === f ? "active" : ""}
                onClick={() => setProbeFps(f)}
              >
                {f} fps
              </button>
            ))}
            <button
              type="button"
              className={probeFps === 0 ? "active" : ""}
              onClick={() => setProbeFps(0)}
            >
              Off
            </button>
          </div>
          <canvas
            ref={previewRef}
            width={PROBE_WIDTH}
            height={PROBE_HEIGHT}
            className="w-embody-vision"
          />
          <div className="w-embody-status">
            {`target ${probeFps} fps · achieved ${stats.fpsEma.toFixed(1)} fps · ${stats.costEmaMs.toFixed(2)} ms/capture · ${stats.captures} frames`}
          </div>
        </>
      ) : (
        <div className="w-embody-status">switch to Ride to probe {name}'s eye</div>
      )}
    </div>
  );
}

export function GlbWorld({ cast }: { cast: CastMember[] }) {
  // ?world=city|city3 deep-links a world (same pattern as ?embody=1).
  const [place, setPlace] = useState<Place>(() => {
    const w = new URLSearchParams(window.location.search).get("world");
    return w === "city" || w === "city3" ? w : "agora";
  });
  const agora = place === "agora";
  // Jim retired the old Body Block bots (2026-11-05): first from the
  // Agora, then from City 1 the same evening. Every walking world's
  // crowd is only the members wearing an explicit kept body (Summer
  // and the KayKit guests).
  const visibleCast = useMemo(() => excludeBody(cast, BODY_CAST), [cast]);

  // Embody v0 spike: ?embody=1 turns on the skill layer (Agora only).
  const embodyOn = useMemo(
    () => new URLSearchParams(window.location.search).get("embody") === "1",
    [],
  );
  const controllerRef = useRef<EmbodyController | null>(null);
  // Clip tester for the Embody panel: one shared state object — the
  // panel fires clips into it, the focus figure blends toward them.
  const clipTesterRef = useRef<ClipTestState | null>(null);
  if (clipTesterRef.current === null) clipTesterRef.current = new ClipTestState();
  // Walk-mode HUD (City 3): one shared override state — the panel's
  // Run/door buttons drive it, the walk bot's CastFigure consumes it as
  // its clip tester. Plus the walker's latest frame for the status line.
  const walkOverrideRef = useRef<WalkClipOverride | null>(null);
  if (walkOverrideRef.current === null) walkOverrideRef.current = new WalkClipOverride();
  const walkFrameRef = useRef<WalkFrameInfo | null>(null);
  const overridesRef = useRef(new Map<number, FigureOverride>());
  // Latest crowd frames, shared between CrowdCast (writer), the camera
  // rig and CastFigure (readers), and the panel's "Own Amara" harness.
  const framesRef = useRef<AgentFrame[]>([]);
  // Camera + clip-tester focus: which cast member the Follow/Ride
  // cameras ride and the tester fires on. Defaults to the member
  // wearing Summer's body (WorldView always fields her); the panel
  // can move it to any member by id.
  const [focusPick, setFocusPick] = useState<string | null>(null);
  const focusIndex = useMemo(() => {
    if (focusPick) {
      const picked = visibleCast.findIndex((m) => m.id === focusPick);
      if (picked >= 0) return picked;
    }
    const summer = visibleCast.findIndex((m) => bodyForMember(m) === BODY_SUMMER);
    return summer >= 0 ? summer : 0;
  }, [visibleCast, focusPick]);
  // The focus figure's head-bone world position, streamed per frame
  // by its CastFigure — the ride camera's anchor.
  const headPoseRef = useRef<[number, number, number] | null>(null);
  // Render-rate meter: FpsTracker (in-Canvas) writes, the panel reads.
  const fpsMeterRef = useRef<FpsMeter | null>(null);
  if (fpsMeterRef.current === null) fpsMeterRef.current = new FpsMeter();
  // The WebGL canvas element, captured by Canvas onCreated — the vision
  // probe's frame source. preserveDrawingBuffer (embody only) is what
  // makes reading it back outside the render loop meaningful.
  const glCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Head-camera mode (Embody spike): state for the panel buttons and
  // OrbitControls, mirrored into a ref the camera rig reads per frame.
  const keyLightRef = useRef<THREE.DirectionalLight | null>(null);
  const city3Rooms = useCity3Rooms(place === "city3");
  // ?walk=1 (with ?world=city3) deep-links straight into the walkable bot's first-person view.
  const walkLink = useMemo(() => {
    const q = new URLSearchParams(window.location.search);
    return q.get("world") === "city3" && q.get("walk") === "1";
  }, []);
  // ?agent=1 (with ?world=city3): the Phase 0 agent-experiment harness —
  // Scout spawns at the fountain and window.__scout drives it (scout.ts).
  // Dev-only: without the flag nothing mounts and behavior is unchanged.
  // Agent mode wins over walk mode if both flags are set (one bot, one
  // camera owner).
  const agentOn = useMemo(() => {
    const q = new URLSearchParams(window.location.search);
    return place === "city3" && q.get("agent") === "1";
  }, [place]);
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
  // machine, and feeds the walk HUD its PA banner + mute state.
  const soundRef = useRef<SoundDirector | null>(null);
  if (soundRef.current === null) soundRef.current = new SoundDirector();
  // Plaza TTS probe (plazaTts.ts): the Mage↔Summer greeting. One
  // runner per mount; the 100 ms driver below feeds it the bot's
  // position (its trigger is the keeper's greeting radius) and it
  // speaks through the director's voice emitter — but only after
  // the user grants sound consent (the runner checks, the director
  // enforces). Summer's Talking clip rides the walk override, the
  // same channel the HUD's clip tests use.
  const plazaRef = useRef<PlazaGreeting | null>(null);
  if (plazaRef.current === null) {
    plazaRef.current = createPlazaGreeting(soundRef.current, (on) => {
      const ov = walkOverrideRef.current;
      if (!ov) return;
      if (on) ov.fire("Talking");
      else ov.clear();
    });
  }
  const walking = place === "city3" && camMode !== "wide";
  // The walk bot's latest position, published by CityWalker per stepped
  // frame and read by BazaarLife (the stall keeper's approach trigger).
  // Cleared when walk mode ends so a stale position can't hold a
  // conversation open forever.
  const botPosRef = useRef<{ x: number; z: number } | null>(null);
  useEffect(() => {
    if (!walking) botPosRef.current = null;
  }, [walking]);
  // City 3: which hero building to fly to (cutaway shows on arrival); nonce re-fires a repeat click.
  const [heroFocus, setHeroFocus] = useState<{ id: string; nonce: number } | null>(null);
  const camModeRef = useRef<CameraMode>(walkLink ? "ride" : "wide");
  useEffect(() => {
    camModeRef.current = camMode;
  }, [camMode]);

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
      w.__sound = {
        snapshot: () => sound.snapshot(),
        announce: (text: string, scope: string, clip?: string) =>
          sound.announce(text, scope, clip ?? null),
        setMuted: (m: boolean) => sound.setMuted(m),
        arm: () => sound.arm(),
        grantConsent: () => sound.grantConsent(),
        declineConsent: () => sound.declineConsent(),
      };
    }
    // ?ttsDebug=1: drive/inspect the plaza greeting + Phonon bench.
    const ttsDebug = new URLSearchParams(window.location.search).has("ttsDebug");
    if (ttsDebug) {
      const w = window as unknown as Record<string, unknown>;
      const plaza = plazaRef.current;
      w.__tts = {
        start: () =>
          plaza?.start(() => {
            const fr = walkFrameRef.current;
            return fr && fr.x !== undefined && fr.z !== undefined
              ? { x: fr.x, z: fr.z }
              : null;
          }),
        log: () => plaza?.log ?? [],
        status: () => plaza?.status ?? "none",
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
  useEffect(() => {
    return () => {
      soundRef.current?.dispose();
      soundRef.current = null;
    };
  }, []);

  // Elevated three-quarter spectator defaults, worked out from the play
  // areas: Agora from 25 m at ~37° elevation frames the whole 9.7 m deck
  // disc with headroom; City from ~114 m at ~40° frames the whole
  // 110×70 m street rectangle the same way.
  const camera = useMemo(
    () =>
      agora
        ? { position: [14, 16, 14] as [number, number, number], fov: 45, near: 0.1, far: 600 }
        : place === "city"
          ? { position: [-103, 74, -33] as [number, number, number], fov: 45, near: 0.5, far: 3000 }
          : { position: [290, 250, 340] as [number, number, number], fov: 45, near: 0.5, far: 6000 },
    [place],
  );
  const target: [number, number, number] = agora
    ? [0, AGORA_GROUND_Y, 0]
    : place === "city"
      ? [CITY_CENTER[0], 1, CITY_CENTER[1]]
      : [CITY3_CENTER[0], 8, CITY3_CENTER[1]];

  return (
    <div className="w-glb-root">
      <Canvas
        key={place}
        camera={camera}
        frameloop={agentOn ? "demand" : "always"}
        shadows={agentOn ? false : "soft"}
        gl={{ antialias: true, preserveDrawingBuffer: embodyOn }}
        onCreated={({ gl }) => {
          glCanvasRef.current = gl.domElement;
        }}
        style={{ position: "absolute", inset: 0 }}
      >
        <ambientLight intensity={0.12} color="#8fa3cc" />
        <StageEnvironment place={place} />
        <KeyLight place={place} lightRef={keyLightRef} />
        <ShadowTagger />
        {embodyOn && agora ? <FpsTracker meterRef={fpsMeterRef} /> : null}
        {agora ? (
          <EffectComposer>
            <Bloom
              mipmapBlur
              intensity={0.4}
              luminanceThreshold={0.6}
              luminanceSmoothing={0.2}
            />
          </EffectComposer>
        ) : null}
        <Suspense fallback={null}>
          {place === "city3" ? (
            <DistrictWorld residentUrl={CITY3_URL} light={keyLightRef} collide={camMode === "wide"} meshesRef={colliderMeshesRef} walk={walkColliders} />
          ) : (
          <WorldEnv url={agora ? AGORA_URL : CITY_URL} />
          )}
          {place === "city3" ? (
            <>
              <ClipCutaway rooms={city3Rooms} focus={heroFocus} />
              <InteriorStreamer rooms={city3Rooms} walk={walkColliders} interact={interactRef.current} />
              <BazaarLife getMeshes={getColliderMeshes} walk={walkColliders} botPosRef={botPosRef} />
              <TeaDoorLeaf controller={teaDoorRef.current} />
              {!agentOn ? <TeaDoorTicker controller={teaDoorRef.current} /> : null}
              {!agentOn ? <InteractTicker controller={interactRef.current} /> : null}
            </>
          ) : null}
          {walking && !agentOn ? (
            <CityWalker
              mode={camMode === "follow" ? "follow" : "ride"}
              onMode={setCamMode}
              onExit={() => setCamMode("wide")}
              onPosition={(x, z) => {
                botPosRef.current = { x, z };
              }}
              getMeshes={getColliderMeshes}
              walk={walkColliders}
              override={walkOverrideRef.current}
              frameRef={walkFrameRef}
              door={teaDoorRef.current}
              interact={interactRef.current}
            />
          ) : null}
          {agentOn ? (
            <ScoutAgent getMeshes={getColliderMeshes} walk={walkColliders} rooms={city3Rooms} door={teaDoorRef.current} interact={interactRef.current} />
          ) : null}
          <CrowdCast
            place={place}
            cast={visibleCast}
            embodyOn={embodyOn}
            controllerRef={controllerRef}
            overridesRef={overridesRef}
            camModeRef={camModeRef}
            camMode={camMode}
            framesRef={framesRef}
            clipTester={agora ? (clipTesterRef.current ?? undefined) : undefined}
            focusIndex={focusIndex}
            headPoseRef={headPoseRef}
          />
        </Suspense>
        <OrbitControls
          makeDefault
          target={target}
          enableDamping
          // Parked while a bot camera mode owns the camera (drei only
          // updates controls when enabled, so the rig never fights it).
          enabled={(!embodyOn || !agora || camMode === "wide") && !walking && !agentOn}
          maxPolarAngle={Math.PI / 2 - 0.04}
          // City 3: 3 m close-ups; CameraCollider (in DistrictWorld) keeps the camera out of walls.
          minDistance={agora ? 6 : place === "city3" ? 3 : 20}
          maxDistance={agora ? 55 : place === "city3" ? 1100 : 450}
        />
      </Canvas>
      <div className="w-glb-toggle" role="group" aria-label="Choose world">
        <button
          type="button"
          className={agora ? "active" : ""}
          onClick={() => {
            setPlace("agora");
            setCamMode("wide");
          }}
        >
          Agora
        </button>
        <button
          type="button"
          className={place === "city" ? "active" : ""}
          onClick={() => {
            setPlace("city");
            setCamMode("wide");
          }}
        >
          City
        </button>
        <button
          type="button"
          className={place === "city3" ? "active" : ""}
          onClick={() => {
            setPlace("city3");
            setCamMode("wide");
          }}
        >
          City 3
        </button>
      </div>
      {place === "city3" ? (
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
      {walking ? (
        <div className="w-walk-hint" aria-hidden="true">
          click to look · W A S D move · Shift run · V camera · Esc leave
        </div>
      ) : null}
      {walking ? (
        <WalkHudPanel override={walkOverrideRef.current} frameRef={walkFrameRef} door={teaDoorRef.current} interact={interactRef.current} sound={soundRef.current} />
      ) : null}
      {place === "city3" && !walking ? (
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
        </div>
      ) : null}
      {embodyOn && agora ? (
        <EmbodyPanel
          cast={visibleCast}
          controllerRef={controllerRef}
          framesRef={framesRef}
          glCanvasRef={glCanvasRef}
          camMode={camMode}
          onCamMode={setCamMode}
          clipTester={clipTesterRef.current}
          focusIndex={focusIndex}
          onFocus={setFocusPick}
          fpsMeter={fpsMeterRef.current}
        />
      ) : null}
    </div>
  );
}
