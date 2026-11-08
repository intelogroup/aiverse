// comfort.ts — Mobile Phase 4 comfort settings (MOBILE-PLAN.md §5):
// reduced-motion, look sensitivity + invert-Y, volume/layer levels,
// one-time coach marks, and the Android-only haptic tick.
//
// One persisted store (localStorage `aiverse.comfort`) is the source
// of truth: the You sheet's Settings · Comfort section writes it,
// GlbWorld applies volumes to the SoundDirector and look prefs to
// the touch source. Pure helpers take a Storage-like so tests never
// touch a real browser store.

export interface ComfortSettings {
  /** Touch look-drag sensitivity multiplier (0.5–2). */
  lookSensitivity: number;
  /** Flip the touch look-drag's vertical axis. */
  invertY: boolean;
  /** Volume levels 0–1 per layer (master + the director's buses). */
  masterVolume: number;
  musicVolume: number;
  windVolume: number;
  paVolume: number;
}

export const DEFAULT_COMFORT: ComfortSettings = {
  lookSensitivity: 1,
  invertY: false,
  masterVolume: 1,
  musicVolume: 1,
  windVolume: 1,
  paVolume: 1,
};

const KEY = "aiverse.comfort";
const COACH_PREFIX = "aiverse.coach.";

export type CoachMarkId = "stick" | "look" | "longpress";

interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

function realStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadComfort(store: StorageLike | null = realStorage()): ComfortSettings {
  if (!store) return { ...DEFAULT_COMFORT };
  try {
    const raw = store.getItem(KEY);
    if (!raw) return { ...DEFAULT_COMFORT };
    const parsed = JSON.parse(raw) as Partial<ComfortSettings>;
    const num = (v: unknown, dflt: number, min: number, max: number) =>
      typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt;
    return {
      lookSensitivity: num(parsed.lookSensitivity, 1, 0.5, 2),
      invertY: parsed.invertY === true,
      masterVolume: num(parsed.masterVolume, 1, 0, 1),
      musicVolume: num(parsed.musicVolume, 1, 0, 1),
      windVolume: num(parsed.windVolume, 1, 0, 1),
      paVolume: num(parsed.paVolume, 1, 0, 1),
    };
  } catch {
    return { ...DEFAULT_COMFORT };
  }
}

export function coachSeen(id: CoachMarkId, store: StorageLike | null = realStorage()): boolean {
  try {
    return store?.getItem(COACH_PREFIX + id) === "1";
  } catch {
    return false;
  }
}

export function markCoachSeen(id: CoachMarkId, store: StorageLike | null = realStorage()): void {
  try {
    store?.setItem(COACH_PREFIX + id, "1");
  } catch {
    /* private mode: the mark may re-show next session — acceptable */
  }
}

// ── Shared store ───────────────────────────────────────────────────

let snapshot: ComfortSettings | null = null;
const listeners = new Set<() => void>();

export const comfortStore = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  getSnapshot(): ComfortSettings {
    if (snapshot === null) snapshot = loadComfort();
    return snapshot;
  },
  set(patch: Partial<ComfortSettings>): void {
    const next = { ...comfortStore.getSnapshot(), ...patch };
    snapshot = next;
    try {
      realStorage()?.setItem(KEY, JSON.stringify(next));
    } catch {
      /* session-only */
    }
    for (const fn of listeners) fn();
  },
};

// ── Reduced motion ─────────────────────────────────────────────────

let reducedMotion = false;
let motionListenerBound = false;

function bindMotionListener(): void {
  if (motionListenerBound || typeof window === "undefined" || !window.matchMedia) return;
  motionListenerBound = true;
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  reducedMotion = mq.matches;
  mq.addEventListener?.("change", (e) => {
    reducedMotion = e.matches;
  });
}

/** True when the OS asks for reduced motion (iOS Reduce Motion, etc.). */
export function isReducedMotion(): boolean {
  bindMotionListener();
  return reducedMotion;
}

// ── Haptics ────────────────────────────────────────────────────────

/**
 * A 10 ms haptic tick where the platform has one. Android Chrome
 * exposes navigator.vibrate; iOS Safari has NO web haptics API, so
 * this is a deliberate no-op there — feedback on iPhone is visual +
 * sound only, never a promised Taptic.
 */
export function hapticTick(): void {
  try {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(10);
    }
  } catch {
    /* never let a nicety throw */
  }
}

/** Long-press threshold + move tolerance (plan §1 gesture table). */
export const LONG_PRESS_MS = 500;
export const LONG_PRESS_MAX_MOVE_PX = 10;
