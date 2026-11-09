import { useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useRef } from "react";
import * as THREE from "three";
import { CastFigure } from "./CastFigure";
import { BODY_SUMMER } from "./bodies";
import type { WalkColliders } from "./walkColliders";
import { newWalkerFrame, useWalkWorld, writeWalkerFrame } from "./walkerBody";
import { followAvatarVisible, resolveDistance, stepDistance } from "./cameraCollision";
import { CameraClearance } from "./cameraClearance";
import { DAMP_FOV, DAMP_POS_FOLLOW, FOV_RIDE, FOV_WIDE, EYE_FORWARD, FOLLOW_BACK, FOLLOW_LOOK_UP, FOLLOW_UP, HEAD_HEIGHT, RIDE_LOOK_AHEAD, damp } from "./cameraRig";
import type { AgentFrame } from "./locomotion";
import { findSpawn, makeWalker, step, type WalkInput } from "./walker";
import { WalkClipOverride, type WalkFrameInfo } from "./walkOverride";
import { mergeTouchIntent, type TouchWalkSource } from "./walkTouch";
import type { WalkSpawnRequest } from "./mobileShell";
import { isReducedMotion } from "./comfort";
import { PLAYER, type TeaDoorController } from "./teaDoor";
import type { InteractController } from "./interactables";

// CityWalker — the user-driven bot in City 3 (?world=city3&walk=1). A thin adapter around walker.ts:
//   keyboard/mouse -> abstract intent {forward, strafe, turn, run, look} -> walker.step(world = BVH raycasts)
//   -> AgentFrame for the existing "summer" CastFigure (walk/idle clip from speed) -> ride/follow camera.
// An agent would feed the same `step` with its own intents instead of the keys read here.

export type WalkMode = "ride" | "follow";

const MOUSE_SENS = 0.0022;
const PITCH_MAX = 1.25;
const WALK_NEAR = 0.1;

type Held = { fwd: boolean; back: boolean; left: boolean; right: boolean; tl: boolean; tr: boolean; run: boolean };
const noKeys = (): Held => ({ fwd: false, back: false, left: false, right: false, tl: false, tr: false, run: false });

/** Keys -> intent. The only place the keyboard exists. */
export function intentFromKeys(k: Held, look: number): WalkInput {
  return {
    forward: (k.fwd ? 1 : 0) - (k.back ? 1 : 0),
    strafe: (k.right ? 1 : 0) - (k.left ? 1 : 0),
    turn: (k.tr ? 1 : 0) - (k.tl ? 1 : 0),
    run: k.run,
    look,
  };
}

