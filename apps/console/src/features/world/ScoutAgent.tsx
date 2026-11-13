// ScoutAgent.tsx — the React shell of the Phase 0 agent harness (scout.ts
// owns the pure logic). Mounted by GlbWorld ONLY in City 3 with ?agent=1;
// without the flag nothing here exists and the console is unchanged.
//
// Scout is a cast body (Remy — registered on main, NOT the user's Summer
// bot) driven by the ScoutExecutor through walker.ts's intent seam, the
// same one the keyboard uses. The shell owns: the collision world (same
// construction as CityWalker's), the follow camera (which also keeps
// interiors streamed around Scout — InteriorStreamer keys on the camera),
// the first-person look capture, and the window.__scout promise API the
// runner drives:
//
//   __scout.ready()    -> boolean (world + data + spawn complete)
//   __scout.snapshot() -> blackboard snapshot (see scoutSnapshot below)
//   __scout.look()     -> { image: PNG data URL, scene: oracle objects }
//   __scout.act(action)-> outcome + fresh snapshot
//   __scout.places() / __scout.sittables() -> the registered world data
//
// Look capture: a dedicated render target + a camera posed at Scout's head
// bone (CastFigure's headPoseRef stream, the vision probe's anchor), NOT a
// borrow of the follow camera's frame — the probe's drawImage readback
// needs preserveDrawingBuffer (off outside embody) and would return the
// spectator view, not Scout's eyes. Same head-pose source, exact framing.
//
// `say` is log-only in Phase 0: the console has no speech-bubble/caption
// mechanism to reuse cheaply, and inventing one is not harness work. The
// runner's trace carries the text; Scout's utterances land in the console
// log with a [scout-say] prefix.
//
// Simulation clock: the executor ticks on a 100 ms interval, NOT on
// render frames. Measured on this machine, headless SwiftShader renders
// the full city at ~1 fps — coupling the sim to rAF made Scout live at
// 0.03x real time (a 2 s wait took 168 s of wall clock). The walker step
// is cheap; rendering is not. Agent mode therefore also runs the Canvas
// frameloop="demand" with shadows off (GlbWorld): ScoutAgent pumps
// frames while the world loads, then invalidates on a 1 s heartbeat —
// enough for interior streaming (140 m load radius) while the sim keeps
// the thread. Look captures render their own target and do not depend
// on the canvas loop at all. The figure/camera update per rendered
// frame from the executor's state, so the spectator view steps at the
// heartbeat while agent time (snapshot t, action budgets) tracks wall
// time.

import { useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { CastFigure } from "./CastFigure";
import { BODY_REMY } from "./bodies";
import { EYE_FORWARD, HEAD_HEIGHT, damp } from "./cameraRig";
import { remoteFiguresNear } from "./remoteFigures";
import type { City3Room } from "./city3";
import { ClipTestState } from "./clips";
import type { AgentFrame } from "./locomotion";
import {
  ScoutExecutor,
  autoActivateTarget,
  districtAt,
  nearestPlace,
  oracleScene,
  roomAt,
  type OracleObject,
  type ScoutAction,
  type ScoutDistrict,
  type ScoutOutcome,
  type ScoutPlace,
  type Sittable,
} from "./scout";
import { planRoute, sampleNavigationPatch, navigationSegment, type NavigationPatch } from "./navigation";
import { avoidActorInput, type ActorBody } from "./actors";
import type { WalkColliders } from "./walkColliders";
import { ScoutVision, pointVisible, projectRoute, renderRouteOverlay, type ScoutVisionFrame } from "./scoutVision";
import { createCapsuleWorld } from "./capsuleWorld";
import { newWalkerFrame, useWalkWorld, writeWalkerFrame } from "./walkerBody";
import { clipChannel, type TeaDoorChannel, type TeaDoorController } from "./teaDoor";
import type { InteractController } from "./interactables";
import { BASE } from "../../lib/api";
import { AgentLabel, cleanSpeech, type SpeechState } from "./SpeechBubble";

const SCOUT_ACTOR = "scout";
import { clipFor, findSpawn, makeWalker, WALK_CONFIG, type WalkerState } from "./walker";

export interface ScoutSnapshot {
  t: number;
  pos: [number, number, number];
  headingDeg: number;
  bodyHeadingDeg: number;
  speed: number;
  groundY: number;
  district: string | null;
  nearestPlace: { id: string; name: string; kind: string; dist: number } | null;
  insideRoom: string | null;
  posture: string;
  clip: string | null;
  renderedClip: string | null;
  busy: boolean;
  currentAction: string | null;
  /** Other movers within 10 m. Run 1 has no other movers in City 3. */
  movers: ActorBody[];
  session: string;
  body: { radius: number; height: number };
  route: [number, number][];
  looksUsed: number;
  finished: boolean;
  worldKind: string;
}

export interface ScoutApi {
  ready: () => boolean;
  /** The Tea House door (headless checks); null without one. */
  door: () => { phase: string; state: string; angle: number; owner: string | null } | null;
  /** The interactables (headless checks); null without a controller. */
  interact: () => { session: { id: string; phase: string; t: number } | null; props: { id: string; on: boolean }[] } | null;
  snapshot: () => ScoutSnapshot | null;
  look: (opts?: { pitchDeg?: number }) => Promise<{ image: string | null; scene: OracleObject[]; depth: ScoutVisionFrame["depth"] | null; camera: ScoutVisionFrame["camera"] | null; simulationTime: number; snapshot: ScoutSnapshot | null; routeImage: string | null; route: ReturnType<typeof projectRoute> }>;
  act: (action: ScoutAction) => Promise<(ScoutOutcome & { snapshot: ScoutSnapshot | null }) | null>;
  map: () => (NavigationPatch & { simulationTime: number; session: string }) | null;
  places: () => ScoutPlace[];
  sittables: () => Sittable[];
  /** The runner hands over its agent token so egg activations can claim server-side. Memory only: never stored or logged. */
  setAgentToken: (token: string | null) => void;
}

const deg = (r: number) => Math.round(((r * 180) / Math.PI) * 10) / 10;

export function ScoutAgent({
  getMeshes,
  walk,
  rooms,
  door,
  interact,
  positionRef,
  actorId = SCOUT_ACTOR,
  label,
  primary = true,
  spawn,
}: {
  actorId?: string;
  /** Name tag above the head (owner-chosen agent name). Defaults from the actor id. */
  label?: string;
  primary?: boolean;
  spawn?: readonly [x: number, z: number, heading: number];
  getMeshes: () => THREE.Mesh[];
  walk?: WalkColliders;
  rooms: City3Room[];
  /** The Tea House door (teaDoor.ts): Scout walks through it with the full open-door performance, on Scout's clock. */
  door?: TeaDoorController;
  /** Usable props (interactables.ts): Scout walks to one and uses it (`interact` action), on Scout's clock. */
  interact?: InteractController;
  /** Scout's latest position, written every sim step (the Tea House bartender greets Scout too). */
  positionRef?: { current: { x: number; z: number } | null };
}) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update?: () => void } | null;

  const staticWorld = useWalkWorld(getMeshes, walk);
  const world = useMemo(() => walk?.actors.wrapWorld(staticWorld, actorId, 1.7) ?? staticWorld, [staticWorld, walk, actorId]);
  const planningWorld = useMemo(() => walk ? createCapsuleWorld(() => walk.listWithout("door:tea")) : staticWorld, [walk, staticWorld]);
  const session = useRef(crypto.randomUUID());
  const visibleMovers = (): ActorBody[] => {
    const s = state.current;
    if (!s || !walk) return [];
    const eye = new THREE.Vector3(s.x, s.y + HEAD_HEIGHT, s.z);
    return walk.actors.nearby(actorId, [s.x, s.y, s.z], 10).filter(b => {
      const target = new THREE.Vector3(b.position[0], b.position[1] + b.height * .6, b.position[2]);
      const direction = target.clone().sub(eye), distance = direction.length();
      const bearing = Math.atan2(direction.x, direction.z) - s.body;
      if (Math.abs(Math.atan2(Math.sin(bearing), Math.cos(bearing))) > Math.PI / 4) return false;
      const ray = new THREE.Raycaster(eye, direction.normalize(), .05, Math.max(.05, distance - b.radius));
      return ray.intersectObjects(walk.list(), false).length === 0;
    });
  };

  const data = useRef<{ places: ScoutPlace[]; sittables: Sittable[]; districts: ScoutDistrict[] } | null>(null);
  const clips = useRef<ClipTestState | null>(null);
  if (clips.current === null) clips.current = new ClipTestState();
  const scoutChannel = useRef<TeaDoorChannel | null>(null);
  if (scoutChannel.current === null) scoutChannel.current = clipChannel(clips.current);
  const exec = useRef<ScoutExecutor | null>(null);
  const state = useRef<WalkerState | null>(null);
  const renderedReady = useRef(false);
  const frames = useRef<AgentFrame[]>([newWalkerFrame()]);
  const figure = useRef<THREE.Group>(null);
  const playingClip = useRef<string | null>(null);
  const headPose = useRef<[number, number, number] | null>(null);
  const looksUsed = useRef(0);
  const camPos = useRef<THREE.Vector3 | null>(null);
  const lookRig = useRef<ScoutVision | null>(null);
  useEffect(() => () => { lookRig.current?.dispose(); lookRig.current = null; }, []);

  // Load the harness's world data (generated assets; see scout.ts header).
  useEffect(() => {
    let live = true;
    const get = async <T,>(url: string): Promise<T> => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: ${r.status}`);
      return (await r.json()) as T;
    };
    void (async () => {
      try {
        const [places, sittables, districtsDoc] = await Promise.all([
          get<ScoutPlace[]>("/assets/city3-places.json"),
          get<Sittable[]>("/assets/city3-anchors.json"),
          get<{ districts: ScoutDistrict[] }>("/assets/districts.json"),
        ]);
        if (!live) return;
        data.current = { places, sittables, districts: districtsDoc.districts };
        exec.current = new ScoutExecutor({
          places,
          sittables,
          cancel: () => { door?.cancel(actorId); interact?.cancel(actorId); },
          plan: (s, target) => {
            const y = world.groundY(target[0], target[1], s.y + WALK_CONFIG.stepUp + .05);
            if (y === null) return null;
            const route = planRoute(planningWorld, [s.x,s.y,s.z], [target[0],y,target[1]], {halfExtent:128,cellSize:1,maxExpansions:10000});
            return route.status === "found" ? route.waypoints.slice(1).map(p => [p[0],p[2]]) : null;
          },
          safe: (s, target) => {
            const y = world.groundY(target[0],target[1],s.y + WALK_CONFIG.stepUp + .05);
            return y !== null && navigationSegment(planningWorld,[s.x,s.y,s.z],[target[0],y,target[1]]);
          },
          avoid: (s, wanted) => {
            const self: ActorBody = {id:actorId,position:[s.x,s.y,s.z],velocity:[Math.sin(s.heading)*wanted.forward*1.3,Math.cos(s.heading)*wanted.forward*1.3],radius:.4,height:1.7,updatedAtMs:performance.now()};
            return avoidActorInput(self, visibleMovers(), wanted);
          },
          claim: async (eggId, at) => {
            const token = agentToken.current;
            if (!token) throw new Error("no agent token");
            const r = await fetch(`${BASE}/eggs/${encodeURIComponent(eggId)}/claim`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
              body: JSON.stringify(at),
              signal: AbortSignal.timeout(5000),
            });
            if (!r.ok) throw new Error(`claim ${r.status}`);
            const body = (await r.json()) as { result: string; payload?: { text: string } };
            interact?.markSpent(eggId);
            return body.result === "claimed" && body.payload ? { text: body.payload.text } : null;
          },
          clips: clips.current!,
          hipsY: BODY_REMY.hipsY,
          door: door
            ? (s, wanted, dt) => door.drive(s, dt, wanted.forward > 0, actorId, scoutChannel.current!)
            : undefined,
          interact: interact
            ? {
                defs: () => interact.list(),
                isOn: (id) => interact.isOn(id),
                request: (id, at) => interact.request(id, actorId, clips.current!, at),
                drive: (s, dt) => interact.drive(s, dt, actorId),
              }
            : undefined,
        });
      } catch (e) {
        console.error("[scout] world data failed to load", e);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  // Leave the wide camera exactly where it was (CityWalker's courtesy).
  useEffect(() => {
    if (!primary) return;
    const p = camera.position.clone();
    const t = controls?.target.clone() ?? null;
    return () => {
      camera.position.copy(p);
      if (t && controls) {
        controls.target.copy(t);
        controls.update?.();
      }
    };
  }, [camera, controls, primary]);

  const snapshot = (): ScoutSnapshot | null => {
    const s = state.current;
    const ex = exec.current;
    const d = data.current;
    if (!s || !ex || !d) return null;
    const np = nearestPlace(d.places, s.x, s.z);
    const room = roomAt(rooms, s.x, s.z);
    const dist = districtAt(d.districts, s.x, s.z);
    return {
      t: ex.t,
      pos: [Math.round(s.x * 100) / 100, Math.round(s.y * 100) / 100, Math.round(s.z * 100) / 100],
      headingDeg: deg(s.heading),
      bodyHeadingDeg: deg(s.body),
      speed: Math.round(s.speed * 100) / 100,
      groundY: Math.round(s.y * 100) / 100,
      district: dist?.name ?? null,
      nearestPlace: np ? { id: np.place.id, name: np.place.name, kind: np.place.kind, dist: Math.round(np.dist * 100) / 100 } : null,
      insideRoom: room?.name ?? null,
      posture: ex.posture,
      clip: clips.current!.current ?? clipFor(s.speed),
      renderedClip: playingClip.current,
      busy: ex.busy,
      currentAction: ex.currentAction?.type ?? null,
      movers: visibleMovers(),
      session: session.current,
      body: { radius: WALK_CONFIG.radius, height: 1.7 },
      route: ex.route,
      looksUsed: looksUsed.current,
      finished: ex.finished,
      worldKind: world.kind(),
    };
  };

  const captureLook = (pitchDeg = 0): ScoutVisionFrame | null => {
    const s = state.current;
    if (!s) return null;
    const rig = lookRig.current ??= new ScoutVision();
    const cam = rig.camera;
    // Use simulation position rather than the render-heartbeat head stream: both modalities and pose share this tick.
    const sn = Math.sin(s.body), cs = Math.cos(s.body);
    const pose = exec.current?.frameOverride();
    cam.position.set((pose?.x ?? s.x) + sn * EYE_FORWARD, (pose?.y ?? s.y) + (pose?.drop ?? 0) + HEAD_HEIGHT, (pose?.z ?? s.z) + cs * EYE_FORWARD);
    // Head pitch (gaze): the look target rises or falls over the 5 m lever; the service turns the BODY to the requested camera heading.
    const pitch = Math.max(-60, Math.min(45, Number.isFinite(pitchDeg) ? pitchDeg : 0)) * Math.PI / 180;
    cam.lookAt(cam.position.x + sn * 5 * Math.cos(pitch), cam.position.y + 5 * Math.sin(pitch), cam.position.z + cs * 5 * Math.cos(pitch));
    // First person: leave out the stand-in AND the streamed copy of this very body (and anything standing in the eye).
    return rig.capture(gl, scene, exec.current?.t ?? 0, [figure.current, ...remoteFiguresNear(cam.position.x, cam.position.z)]);
  };

  // window.__scout — the runner's door in.
  useEffect(() => {
    const api: ScoutApi = {
      ready: () => state.current !== null && exec.current !== null && renderedReady.current,
      /** The Tea House door as Scout sees it (headless checks). */
      door: () => (door ? { phase: door.phase, state: door.state, angle: Math.round(door.angle), owner: door.sessionOwner } : null),
      /** The interactables as Scout sees them (headless checks): its session + every prop's state. */
      interact: () => (interact ? { session: interact.sessionOf(actorId), props: interact.list().map((i) => ({ id: i.id, on: interact.isOn(i.id) })) } : null),
      snapshot: () => snapshot(),
      map: () => {
        const s = state.current;
        return s ? {...sampleNavigationPatch(staticWorld,[s.x,s.y,s.z],{halfExtent:12,cellSize:1,maxExpansions:700}),simulationTime:exec.current?.t ?? 0,session:session.current} : null;
      },
      look: async (opts) => {
        looksUsed.current += 1;
        const s = state.current;
        const d = data.current;
        const sceneObjs =
          s && d
            ? oracleScene(d.places, rooms, { x: s.x, z: s.z, heading: s.body }, {}, (interact?.list() ?? []).map((i) => ({ id: i.id, label: i.label, kind: i.kind, pos: [i.pos[0], i.pos[2]] as [number, number], on: interact!.isOn(i.id) })))
            : [];
        const frame = captureLook(opts?.pitchDeg ?? 0);
        const visible = frame && lookRig.current && s ? sceneObjs.filter(o => {
          if (o.kind === "room" && o.note === "you are inside") return true;
          const angle = s.body + o.bearingDeg * Math.PI / 180;
          const point = new THREE.Vector3(s.x + Math.sin(angle) * o.distance, lookRig.current!.camera.position.y, s.z + Math.cos(angle) * o.distance);
          return pointVisible(point, lookRig.current!.camera, frame.depth);
        }) : [];
        const observed = snapshot();
        const points: [number, number, number][] = s && observed?.route.length ? [
          [s.x, s.y + 0.05, s.z],
          ...observed.route.map(([x, z]): [number, number, number] => [x, (world.groundY(x, z, s.y + 0.45) ?? s.y) + 0.05, z]),
        ] : [];
        return { image: frame?.image ?? null, scene: visible, depth: frame?.depth ?? null, camera: frame?.camera ?? null,
          simulationTime: frame?.simulationTime ?? exec.current?.t ?? 0, snapshot: observed,
          route: frame ? projectRoute(points, frame) : [],
          routeImage: frame && points.length > 1 ? await renderRouteOverlay(frame, points) : null };
      },
      act: async (action) => {
        const ex = exec.current;
        const s = state.current;
        if (!ex || !s) return null;
        if (action.type === "say") {
          console.info(`[scout-say] ${action.text}`);
          const text = cleanSpeech(action.text);
          speech.current = text ? { text, at: ex.t } : null;
        }
        const pending = ex.submit(action, s);
        if (action.type === "play") invalidate();
        const outcome = await pending;
        // A prop the agent chose to use (on or off) is not auto-activated again until it walks away and back.
        if (action.type === "interact" && outcome.target) autoSpent.current.add(outcome.target);
        return { ...outcome, snapshot: snapshot() };
      },
      places: () => data.current?.places ?? [],
      sittables: () => data.current?.sittables ?? [],
      setAgentToken: (token) => { agentToken.current = token; },
    };
    const w = window as unknown as Record<string, unknown>;
    const key = primary ? "__scout" : "__scoutPeer";
    w[key] = api;
    return () => {
      if (w[key] === api) delete w[key];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rooms, world]);

  // The sim driver: spawn + executor ticks on a wall-clock interval (see
  // the header note). Substeps keep walker.step at its tuned dt. The
  // Canvas runs frameloop="demand" in agent mode: this driver pumps
  // frames fast while the world loads, then settles to a 1 s heartbeat —
  // enough to keep InteriorStreamer planning around Scout (its load
  // radius is 140 m) without letting SwiftShader's ~0.5 s frames starve
  // the sim.
  const autoSpent = useRef(new Set<string>());
  const agentToken = useRef<string | null>(null);
  const speech = useRef<SpeechState>(null);
  const labelPose = useRef<{ x: number; y: number; z: number } | null>(null);
  useEffect(() => {
    let last = performance.now();
    let ticks = 0;
    const id = window.setInterval(() => {
      ticks += 1;
      const ready = state.current !== null && exec.current !== null && renderedReady.current;
      if (!ready || ticks % 10 === 0 || exec.current?.currentAction?.type === "play") invalidate();
      const ex = exec.current;
      if (!ex || world.kind() === "pending") return;
      let s = state.current;
      if (!s) {
        const sp = findSpawn(world, spawn ? { cx: spawn[0], cz: spawn[1], maxR: 3 } : undefined);
        if (!sp) return;
        s = state.current = makeWalker(sp.x, sp.y, sp.z, spawn?.[2] ?? 0);
      }
      const now = performance.now();
      let dt = Math.min((now - last) / 1000, 0.3);
      last = now;
      while (dt > 0) {
        const stepDt = Math.min(dt, 1 / 30);
        interact?.observe(actorId, s.x, s.z);
        if (interact && !ex.busy && !ex.finished && ex.posture === "standing") {
          const near = autoActivateTarget(interact.list().filter((d) => !interact.isOn(d.id)), { x: s.x, z: s.z, heading: s.body }, autoSpent.current);
          if (near) void ex.submit({ type: "interact", target: near }, s);
        }
        ex.tick(stepDt, s, world);
        const action = ex.currentAction;
        walk?.actors.publishWalker(actorId, s, WALK_CONFIG.radius, 1.7, true,
          action?.type === "play" && playingClip.current === action.clip ? action.clip : undefined);
        if (positionRef) positionRef.current = { x: s.x, z: s.z };
        if (primary) door?.tick(stepDt); // agent mode: the door runs on Scout's sim clock (GlbWorld's frame ticker is off)
        if (primary) interact?.tick(stepDt); // same for the interactables (InteractTicker is off in agent mode)
        dt -= stepDt;
      }
    }, 100);
    return () => { window.clearInterval(id); walk?.actors.remove(actorId); };
  }, [world, invalidate]);

  useFrame(() => {
    const ex = exec.current;
    const s = state.current;
    if (!ex || !s) return;

    // Figure transform: the walker state, or the executor's seat override.
    const ov = ex.frameOverride();
    const f = writeWalkerFrame(frames.current[0], s, ov);
    const fx = f.position[0];
    const fz = f.position[1];
    if (figure.current) figure.current.position.y = ov ? ov.y + ov.drop : s.y;
    labelPose.current = { x: fx, y: ov ? ov.y : s.y, z: fz };

    if (!primary) return;
    // Streaming + theme follow Scout; the follow camera keeps interiors
    // resident around it (InteriorStreamer plans off the camera).
    controls?.target.set(fx, (ov ? ov.y : s.y) + 1, fz);
    const dt = 1 / 30; // nominal frame dt for the camera damp (cosmetic)
    if (!camPos.current) camPos.current = camera.position.clone();
    const sn = Math.sin(s.heading);
    const cs = Math.cos(s.heading);
    const baseY = ov ? ov.y : s.y;
    camPos.current.set(
      damp(camPos.current.x, fx - sn * 6.5, 8, dt),
      damp(camPos.current.y, baseY + 3.1, 8, dt),
      damp(camPos.current.z, fz - cs * 6.5, 8, dt),
    );
    camera.position.copy(camPos.current);
    camera.lookAt(fx, baseY + 1.1, fz);
  }, -1);

  return (
    <>
    <AgentLabel name={label ?? (actorId === SCOUT_ACTOR ? "Scout" : actorId)} getPose={() => labelPose.current} speech={speech} clock={() => exec.current?.t ?? 0} />
    <group ref={figure}>
      <Suspense fallback={null}>
        <CastFigure
          framesRef={frames}
          index={0}
          baseY={0}
          home={[0, 0, 0]}
          body={BODY_REMY}
          clipTester={clips.current ?? undefined}
          headPoseRef={headPose}
          playingClipRef={playingClip}
          renderedReadyRef={renderedReady}
        />
      </Suspense>
    </group>
    </>
  );
}
