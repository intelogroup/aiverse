import { assetUrl } from "../../lib/assetUrl";
import { TeaElevator, TeaElevatorHud } from "./TeaElevatorView";
import { TeaElevatorController } from "./teaElevator";
import { VerseRecorder } from "./VerseRecorder";
import { VerseShare } from "./VerseShare";
import { ToyProps } from "./ToyProps";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { DistrictWorld } from "./DistrictWorld";
import { SplatTrial } from "./SplatTrial";
import { TILES, CORE_TILE_URL } from "./tilesMode";
import { coreTexturesPending, subscribeCoreTextures, CORE_TEXTURES_HOLD_MS } from "./coreTextures";
import { BazaarLife, type BazaarFigureTap } from "./BazaarLife";
import { VillaEstate } from "./VillaEstate";
import { MiraResident } from "./MiraResident";
import { mobileShell, spawnRequestForPoint, spawnRequestForRoom, type WalkSpawnRequest } from "./mobileShell";
import { TeaBartender } from "./TeaBartender";
import { BARTENDER_LINES } from "./bartender";
import { CityWalker } from "./CityWalker";
import { TouchWalkSource, setLookPrefs } from "./walkTouch";
import { InteractHighlight, TouchTapPicker, TouchWalkLayer, useTouchUi, type TapPicker } from "./TouchWalkLayer";
import { ScoutAgent } from "./ScoutAgent";
import { RemoteCast } from "./RemoteCast";
import { OwnerFollowCam } from "./OwnerFollowCam";
import { CameraFocus } from "./CameraFocus";
import { pickOwnBody, type RosterBody } from "./ownerFollow";
import { RemoteBodies } from "./remoteFrames";
import { hudBridge } from "./hud/hudBridge";
import { WalkClipOverride, type WalkFrameInfo } from "./walkOverride";
import { SoundDirector } from "./soundDirector";
import { VOICE_BARTENDER, benchPhonon, phononWarmth, synthLine, warmPhonon } from "./phononTts";
import { GREETING_SCRIPT, createPlazaGreeting, type PlazaGreeting } from "./plazaTts";
import { type CameraMode } from "./cameraRig";
import { attachWorldRenderer } from "../../lib/telemetry/index";
import { FpsMeter } from "./fpsMeter";
import { PerfOverlay, PerfProbe, rumAllowed } from "./PerfProbe";
import { noLimitsActive, TOUCH_DPR_MAX, capDpr, dprForTier, qualityStore } from "./quality";
import { attachContextLossHandlers } from "./contextLoss";
import { probeWebGLSupport } from "./contextCreate";
import { LONG_PRESS_MAX_MOVE_PX, LONG_PRESS_MS, coachSeen, comfortStore, hapticTick, markCoachSeen } from "./comfort";
import { CITY3_LIBRARY_URL } from "./city3";
import { boxesMesh } from "./capsuleWorld";
import { WalkColliders } from "./walkColliders";
import { TEA_BLOCKER_BOX, TeaDoorController } from "./teaDoor";
import { InteractController } from "./interactables";
import { InteractTicker } from "./InteractTicker";
import { HouseDoors } from "./HouseDoorLeaf";
import { TeaDoorLeaf, TeaDoorTicker } from "./TeaDoorLeaf";
import { TEA_FLOORS } from "./teaBuilding";
import { ClipCutaway, InteriorStreamer, useCity3Rooms } from "./glbInteriors";
import { KeyLight, ShadowTagger, StageEnvironment, InteriorLightRig, interiorLookWanted } from "./glbStage";
import { PostFx, postFxWanted } from "./postFx";
import { FpsTracker, QualityDriver, TouchFpsCap } from "./glbPerf";
import { PresentedSignal, ShellPaBanner, WalkHudPanel, WorldLoadOverlay, soundDebugSurface } from "./glbHud";
import { FigureFlyRig } from "./glbCamera";
import { CITY3_CENTER } from "./glbConstants";

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

