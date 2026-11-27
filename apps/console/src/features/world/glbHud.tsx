// DOM overlays and panels around the stage: the load overlay, the
// shell PA banner, the walk clip HUD and the sound debug surface
// (extracted from GlbWorld.tsx, cleanup L2).
import { useEffect, useState, type RefObject } from "react";
import { useProgress } from "@react-three/drei";
import { WalkClipOverride, type WalkFrameInfo } from "./walkOverride";
import { SoundDirector } from "./soundDirector";
import { PLAYER, TeaDoorController } from "./teaDoor";
import { InteractController } from "./interactables";
import { loadPercent, worldLoadPhase } from "./worldLoad";
import { doorChipClip } from "./walkTouch";

/** Fires once when the Suspense subtree it sits in actually mounts —
 * the "the world is on screen" signal the loading overlay waits for. */
export function PresentedSignal({ onPresented }: { onPresented: () => void }) {
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
export function WorldLoadOverlay({
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
export function ShellPaBanner({
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
export function soundDebugSurface(sound: SoundDirector) {
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
 * Walk-mode panel (City 3, shown while walking, ride and follow
 * alike): the sound consent/mute row, the Tea House door action when in
 * range, and the door / E-prompt status. With `?debug=1` it also shows
 * the test buttons for the clips speed alone cannot reach on the walk
 * bot — the Run loop (the bot's walk pace never crosses the
 * run threshold) and the two door one-shots the door work performs
 * with. The buttons drive a WalkClipOverride (walkOverride.ts); the
 * bot's CastFigure consumes it as its clip tester, the same
 * clip-firing path as the Embody panel's tester below.
 */
export function WalkHudPanel({
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
  const debug = new URLSearchParams(window.location.search).get("debug") === "1";
  // The only desktop way to open the Tea House door: same range check as the touch chip.
  const doorClip =
    door && fr && fr.x !== undefined && fr.z !== undefined ? doorChipClip(fr.x, fr.z, door.state, door.phase) : null;
  const soundRow = !!sound && (sound.consent === "unknown" || sound.consent === "granted");
  if (!debug && !doorClip && !soundRow && !doorStatus && !interactStatus) return null;
  // The PA banner no longer renders here (F1): it moved to the shell
  // (ShellPaBanner in GlbWorld) so spectators in the wide view see
  // platform announcements too, not only walkers.
  return (
    <div className="w-embody-panel w-walk-panel">
      {debug ? (
        <>
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
        </>
      ) : null}
      {!debug && doorClip ? (
        <div className="w-embody-row">
          <button
            type="button"
            onClick={() => {
              door?.request(doorClip);
              bump();
            }}
          >
            Open the Tea House door
          </button>
        </div>
      ) : null}
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
      {debug ? (
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
      ) : doorStatus || interactStatus ? (
        <div className="w-embody-status">{[doorStatus, interactStatus].filter(Boolean).join(" · ")}</div>
      ) : null}
    </div>
  );
}