export function CityWalker({
  mode,
  onMode,
  onExit,
  onPosition,
  getMeshes,
  walk,
  override,
  frameRef,
  door,
  interact,
  touch,
  spawnRef,
}: {
  mode: WalkMode;
  onMode: (m: WalkMode) => void;
  onExit: () => void;
  /** Latest bot position each stepped frame (BazaarLife's keeper trigger reads it). */
  onPosition?: (x: number, z: number, y: number) => void;
  /** Visual/camera meshes: the follow-cam wall ray, and the raycast fallback world if the collision GLB failed to load. */
  getMeshes: () => THREE.Mesh[];
  /** The walker's collision list (capsule world). Without it (tests, older hosts) the raycast world over `getMeshes` is used. */
  walk?: WalkColliders;
  /**
   * HUD clip override (walkOverride.ts), shared with the walk HUD panel: the figure consumes it as its
   * clip tester (the Embody panel's clip-firing path) and the frame loop stands the bot still while a
   * door one-shot plays. Absent (tests, older hosts) the walker keeps a private one.
   */
  override?: WalkClipOverride;
  /** The latest frame's locomotion state + speed, written per frame for the HUD status line. */
  frameRef?: { current: WalkFrameInfo | null };
  /**
   * Tea House door pilot (teaDoor.ts): while a door session runs, the
   * controller's drive() replaces the key input (align, stand for the
   * performance, step through); it is consulted every frame so the
   * door machine and its blocker stay current. Absent = no door.
   */
  door?: TeaDoorController;
  /**
   * Usable props (interactables.ts): E uses the nearest one within reach; while its session runs, drive() replaces the key
   * input (walk to the stand pose, face it, the Interact clip). Consulted every frame so the controller sees the player.
   */
  interact?: InteractController;
  /**
   * Mobile Phase 1: the DOM touch layer's intent source (walkTouch.ts),
   * merged into the key intent at the same seam and its look deltas
   * folded into lookAcc/pitch exactly where the mouse feeds them.
   * Absent on the desktop path — nothing changes there, bit for bit.
   */
  touch?: TouchWalkSource;
  /**
   * Mobile Phase 2: a pending "Walk there" spawn request (mobileShell.ts).
   * Consumed once, at the first spawn: findSpawn probes around the
   * request's centre instead of the plaza, and the bot spawns facing
   * the request's face point (a room's door, a figure). Absent or
   * already consumed, the plaza spawn stands.
   */
  spawnRef?: { current: WalkSpawnRequest | null };
}) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update?: () => void } | null;
  // Capsule shapecast over the collision GLBs; the old raycast world over the visual meshes only if collision failed to load.
  const world = useWalkWorld(getMeshes, walk);

  const state = useRef<ReturnType<typeof makeWalker> | null>(null);
  const pitch = useRef(0);
  const keys = useRef<Held>(noKeys());
  const testIntent = useRef<WalkInput | null>(null);
  const lookAcc = useRef(0);
  const frames = useRef<AgentFrame[]>([newWalkerFrame()]);
  const figure = useRef<THREE.Group>(null);
  const rig = useRef<{ mode: WalkMode; y: number; pos: THREE.Vector3; look: THREE.Vector3; shown: number } | null>(null);
  const clearance = useRef(new CameraClearance());
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const cbs = useRef({ onMode, onExit, onPosition });
  cbs.current = { onMode, onExit, onPosition };
  // The clip override the figure + HUD share (see the prop): a private
  // instance only when the host did not hand one in.
  const ownOverride = useRef<WalkClipOverride | null>(null);
  if (override === undefined && ownOverride.current === null) ownOverride.current = new WalkClipOverride();
  const clipOverride = override ?? (ownOverride.current as WalkClipOverride);
  const interactRef = useRef(interact);
  interactRef.current = interact;

  useEffect(() => () => { if(state.current) walk?.elevator?.forget(state.current); if(walk?.elevator){walk.elevator.panelOpen=false;walk.elevator.held=false;} }, [walk]);

  // Leave the wide camera exactly where it was.
  useEffect(() => {
    const p = camera.position.clone();
    const { fov, near } = camera;
    const t = controls?.target.clone() ?? null;
    return () => {
      camera.position.copy(p);
      camera.fov = fov;
      camera.near = near;
      camera.updateProjectionMatrix();
      if (t && controls) {
        controls.target.copy(t);
        controls.update?.();
      }
    };
  }, [camera, controls]);

  // Keyboard + mouse-look (pointer lock). Esc / losing the lock leaves walk mode.
  useEffect(() => {
    const canvas = gl.domElement;
    const typing = (e: Event) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    };
    const set = (code: string, down: boolean): boolean => {
      const k = keys.current;
      switch (code) {
        case "KeyW": case "ArrowUp": k.fwd = down; return true;
        case "KeyS": case "ArrowDown": k.back = down; return true;
        case "KeyA": k.left = down; return true;
        case "KeyD": k.right = down; return true;
        case "ArrowLeft": k.tl = down; return true;
        case "ArrowRight": k.tr = down; return true;
        case "ShiftLeft": case "ShiftRight": k.run = down; return true;
      }
      return false;
    };
    const onDown = (e: KeyboardEvent) => {
      if (typing(e)) return;
      if (e.code === "Escape") { if (walk?.elevator?.panelOpen) { walk.elevator.panelOpen=false; walk.elevator.held=false; return; } cbs.current.onExit(); return; }
      if (e.code === "KeyV" && !e.repeat) { cbs.current.onMode(modeRef.current === "ride" ? "follow" : "ride"); return; }
      if (e.code === "KeyE" && !e.repeat) {
        const s = state.current;
        const ia = interactRef.current;
        if (s && walk?.elevator && walk.elevator.access(s) !== null) { walk.elevator.panelOpen = !walk.elevator.panelOpen; keys.current=noKeys(); lockedOnce=false; if (document.pointerLockElement===canvas) document.exitPointerLock(); return; }
        if (s && ia) ia.requestNearest(PLAYER, clipOverride, s);
        return;
      }
      if (set(e.code, true)) e.preventDefault();
    };
    const onUp = (e: KeyboardEvent) => { set(e.code, false); };
    const onBlur = () => { keys.current = noKeys(); };
    let lockedOnce = false;
    const locked = () => document.pointerLockElement === canvas;
    const onMove = (e: MouseEvent) => {
      if (!locked()) return;
      lookAcc.current += e.movementX * MOUSE_SENS;
      pitch.current = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, pitch.current - e.movementY * MOUSE_SENS));
    };
    const onPointerDown = () => {
      if (locked()) return;
      if(walk?.elevator) walk.elevator.panelOpen=false;
      try { (canvas.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => {}); } catch { /* denied: keys still work */ }
    };
    const onLockChange = () => {
      if (locked()) lockedOnce = true;
      else if (lockedOnce) cbs.current.onExit(); // Esc while captured releases the lock: that is "leave"
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("pointerlockchange", onLockChange);
    canvas.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("pointerlockchange", onLockChange);
      canvas.removeEventListener("pointerdown", onPointerDown);
      if (locked()) { lockedOnce = false; document.exitPointerLock(); }
    };
  }, [gl, walk]);

  // ?walkDebug=1: drive/inspect from tests.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("walkDebug")) return;
    const w = window as unknown as Record<string, unknown>;
    w.__walk = {
      intent: (input: WalkInput | null) => { testIntent.current=input; },
      elevator: () => walk?.elevator?.snapshot(),
      state: () => (state.current ? { ...state.current, pitch: pitch.current, mode: modeRef.current } : null),
      teleport: (x: number, z: number, heading?: number, fromY = 20) => {
        const g = world.groundY(x, z, fromY);
        if (g === null) return false;
        state.current = makeWalker(x, g, z, heading ?? state.current?.heading ?? 0);
        rig.current = null;
        return true;
      },
      pitch: (p: number) => { pitch.current = p; },
      /** Tea door controller snapshot (phase/state/angle) for headless checks. */
      /** Interactable controller snapshot for headless checks: this actor's session + every prop's state. */
      interact: () => (interact ? { session: interact.sessionOf(PLAYER), props: interact.list().map((d) => ({ id: d.id, on: interact.isOn(d.id) })), clip: clipOverride.current } : null),
      door: () => (door ? { phase: door.phase, state: door.state, angle: door.angle, clip: clipOverride.current, doorPlaying: clipOverride.doorPlaying } : null),
      ground: (x: number, z: number, fromY: number) => world.groundY(x, z, fromY),
      worldKind: () => world.kind(),
      /** Place the walker exactly (no ground lookup). */
      put: (x: number, y: number, z: number, heading = 0) => { state.current = makeWalker(x, y, z, heading); rig.current = null; },
      /**
       * Fixed-dt simulation without rendering: inputs = [forward, strafe, turn, run(0/1), dt][]; returns the trace
       * [x, y, z, speed] per input (flat). The same `step` the frame loop calls.
       */
      script: (inputs: number[][]) => {
        const s = state.current;
        if (!s) return null;
        const out = new Array<number>(inputs.length * 4);
        inputs.forEach(([f, r, t, run, dt], i) => {
          step(s, { forward: f, strafe: r, turn: t, run: run > 0 }, dt, world);
          out[i * 4] = s.x; out[i * 4 + 1] = s.y; out[i * 4 + 2] = s.z; out[i * 4 + 3] = s.speed;
        });
        return out;
      },
    };
    return () => { delete w.__walk; };
  }, [world]);

  useFrame((_, delta) => {
    const meshes = getMeshes();
    if (!meshes.length || world.kind() === "pending") return; // resident world / collision still loading
    let s = state.current;
    if (!s) {
      const req = spawnRef?.current ?? null;
      if (req && spawnRef) spawnRef.current = null;
      const sp = (req ? findSpawn(world, { cx: req.x, cz: req.z }) : null) ?? findSpawn(world);
      if (!sp) return;
      const heading = req ? Math.atan2(req.faceX - sp.x, req.faceZ - sp.z) : 0;
      s = state.current = makeWalker(sp.x, sp.y, sp.z, heading);
    }
    // Mobile Phase 1: touch look deltas join the mouse's accumulators
    // (same signs, same pitch clamp), consumed once per frame.
    if (touch) {
      const tl = touch.consumeLook();
      if (tl.yaw !== 0) lookAcc.current += tl.yaw;
      if (tl.pitch !== 0)
        pitch.current = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, pitch.current + tl.pitch));
    }
    const look = lookAcc.current;
    lookAcc.current = 0;
    let input = testIntent.current ? { ...testIntent.current } : intentFromKeys(keys.current, look);
    // Mobile Phase 1: touch merges AT the intent seam — a down stick
    // owns the move axes, the run latch ORs in, and an idle source
    // returns `input` untouched, so the desktop path is bit-identical.
    input = mergeTouchIntent(input, touch);
    // Tea door session (align / performance / step-through): the
    // controller's input replaces the keys outright. Consulted every
    // frame, session or not, so the door machine ticks.
    if (walk?.elevator?.panelOpen) { input.forward=0; input.strafe=0; }
    const dtc = Math.min(delta, 0.25);
    const interactInput = interact?.drive(s, dtc, PLAYER) ?? null;
    const doorInput = door?.drive(s, dtc, input.forward > 0) ?? null;
    if (interactInput) {
      input = interactInput;
    } else if (doorInput) {
      input = doorInput;
    } else if (clipOverride.doorPlaying) {
      // A door one-shot owns the stage: travel intent is suppressed so the
      // bot stands still for the performance (turning/looking stay live).
      input.forward = 0;
      input.strafe = 0;
    }
    step(s, input, delta, world);
    cbs.current.onPosition?.(s.x, s.z, s.y);

    // Frame for CastFigure (clip from speed) and the figure group's height.
    // Figure faces the BODY heading (turns toward travel; backpedal reverses Walk); cameras below use the VIEW heading.
    const f = writeWalkerFrame(frames.current[0], s);
    if (frameRef) frameRef.current = { state: f.state, speed: f.speed, x: s.x, y: s.y, z: s.z };
    if (figure.current) figure.current.position.y = s.y;

    // Streaming/theme follow the bot, not the (parked) orbit camera.
    controls?.target.set(s.x, s.y + 1, s.z);

    // ---- camera ----
    const dt = Math.min(delta, 0.05);
    let r = rig.current;
    const m = modeRef.current;
    if (!r || r.mode !== m) {
      r = rig.current = { mode: m, y: s.y, pos: new THREE.Vector3(), look: new THREE.Vector3(), shown: FOLLOW_BACK };
      r.pos.copy(camera.position);
      if (camera.near !== WALK_NEAR) { camera.near = WALK_NEAR; camera.updateProjectionMatrix(); }
    }
    const sn = Math.sin(s.heading), cs = Math.cos(s.heading);
    if (m === "ride") {
      r.y = damp(r.y, s.y, 14, dt); // stairs ease instead of popping
      const cp = Math.cos(pitch.current), sp = Math.sin(pitch.current);
      camera.position.set(s.x + sn * EYE_FORWARD, r.y + HEAD_HEIGHT, s.z + cs * EYE_FORWARD);
      camera.lookAt(
        camera.position.x + sn * cp * RIDE_LOOK_AHEAD,
        camera.position.y + sp * RIDE_LOOK_AHEAD,
        camera.position.z + cs * cp * RIDE_LOOK_AHEAD,
      );
    } else {
      r.y = damp(r.y, s.y, DAMP_POS_FOLLOW, dt);
      const tx = s.x, ty = r.y + FOLLOW_LOOK_UP, tz = s.z;
      // Camera behind/above; pitch (mouse up) lowers it, down raises it.
      const want: [number, number, number] = [s.x - sn * FOLLOW_BACK, r.y + FOLLOW_UP - pitch.current * 1.6, s.z - cs * FOLLOW_BACK];
      // Sweep the near-plane footprint. Collision snaps inward; only recovery eases out.
      const from = new THREE.Vector3(tx, ty, tz);
      const d = new THREE.Vector3(want[0] - tx, want[1] - ty, want[2] - tz);
      const len = d.length();
      d.multiplyScalar(1 / len);
      const hit = clearance.current.hitDistance(from, new THREE.Vector3(...want), camera, meshes);
      const allowed = resolveDistance(len, hit, 0.25);
      r.shown = stepDistance(Math.min(r.shown, len), allowed, dt);
      r.pos.copy(from).addScaledVector(d, r.shown);
      camera.position.copy(r.pos);
      r.look.set(tx, ty, tz);
      // A wall can collapse clearance to zero; keep the intended heading when
      // camera and target coincide instead of letting lookAt choose a default axis.
      if (r.shown < 1e-4) r.look.addScaledVector(d, -1);
      camera.lookAt(r.look);
    }
    if (figure.current) {
      figure.current.visible = m === "follow" && followAvatarVisible(figure.current.visible, r.shown);
    }
    const targetFov = m === "ride" ? FOV_RIDE : FOV_WIDE;
    // Mobile Phase 4: under reduced motion there is no FOV kick —
    // the mode's FOV applies at once instead of easing toward it.
    const fov = isReducedMotion() ? targetFov : damp(camera.fov, targetFov, DAMP_FOV, dt);
    if (Math.abs(fov - camera.fov) > 0.001) { camera.fov = fov; camera.updateProjectionMatrix(); }
  }, -1);

  const s0 = state.current;
  return (
    <group ref={figure}>
      <Suspense fallback={null}>
        <CastFigure
          framesRef={frames}
          index={0}
          baseY={0}
          home={[s0?.x ?? 0, 0, s0?.z ?? 0]}
          body={BODY_SUMMER}
          hidden={mode === "ride"}
          clipTester={clipOverride}
        />
      </Suspense>
    </group>
  );
}