const CITY3_URL = assetUrl(TILES ? CORE_TILE_URL : "/assets/world-city3.glb"); // tile mode: the small core first, the rest streams (tilesMode.ts)

function useCoreTexturesReady(mounted: boolean): boolean {
  const [pending, setPending] = useState(coreTexturesPending);
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const sync = () => setPending(coreTexturesPending());
    sync();
    return subscribeCoreTextures(sync);
  }, []);
  useEffect(() => {
    if (!mounted) return;
    const id = setTimeout(() => setExpired(true), CORE_TEXTURES_HOLD_MS);
    return () => clearTimeout(id);
  }, [mounted]);
  return mounted && (!pending || expired);
}

/** ?spawn=x,z[,faceX,faceZ] — QA/debug drop point for the walker (screenshot one interior without walking there). */
function spawnFromUrl(): WalkSpawnRequest | null {
  const raw = new URLSearchParams(window.location.search).get("spawn");
  if (!raw) return null;
  const [x, z, fx, fz] = raw.split(",").map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return { x, z, faceX: Number.isFinite(fx) ? fx : x, faceZ: Number.isFinite(fz) ? fz : z - 2 };
}

export function GlbWorld({ ownerAgentNames, hud = false }: { /** Names of the signed-in owner's agents (empty for a visitor). With one in the world, the camera lands on it. */ ownerAgentNames?: readonly string[]; /** Field HUD on: publish to hudBridge and hide the chrome the HUD replaces. */ hud?: boolean } = {}) {
  // City 3 is the only world: the Agora was deleted 2026-11-08 (Jim's
  // order — a planned lobby will bring back world navigation later).
  // Any ?world= value, stale or current, lands here.
  // Walk-mode HUD (City 3): one shared override state — the panel's
  // Run/door buttons drive it, the walk bot's CastFigure consumes it as
  // its clip tester. Plus the walker's latest frame for the status line.
  const [miraVisitNonce] = useState(0); // the "Meet Mira" shortcut was removed; Mira still lives in the Tea House
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
  // QA hook: ?spawn=x,z[,faceX,faceZ] drops the walker at a point on its first spawn. Initialised in the ref's
  // constructor, not an effect: CityWalker is a child, so its effects run BEFORE this component's and would consume
  // an empty ref and spawn at the plaza.
  const walkSpawnRef = useRef<WalkSpawnRequest | null>(spawnFromUrl());
  const figureFlyRef = useRef<{ x: number; z: number } | null>(null);
  const [figureCard, setFigureCard] = useState<BazaarFigureTap | null>(null);
  const walkToPoint = (x: number, z: number) => {
    walkSpawnRef.current = spawnRequestForPoint(x, z);
    setFigureCard(null);
    setCamMode("ride");
  };
  // Render-rate meter: FpsTracker (in-Canvas) writes, the panel reads.
  // ?perf=1: the on-device freeze recorder (PerfProbe.tsx). Off for everyone else; no per-frame cost when off.
  // `?nolimits=1`: diagnostic mode. Touch devices run like desktop: no
  // 30 fps cap, DPR up to 2, no quality governor (tier stays "full",
  // 2048 shadows). To see what the hardware can really do; it can crash
  // or overheat a weak phone, so it is never the default.
  const noLimits = useMemo(() => noLimitsActive(), []);
  useEffect(() => {
    if (noLimits) qualityStore.pinFullForSession();
  }, [noLimits]);
  const perfOn = useMemo(() => new URLSearchParams(window.location.search).get("perf") === "1", []);
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
  const agentMode = useMemo(() => new URLSearchParams(window.location.search).get("agent"), []);
  const agentPair = agentMode === "pair";
  const agentOn = agentMode === "1" || agentPair;
  // Field performance report (PerfProbe.flushRum): once per visit, sampled, to Sentry. Never on the look service page or automation.
  const rumOn = useMemo(() => rumAllowed(agentOn), [agentOn]);
  // Server-driven agents (apps/sim) streamed over the public feed. Off unless asked: VITE_WORLD_STREAM=1 for a build, ?stream=1 per visit
  //. The ambient VITE_WORLD_STREAM default never combines with the local Scout (a second copy of that figure); only an explicit ?stream=1 does.
  const streamParam = useMemo(() => new URLSearchParams(window.location.search).get("stream"), []);
  // An explicit ?stream=1 wins even with ?agent=1: the look service's page is `?agent=1` (its scout is a stand-in head-cam, not an
  // agent in the world), and its photos must show the server-driven bodies standing in front of the camera.
  // An owner with agents always gets the stream (nothing to land on otherwise); visitors keep the flag-only default.
  const ownerKey = (ownerAgentNames ?? []).join("\u0000");
  const ownerNames = useMemo(() => (ownerKey ? ownerKey.split("\u0000") : []), [ownerKey]);
  const streamOn = streamParam === "1" || (!agentOn && streamParam !== "0" && (import.meta.env.VITE_WORLD_STREAM === "1" || ownerNames.length > 0));
  // The stream's state lives here (RemoteCast draws from it, OwnerFollowCam reads it) so the owner's body can be found by name.
  const remoteBodies = useMemo(() => new RemoteBodies(), []);
  const [ownBody, setOwnBody] = useState<RosterBody | null>(null);
  // The owned agent picked from the HUD party list; null (or gone from the stream) falls back to the newest.
  const [followName, setFollowName] = useState<string | null>(null);
  useEffect(() => {
    if (!streamOn || ownerNames.length === 0) {
      setOwnBody(null);
      return;
    }
    const look = () => {
      const bodies = remoteBodies.list();
      const picked = followName && ownerNames.includes(followName) ? pickOwnBody(bodies, [followName]) : null;
      const b = picked ?? pickOwnBody(bodies, ownerNames);
      setOwnBody((prev) => (prev?.n === b?.n && prev?.name === b?.name ? prev : b));
    };
    look();
    const id = window.setInterval(look, 400);
    return () => window.clearInterval(id);
  }, [streamOn, ownerNames, remoteBodies, followName]);
  // Follow the owner's agent (third person). Lands there once per visit, unless the user already moved the camera or came by a
  // walk/agent deep link; any drag/pinch/wheel on the world hands the camera back (OwnerFollowCam fires onTakeOver).
  const [following, setFollowing] = useState(false);
  const followAuto = useRef(true);
  const takeOver = useCallback(() => setFollowing(false), []);
  // Full view: hides the app chrome (header, tab bar, tips) and asks the browser for real fullscreen where it exists (not iPhone
  // Safari, which has no Fullscreen API for pages: there the chrome-less view is what you get). Esc / the button leaves.
  const [fullView, setFullView] = useState(false);
  useEffect(() => {
    const appRoot = rootRef.current?.closest(".world-root") as HTMLElement | null;
    appRoot?.classList.toggle("w-immersive", fullView);
    if (fullView && appRoot?.requestFullscreen && !document.fullscreenElement) void appRoot.requestFullscreen().catch(() => {});
    if (!fullView && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    return () => appRoot?.classList.remove("w-immersive");
  }, [fullView]);
  useEffect(() => {
    const onFs = () => { if (!document.fullscreenElement) setFullView(false); };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
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
  const focusRef = useRef<{ x: number; z: number } | null>(null);
  const setFocus = useCallback((p: { x: number; z: number }) => { focusRef.current = p; }, []);
  const plates = useMemo(() => new Set(ownerNames), [ownerNames]);
  useEffect(() => {
    if (!hud) return;
    return hudBridge.register({
      follow: (name) => {
        followAuto.current = false;
        setFollowName(name);
        setCamMode("wide");
        setFollowing(true);
      },
      toggleFollow: () => {
        followAuto.current = false;
        setFollowing((f) => !f);
      },
      walk: () => setCamMode("ride"),
      bodies: () => {
        const t = remoteBodies.renderTime(performance.now() / 1000);
        if (t === null) return [];
        return remoteBodies.list().flatMap((b) => {
          const p = remoteBodies.sample(b.n, t);
          return p ? [{ name: b.name, x: p.x, z: p.z }] : [];
        });
      },
      focus: () => focusRef.current,
      root: rootRef,
    });
  }, [hud, remoteBodies]);
  useEffect(() => {
    if (!hud) return;
    const publish = () =>
      hudBridge.publish({
        walking,
        following,
        followName: ownBody?.name ?? null,
        present: remoteBodies.list().map((b) => b.name),
        says: remoteBodies.says,
      });
    publish();
    const id = window.setInterval(publish, 400);
    return () => window.clearInterval(id);
  }, [hud, walking, following, ownBody, remoteBodies]);
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
  // WebGL context loss: the recovery overlay's state. The Canvas is
  // keyed by loadNonce, so a reload remounts a fresh canvas and the
  // flag resets with the generation (same effect as `presented`); a
  // browser-side restore clears it via the contextrestored handler
  // attached in onCreated.
  const [contextLost, setContextLost] = useState(false);
  useEffect(() => {
    setWorldPresented(false);
    setContextLost(false);
  }, [loadNonce]);
  // Context CREATION (contextCreate.ts): probe before the Canvas
  // mounts. When the browser refuses a WebGL context outright, the
  // Canvas can never present and the load overlay would spin
  // forever; the probe turns that dead end into the graphics
  // fallback overlay below. Keyed by loadNonce so the overlay's
  // reload action re-probes on the fresh generation.
  const glSupported = useMemo(() => {
    void loadNonce; // the dependency IS the re-probe trigger (see above)
    return probeWebGLSupport();
  }, [loadNonce]);
  const contextLossDetachRef = useRef<(() => void) | null>(null);
  const markPresented = useCallback(() => setWorldPresented(true), []);
  const worldTextured = useCoreTexturesReady(worldPresented);
  // Land on the owner's agent: engage once the world is on screen and the body is in the stream. Never over a deep link, a walk
  // mode, a hero fly-to, or a camera the user already touched. Losing the body (visit ended) drops back to the spectator camera
  // where it stands; heroFocus (a UI fly-to) also ends it.
  useEffect(() => {
    if (!ownBody) {
      setFollowing(false);
      return;
    }
    if (followAuto.current && worldPresented && !walkLink && !agentOn && camMode === "wide" && !heroFocus) {
      followAuto.current = false;
      setFollowing(true);
    }
  }, [ownBody, worldPresented, walkLink, agentOn, camMode, heroFocus]);
  useEffect(() => {
    if (heroFocus || camMode !== "wide") setFollowing(false);
  }, [heroFocus, camMode]);
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
  // Orbit pivot just in front of the fountain tower (core tile: a solid 6.4 m column on CITY3_CENTER, 0-45 m tall), on
  // the side the opening camera looks from. A pivot inside the tower pinned the camera to its inner wall (CameraCollider)
  // and made close orbits start inside it. 9 m out keeps the opening aerial composition unchanged.
  const target: [number, number, number] = [CITY3_CENTER[0] + 5.8, 8, CITY3_CENTER[1] + 6.8];

  return (
    <div
      ref={rootRef}
      className={touchUi ? "w-glb-root w-touch-root" : "w-glb-root"}
      // A touch on the world itself means the user is steering: never auto-land on their agent afterwards.
      onPointerDownCapture={(e) => { if (e.target instanceof HTMLCanvasElement) followAuto.current = false; }}
      onWheelCapture={(e) => { if (e.target instanceof HTMLCanvasElement) followAuto.current = false; }}
    >
      {!hud && ownBody && !agentOn && !walking ? (
        <button
          type="button"
          className={following ? "w-follow-chip active" : "w-follow-chip"}
          data-testid="follow-chip"
          onClick={() => { followAuto.current = false; setFollowing((f) => !f); }}
        >
          {following ? `Following ${ownBody.name} · drag to explore` : `Follow ${ownBody.name}`}
        </button>
      ) : null}
      {/* One stack, top-right: Share and Record no longer sit on top of each other or the phone tab bar. */}
      {hud ? null : (
        <div className="w-tools">
          <VerseRecorder root={rootRef} />
          <VerseShare root={rootRef} />
          <button type="button" className="w-fullview-btn" data-testid="full-view" onClick={() => setFullView((v) => !v)}>
            {fullView ? "Exit full view" : "Full view"}
          </button>
        </div>
      )}
      {perfOn ? <PerfOverlay /> : null}
      <TeaElevatorHud controller={elevator} frame={walkFrameRef} walking={walking} walk={walkColliders} />
      {glSupported ? (
      <Canvas
        key={`world-${loadNonce}`}
        camera={camera}
        dpr={touchUi && !noLimits ? capDpr(dprForTier(quality.tier), TOUCH_DPR_MAX) : [1, 2]}
        frameloop={agentOn ? "demand" : "always"}
        shadows={agentOn ? false : "soft"}
        gl={{ antialias: true }}
        onCreated={({ gl, camera }) => {
          // VoiceOver pass (Phase 4): the canvas is the world's window;
          // name it for assistive tech.
          gl.domElement.setAttribute("aria-label", "3D world view");
          // Telemetry Phase 1: camera context + WebGL loss/shader hooks.
          attachWorldRenderer(gl, camera);
          // Recovery (2026-11-12): telemetry records a context loss,
          // this makes it survivable — preventDefault keeps restore
          // possible, the overlay offers a remount when it isn't.
          contextLossDetachRef.current?.();
          contextLossDetachRef.current = attachContextLossHandlers(gl.domElement, {
            onLost: () => setContextLost(true),
            onRestored: () => setContextLost(false),
          });
        }}
        style={{ position: "absolute", inset: 0 }}
      >
        <ambientLight intensity={0.12} color="#8fa3cc" />
        <StageEnvironment />
        <KeyLight lightRef={keyLightRef} />
        <ShadowTagger />
        {!touchUi && !agentOn && postFxWanted(window.location.search) ? <PostFx /> : null}
        {touchUi ? <FpsTracker meterRef={fpsMeterRef} /> : null}
        {touchUi && !noLimits ? <QualityDriver meterRef={fpsMeterRef} /> : null}
        {touchUi && !agentOn && !noLimits ? <TouchFpsCap /> : null}
        <Suspense fallback={null}>
          <PresentedSignal onPresented={markPresented} />
          <DistrictWorld residentUrl={CITY3_URL} light={keyLightRef} collide={camMode === "wide" && !following && !(heroFocus?.id === "tea" && teaFloor === null)} meshesRef={colliderMeshesRef} walk={walkColliders} streamCap={touchUi ? 2 : undefined} interact={interactRef.current ?? undefined} />
          {/* Splat-in-verse trial: renders nothing unless ?splat=1|1m (see SplatTrial.tsx). */}
          <SplatTrial />
          <>
              <TeaElevator controller={elevator} walk={walkColliders} url={CITY3_URL} frame={walkFrameRef} getDirector={() => soundRef.current} />
              <ClipCutaway rooms={city3Rooms} focus={heroFocus} teaFloor={teaFloor} walking={walking} />
              <InteriorStreamer rooms={city3Rooms} walk={walkColliders} interact={interactRef.current} />
              <HouseDoors rooms={city3Rooms} walk={walkColliders} frame={walkFrameRef} walking={walking} />
              <TeaDoorLeaf controller={teaDoorRef.current} />
              {!agentOn ? <TeaDoorTicker controller={teaDoorRef.current} /> : null}
              {!agentOn ? <InteractTicker controller={interactRef.current} /> : null}
          </>
        </Suspense>
        {/* Figures stream in on their own boundaries: a character model (animation-heavy, parsed on the main thread) must not hold the whole world back. */}
        <Suspense fallback={null}>
          <>
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
              <VillaEstate />
              <MiraResident walk={walkColliders} visitNonce={miraVisitNonce} />
          </>
        </Suspense>
        <Suspense fallback={null}>
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
          {interactRef.current ? <ToyProps interact={interactRef.current} /> : null}
        </Suspense>
        <Suspense fallback={null}>
          {agentOn ? (
            <ScoutAgent getMeshes={getColliderMeshes} walk={walkColliders} rooms={city3Rooms} door={teaDoorRef.current} positionRef={scoutPosRef} interact={interactRef.current} spawn={agentPair ? [-22.9, -68, 0] : undefined} />
          ) : null}
          {streamOn ? <RemoteCast walk={walkColliders} bodies={remoteBodies} plates={hud && !agentOn ? plates : undefined} /> : null}
          {hud ? <CameraFocus onFocus={setFocus} /> : null}
          {following && ownBody ? <OwnerFollowCam key={ownBody.n} bodies={remoteBodies} n={ownBody.n} onTakeOver={takeOver} /> : null}
          {agentPair ? (
            <ScoutAgent actorId="scout-peer" primary={false} spawn={[-22.9, -64, Math.PI]}
              getMeshes={getColliderMeshes} walk={walkColliders} rooms={city3Rooms} door={teaDoorRef.current} interact={interactRef.current} />
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
        {perfOn || rumOn ? <PerfProbe rum={rumOn} /> : null}
        {/* After DistrictWorld (above) so its useFrame runs after the 0.25 s theme tick and the
            interior profile wins while the player is inside a room. Writes nothing outdoors. */}
        <InteriorLightRig lightRef={keyLightRef} rooms={city3Rooms} enabled={interiorLookWanted(window.location.search)} posRef={botPosRef} />
      </Canvas>
      ) : null}
      {soundRef.current ? (
        <ShellPaBanner sound={soundRef.current} spectator={!walking} />
      ) : null}
      {glSupported ? (
        <WorldLoadOverlay
          key={`loading-${loadNonce}`}
          presented={worldTextured}
          onRetry={() => {
            useGLTF.clear(CITY3_URL);
            useGLTF.clear(CITY3_LIBRARY_URL);
            setLoadNonce((n) => n + 1);
          }}
        />
      ) : null}
      {contextLost ? (
        <div className="w-load" role="alert" aria-live="assertive">
          <div className="w-load-card">
            <div className="w-load-eyebrow">Graphics interrupted</div>
            <div className="w-load-title">The graphics context was lost</div>
            <p className="w-load-sub">
              Your device dropped the 3D view — this can happen under memory or heat
              pressure. The world is still here; reload it to keep going.
            </p>
            <div className="w-load-actions">
              <button
                type="button"
                className="w-load-primary"
                onClick={() => {
                  useGLTF.clear(CITY3_URL);
                  useGLTF.clear(CITY3_LIBRARY_URL);
                  setLoadNonce((n) => n + 1);
                }}
              >
                Reload the world
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {!glSupported ? (
        <div className="w-load" role="alert" aria-live="assertive">
          <div className="w-load-card">
            <div className="w-load-eyebrow">Graphics unavailable</div>
            <div className="w-load-title">Graphics couldn’t start on this device</div>
            <p className="w-load-sub">
              The verse needs WebGL to draw its 3D world, and this browser couldn’t
              create a graphics context. Reloading can clear a temporary failure;
              if it keeps happening, a different browser or device will get you in.
            </p>
            <div className="w-load-actions">
              <button
                type="button"
                className="w-load-primary"
                onClick={() => {
                  useGLTF.clear(CITY3_URL);
                  useGLTF.clear(CITY3_LIBRARY_URL);
                  setLoadNonce((n) => n + 1);
                }}
              >
                Reload the world
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {!(walking && touchUi) && !(hud && !walking) ? (
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
